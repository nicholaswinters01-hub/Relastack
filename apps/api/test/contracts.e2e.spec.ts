import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DISPATCH_INTERVAL_SECONDS = '0';
process.env.INTEGRATION_TOKEN_KEYS = `1:${Buffer.alloc(32, 43).toString('base64')}`;
process.env.DOCUSIGN_CLIENT_ID = 'test-integration-key';
process.env.DOCUSIGN_CLIENT_SECRET = 'test-secret';
process.env.DOCUSIGN_ENVIRONMENT = 'demo';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocuSignAdapter } from '../src/integrations/docusign.adapter';
import { DispatcherService } from '../src/notifications/dispatcher.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Contracts, sent through a connected DocuSign.
 *
 * DocuSign is never called: a small fake answers as it does, remembering each
 * envelope's status. The parts that carry the design:
 *
 *   - visibility follows the customer; sending needs customer.write there
 *   - only the template's own fields are sent, to the signer it names
 *   - a webhook is only a prompt: the secret address must match, and the
 *     status is read back from DocuSign, moves only forward, and tells the
 *     sender once
 *   - the signed copy is fetched on demand, never stored
 */

const PASSWORD = 'a-sufficiently-long-password';
const BASE = 'https://demo.docusign.net/restapi/v2.1/accounts/acct-123';

interface InjectResult {
  statusCode: number;
  body: string;
  rawPayload: Buffer;
  headers: Record<string, string | string[] | undefined>;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
  organizationId: string;
  userId: string;
}

describe('Contracts (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let dispatcher: DispatcherService;

  let owner: Actor;
  let manager: Actor;
  let northManager: Actor;
  let employee: Actor;
  let rival: Actor;

  let downtownCustomer: string;
  let northsideCustomer: string;

  /** Envelope id -> DocuSign status. */
  const envelopes = new Map<string, string>();
  const sentBodies: Array<Record<string, unknown>> = [];
  const voided: string[] = [];
  let issued = 0;

  const request = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    token?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (response: InjectResult) => JSON.parse(response.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  const fakeDocuSign = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    const reply = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/oauth/token')) {
      issued += 1;
      return reply(200, {
        access_token: `AT-${issued}`,
        refresh_token: `RT-${issued}`,
        expires_in: 28800,
      });
    }
    if (url.endsWith('/oauth/userinfo')) {
      return reply(200, {
        name: 'Owner',
        email: 'owner@example.test',
        accounts: [
          {
            account_id: 'acct-123',
            account_name: 'Pest Co',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          },
        ],
      });
    }
    if (url.startsWith(`${BASE}/templates?`)) {
      return reply(200, {
        envelopeTemplates: [{ templateId: 'tpl-1', name: 'Quarterly Pest Agreement' }],
      });
    }
    if (url === `${BASE}/templates/tpl-1`) {
      return reply(200, { templateId: 'tpl-1', name: 'Quarterly Pest Agreement' });
    }
    if (url === `${BASE}/templates/tpl-1/recipients?include_tabs=true`) {
      return reply(200, {
        signers: [
          {
            roleName: 'Customer',
            tabs: { textTabs: [{ tabLabel: 'Price' }, { tabLabel: 'Service Address' }] },
          },
        ],
      });
    }
    if (url === `${BASE}/envelopes` && method === 'POST') {
      const parsed = JSON.parse(body ?? '{}');
      sentBodies.push(parsed);
      if (String(parsed.templateRoles?.[0]?.email).startsWith('bad')) {
        return reply(400, {
          errorCode: 'INVALID_EMAIL_ADDRESS_FOR_RECIPIENT',
          message: 'The email address for the recipient is invalid.',
        });
      }
      const envelopeId = `env-${sentBodies.length}-abcdef`;
      envelopes.set(envelopeId, 'sent');
      return reply(201, { envelopeId, status: 'sent' });
    }
    const envelope = /\/envelopes\/([^/]+)(\/documents\/combined)?$/.exec(url);
    if (envelope) {
      const id = envelope[1]!;
      if (!envelopes.has(id)) return reply(404, { message: 'ENVELOPE_DOES_NOT_EXIST' });
      if (envelope[2]) {
        return new Response('%PDF-1.4 signed copy', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      if (method === 'PUT') {
        voided.push(id);
        envelopes.set(id, 'voided');
        return reply(200, {});
      }
      const status = envelopes.get(id)!;
      return reply(200, {
        status,
        deliveredDateTime: status === 'sent' ? undefined : '2026-09-28T15:00:00Z',
        completedDateTime: status === 'completed' ? '2026-09-28T16:00:00Z' : undefined,
      });
    }
    return reply(404, {});
  };

  async function register(slug: string, organizationName: string): Promise<Actor> {
    const registered = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: `e2e-contract-${slug}@example.test`, password: PASSWORD, organizationName },
    })) as unknown as InjectResult;
    const userId = json(registered).user.id as string;
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId },
    });
    return {
      token: tokenOf(registered),
      membershipId: membership.id,
      organizationId: membership.organizationId,
      userId,
    };
  }

  async function addPerson(slug: string, roleId: string, locationId: string): Promise<Actor> {
    const throwaway = await register(slug, `Contract Test Throwaway ${slug}`);
    await privileged.organizationMembership.deleteMany({ where: { userId: throwaway.userId } });
    await privileged.organization.deleteMany({
      where: { name: `Contract Test Throwaway ${slug}` },
    });
    const membership = await privileged.organizationMembership.create({
      data: { userId: throwaway.userId, organizationId: owner.organizationId, role: 'MEMBER' },
    });
    const assignment = await privileged.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId,
        scope: 'LOCATION',
        organizationId: owner.organizationId,
      },
    });
    await privileged.membershipRoleLocation.create({
      data: { membershipRoleId: assignment.id, locationId, organizationId: owner.organizationId },
    });
    const login = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `e2e-contract-${slug}@example.test`, password: PASSWORD },
    })) as unknown as InjectResult;
    return {
      token: tokenOf(login),
      membershipId: membership.id,
      organizationId: owner.organizationId,
      userId: throwaway.userId,
    };
  }

  async function connectDocuSign(actor: Actor): Promise<void> {
    const started = await request('POST', '/api/v1/integrations/docusign/connect', actor.token);
    const state = new URL(json(started).url).searchParams.get('state')!;
    const back = await request(
      'GET',
      `/api/v1/integrations/docusign/callback?code=ok&state=${state}`,
      actor.token,
    );
    expect(back.headers.location).toBe('/settings/connected-apps?connected=docusign');
  }

  const send = (actor: Actor, customerId: string, overrides: Record<string, unknown> = {}) =>
    request('POST', '/api/v1/contracts', actor.token, {
      customerId,
      provider: 'docusign',
      templateId: 'tpl-1',
      roleName: 'Customer',
      signerName: 'Dana Diaz',
      signerEmail: 'dana@example.test',
      fields: {
        Price: '$129 per quarter',
        'Service Address': '1 Main St',
        Sneaky: 'not in the template',
      },
      ...overrides,
    });

  /** The secret address DocuSign was given for the last envelope sent. */
  const lastWebhook = () =>
    new URL(String((sentBodies.at(-1)!.eventNotification as { url: string }).url)).pathname;

  const poke = (path: string, envelopeId: string) =>
    request('POST', path.replace(/^\/api\/v1/, '/api/v1'), undefined, {
      event: 'envelope-completed',
      data: { envelopeId },
    });

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-contract-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      "DELETE FROM organizations WHERE name LIKE 'Contract Test%'",
    );
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    app.get(DocuSignAdapter).http = fakeDocuSign as typeof fetch;
    dispatcher = app.get(DispatcherService);
    await cleanUp();

    owner = await register('owner', 'Contract Test Company');
    expect(
      (await request('POST', `/api/v1/modules/${MODULES.CONTRACTS}`, owner.token)).statusCode,
    ).toBe(200);
    const location = async (name: string) =>
      json(
        await request('POST', '/api/v1/locations', owner.token, {
          name,
          timezone: 'America/New_York',
        }),
      ).location.id as string;
    const downtown = await location('Downtown');
    const northside = await location('Northside');

    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, downtown);
    northManager = await addPerson('northmanager', SYSTEM_ROLE_IDS.location_manager, northside);
    employee = await addPerson('employee', SYSTEM_ROLE_IDS.employee, downtown);

    const customer = async (firstName: string, locationId: string) =>
      json(
        await request('POST', '/api/v1/customers', owner.token, {
          type: 'PERSON',
          firstName,
          stage: 'ACTIVE',
          locationId,
          email: `${firstName.toLowerCase()}@example.test`,
        }),
      ).customer.id as string;
    downtownCustomer = await customer('Dana', downtown);
    northsideCustomer = await customer('Nils', northside);

    await connectDocuSign(owner);
    rival = await register('rival', 'Contract Test Rival');
    // The module on, so what is tested is the business boundary, not the switch.
    await request('POST', `/api/v1/modules/${MODULES.CONTRACTS}`, rival.token);
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('templates', () => {
    it('lists the templates in the connected DocuSign', async () => {
      const response = json(await request('GET', '/api/v1/contracts/templates', manager.token));
      expect(response).toEqual({
        connected: true,
        templates: [
          expect.objectContaining({
            provider: 'docusign',
            templateId: 'tpl-1',
            name: 'Quarterly Pest Agreement',
          }),
        ],
      });
    });

    it('reads a template’s signer and fields', async () => {
      const detail = json(
        await request('GET', '/api/v1/contracts/templates/docusign/tpl-1', manager.token),
      );
      expect(detail).toMatchObject({ roles: ['Customer'], fields: ['Price', 'Service Address'] });
    });

    it('says nothing is connected for a business without DocuSign', async () => {
      const response = json(await request('GET', '/api/v1/contracts/templates', rival.token));
      expect(response).toEqual({ connected: false, templates: [] });
    });
  });

  // =========================================================================

  describe('sending', () => {
    it('sends only the template’s own fields, to the signer it names, with a secret webhook', async () => {
      const response = await send(manager, downtownCustomer);
      expect(response.statusCode, response.body).toBe(201);
      expect(json(response).contract).toMatchObject({
        status: 'SENT',
        title: 'Quarterly Pest Agreement',
        signerEmail: 'dana@example.test',
      });

      const sent = sentBodies.at(-1)!;
      expect(sent.templateRoles).toEqual([
        {
          roleName: 'Customer',
          name: 'Dana Diaz',
          email: 'dana@example.test',
          tabs: {
            textTabs: [
              { tabLabel: 'Price', value: '$129 per quarter' },
              { tabLabel: 'Service Address', value: '1 Main St' },
            ],
          },
        },
      ]);
      expect(lastWebhook()).toMatch(
        new RegExp(`^/api/v1/webhooks/docusign/${owner.organizationId}/[A-Za-z0-9_-]{40,}$`),
      );
    });

    it('treats another branch’s customer as not there', async () => {
      expect((await send(manager, northsideCustomer)).statusCode).toBe(404);
    });

    it('does not let someone who cannot edit customers send', async () => {
      expect((await send(employee, downtownCustomer)).statusCode).toBe(403);
    });

    it('refuses someone who can see the customer but edits customers only elsewhere', async () => {
      // A Northside manager who also works at Downtown as an employee: they
      // can see Downtown's customer, and the route lets them in because they
      // edit customers somewhere. Only the per-customer rule stops them.
      const assignment = await privileged.membershipRole.create({
        data: {
          membershipId: northManager.membershipId,
          roleId: SYSTEM_ROLE_IDS.employee,
          scope: 'LOCATION',
          organizationId: owner.organizationId,
        },
      });
      const downtown = (
        await privileged.customer.findUniqueOrThrow({ where: { id: downtownCustomer } })
      ).locationId!;
      await privileged.membershipRoleLocation.create({
        data: {
          membershipRoleId: assignment.id,
          locationId: downtown,
          organizationId: owner.organizationId,
        },
      });
      try {
        expect((await send(northManager, downtownCustomer)).statusCode).toBe(403);
      } finally {
        await privileged.membershipRole.delete({ where: { id: assignment.id } });
      }
    });

    it('refuses a signer the template does not have', async () => {
      const response = await send(manager, downtownCustomer, { roleName: 'Landlord' });
      expect(response.statusCode).toBe(400);
    });

    it('passes on DocuSign’s own reason when it refuses', async () => {
      const response = await send(manager, downtownCustomer, { signerEmail: 'bad@example.test' });
      expect(response.statusCode).toBe(400);
      expect(json(response).message).toContain('email address for the recipient is invalid');
    });

    it('refuses when the module is off', async () => {
      await request('DELETE', `/api/v1/modules/${MODULES.CONTRACTS}`, owner.token);
      const refused = await request('GET', '/api/v1/contracts', owner.token);
      expect(refused.statusCode).toBe(403);
      expect(json(refused).code).toBe('MODULE_NOT_ENABLED');
      await request('POST', `/api/v1/modules/${MODULES.CONTRACTS}`, owner.token);
    });
  });

  // =========================================================================

  describe('status', () => {
    it('moves forward on a genuine webhook, and tells the sender once', async () => {
      const contract = json(await send(manager, downtownCustomer)).contract;
      const envelopeId = [...envelopes.keys()].at(-1)!;
      const hook = lastWebhook();

      envelopes.set(envelopeId, 'completed');
      expect((await poke(hook, envelopeId)).statusCode).toBe(200);
      expect((await poke(hook, envelopeId)).statusCode).toBe(200);

      const after = json(
        await request('GET', `/api/v1/contracts/${contract.id}`, manager.token),
      ).contract;
      expect(after.status).toBe('SIGNED');

      const signedEvents = await privileged.domainEvent.count({
        where: {
          organizationId: owner.organizationId,
          type: 'contract.signed',
          payload: { path: ['contractId'], equals: contract.id },
        },
      });
      expect(signedEvents).toBe(1);

      await dispatcher.drain();
      const inbox = json(
        await request('GET', '/api/v1/notifications', manager.token),
      ).notifications;
      expect(
        inbox.some(
          (n: { title: string }) => n.title === 'Dana Diaz signed' || n.title.endsWith(' signed'),
        ),
      ).toBe(true);
    });

    it('refuses a webhook with the wrong secret, or for another business', async () => {
      await send(manager, downtownCustomer);
      const envelopeId = [...envelopes.keys()].at(-1)!;
      const hook = lastWebhook();
      const secret = hook.split('/').at(-1)!;

      expect((await poke(hook.replace(secret, 'x'.repeat(43)), envelopeId)).statusCode).toBe(404);
      expect(
        (await poke(hook.replace(owner.organizationId, rival.organizationId), envelopeId))
          .statusCode,
      ).toBe(404);
    });

    it('reads the status from DocuSign, never from the webhook, and never goes back', async () => {
      const contract = json(await send(manager, downtownCustomer)).contract;
      const envelopeId = [...envelopes.keys()].at(-1)!;

      // A poke claiming completion while DocuSign still says "sent" changes nothing.
      await poke(lastWebhook(), envelopeId);
      expect(
        json(await request('GET', `/api/v1/contracts/${contract.id}`, manager.token)).contract
          .status,
      ).toBe('SENT');

      envelopes.set(envelopeId, 'delivered');
      const checked = await request(
        'POST',
        `/api/v1/contracts/${contract.id}/check`,
        manager.token,
      );
      expect(json(checked).contract.status).toBe('VIEWED');

      envelopes.set(envelopeId, 'sent');
      const again = await request('POST', `/api/v1/contracts/${contract.id}/check`, manager.token);
      expect(json(again).contract.status).toBe('VIEWED');
    });
  });

  // =========================================================================

  describe('withdrawing and the signed copy', () => {
    it('withdraws an unsigned contract at DocuSign, and refuses a finished one', async () => {
      const contract = json(await send(manager, downtownCustomer)).contract;
      const envelopeId = [...envelopes.keys()].at(-1)!;

      const response = await request(
        'POST',
        `/api/v1/contracts/${contract.id}/void`,
        manager.token,
        {
          reason: 'Sent to the wrong address',
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).contract.status).toBe('VOIDED');
      expect(voided).toContain(envelopeId);

      const again = await request('POST', `/api/v1/contracts/${contract.id}/void`, manager.token, {
        reason: 'Twice',
      });
      expect(again.statusCode).toBe(400);
    });

    it('fetches the signed copy from DocuSign for someone who can see the customer', async () => {
      const contract = json(await send(manager, downtownCustomer)).contract;
      const response = await request(
        'GET',
        `/api/v1/contracts/${contract.id}/document`,
        employee.token,
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.rawPayload.toString()).toContain('%PDF');

      expect(
        (await request('GET', `/api/v1/contracts/${contract.id}/document`, northManager.token))
          .statusCode,
      ).toBe(404);
    });
  });

  // =========================================================================

  describe('visibility', () => {
    it('lists only contracts for customers the reader can see', async () => {
      const mine = json(await request('GET', '/api/v1/contracts', manager.token)).contracts;
      expect(mine.length).toBeGreaterThan(0);
      const theirs = json(await request('GET', '/api/v1/contracts', northManager.token)).contracts;
      expect(theirs).toHaveLength(0);
    });

    it('answers 404 to another business', async () => {
      const contract = json(await send(manager, downtownCustomer)).contract;
      expect(
        (await request('GET', `/api/v1/contracts/${contract.id}`, rival.token)).statusCode,
      ).toBe(404);
    });

    it('keeps a customer who has contracts', async () => {
      const response = await request(
        'DELETE',
        `/api/v1/customers/${downtownCustomer}/permanent`,
        owner.token,
      );
      expect(response.statusCode).toBe(409);
      expect(json(response).message).toContain('contract');
    });
  });

  // =========================================================================

  it('gives a connection made before webhook addresses existed one on first use', async () => {
    await privileged.integrationConnection.updateMany({
      where: { organizationId: owner.organizationId, provider: 'docusign' },
      data: { hookTokenSealed: null, hookTokenHash: null },
    });
    await send(manager, downtownCustomer);
    const envelopeId = [...envelopes.keys()].at(-1)!;
    envelopes.set(envelopeId, 'delivered');
    expect((await poke(lastWebhook(), envelopeId)).statusCode).toBe(200);
  });

  it('keeps the webhook address across a reconnect, so documents already sent still report', async () => {
    const before = await privileged.integrationConnection.findFirstOrThrow({
      where: { organizationId: owner.organizationId, provider: 'docusign' },
    });
    await connectDocuSign(owner);
    const after = await privileged.integrationConnection.findFirstOrThrow({
      where: { organizationId: owner.organizationId, provider: 'docusign' },
    });
    expect(after.hookTokenHash).toBe(before.hookTokenHash);
  });
});
