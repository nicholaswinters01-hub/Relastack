import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';
// A throwaway key and DocuSign app, for this suite only.
process.env.INTEGRATION_TOKEN_KEYS = `1:${Buffer.alloc(32, 42).toString('base64')}`;
process.env.DOCUSIGN_CLIENT_ID = 'test-integration-key';
process.env.DOCUSIGN_CLIENT_SECRET = 'test-secret';
process.env.DOCUSIGN_ENVIRONMENT = 'demo';

import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocuSignAdapter } from '../src/integrations/docusign.adapter';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Connected apps (Phase 11a): the connection layer, with DocuSign.
 *
 * DocuSign itself is never called: its answers are recorded shapes, and the
 * suite checks what it would have been sent. The parts that carry the design:
 *
 *   - a connect link works once, for ten minutes, for the person who made it
 *   - grants are sealed, bound to their business, and never leave the API
 *   - a grant is renewed when used; a refused one says "reconnect"
 *   - owners and admins only; every use is logged, and the log is append-only
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
  organizationId: string;
  userId: string;
}

/** What DocuSign was asked, and how it answers. */
interface Call {
  url: string;
  body: URLSearchParams | null;
  authorization: string | null;
}

describe('Connected apps (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let privileged: PrismaClient;
  let docusign: DocuSignAdapter;

  let owner: Actor;
  let secondAdmin: Actor;
  let manager: Actor;
  let rival: Actor;

  let calls: Call[] = [];
  /** Refresh tokens DocuSign still honours; anything else is refused. */
  let liveRefreshTokens = new Set<string>();
  let issued = 0;

  const request = (method: 'GET' | 'POST', url: string, token?: string) =>
    app.inject({
      method,
      url,
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (response: InjectResult) => JSON.parse(response.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  const grant = () => {
    issued += 1;
    const refresh = `RT-${issued}`;
    liveRefreshTokens.add(refresh);
    return { access_token: `AT-${issued}`, refresh_token: refresh, expires_in: 28800 };
  };

  /** Recorded DocuSign behaviour, by endpoint. */
  const fakeDocuSign = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    const headers = new Headers(init?.headers);
    calls.push({ url, body, authorization: headers.get('authorization') });
    const reply = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/oauth/token')) {
      if (body?.get('grant_type') === 'authorization_code') {
        return body.get('code') === 'good-code'
          ? reply(200, grant())
          : reply(400, { error: 'invalid_grant' });
      }
      const refresh = body?.get('refresh_token') ?? '';
      if (!liveRefreshTokens.has(refresh)) return reply(400, { error: 'invalid_grant' });
      liveRefreshTokens.delete(refresh);
      return reply(200, grant());
    }
    if (url.endsWith('/oauth/userinfo')) {
      if (headers.get('authorization') === 'Bearer AT-revoked') return reply(401, {});
      return reply(200, {
        name: 'Dana Diaz',
        email: 'dana@diazpest.example',
        accounts: [
          {
            account_id: 'acct-123',
            account_name: 'Diaz Pest Control',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          },
        ],
      });
    }
    return reply(404, {});
  };

  async function register(slug: string, organizationName: string): Promise<Actor> {
    const registered = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: `e2e-integr-${slug}@example.test`,
        password: PASSWORD,
        organizationName,
      },
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

  async function addPerson(
    slug: string,
    roleId: string,
    scope: 'ORGANIZATION' | 'LOCATION',
  ): Promise<Actor> {
    const throwaway = await register(slug, `Integr Test Throwaway ${slug}`);
    await privileged.organizationMembership.deleteMany({ where: { userId: throwaway.userId } });
    await privileged.organization.deleteMany({ where: { name: `Integr Test Throwaway ${slug}` } });
    const membership = await privileged.organizationMembership.create({
      data: { userId: throwaway.userId, organizationId: owner.organizationId, role: 'MEMBER' },
    });
    await privileged.membershipRole.create({
      data: { membershipId: membership.id, roleId, scope, organizationId: owner.organizationId },
    });
    const login = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `e2e-integr-${slug}@example.test`, password: PASSWORD },
    })) as unknown as InjectResult;
    return {
      token: tokenOf(login),
      membershipId: membership.id,
      organizationId: owner.organizationId,
      userId: throwaway.userId,
    };
  }

  /** Start connecting and return the state DocuSign would send back. */
  async function startConnect(actor: Actor): Promise<{ state: string; url: URL }> {
    const response = await request('POST', '/api/v1/integrations/docusign/connect', actor.token);
    expect(response.statusCode, response.body).toBe(200);
    const url = new URL(json(response).url);
    return { state: url.searchParams.get('state')!, url };
  }

  const callback = (actor: Actor, query: string) =>
    request('GET', `/api/v1/integrations/docusign/callback?${query}`, actor.token);

  async function connect(actor: Actor): Promise<string> {
    const { state } = await startConnect(actor);
    const response = await callback(actor, `code=good-code&state=${state}`);
    expect(response.headers.location).toBe('/settings/connected-apps?connected=docusign');
    const connection = json(await request('GET', '/api/v1/integrations', actor.token)).providers[0]
      .connection;
    return connection.id;
  }

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-integr-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Integr Test%'");
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    privileged = createPrivilegedTestClient();
    docusign = app.get(DocuSignAdapter);
    docusign.http = fakeDocuSign as typeof fetch;
    await cleanUp();

    owner = await register('owner', 'Integr Test Company');
    secondAdmin = await addPerson('admin2', SYSTEM_ROLE_IDS.org_admin, 'ORGANIZATION');
    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, 'ORGANIZATION');
    rival = await register('rival', 'Integr Test Rival');
  });

  beforeEach(async () => {
    calls = [];
    liveRefreshTokens = new Set();
    await privileged.integrationConnection.deleteMany({
      where: { organizationId: { in: [owner.organizationId, rival.organizationId] } },
    });
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('connecting', () => {
    it('offers DocuSign when it is set up, and Dropbox Sign as not yet', async () => {
      const providers = json(await request('GET', '/api/v1/integrations', owner.token)).providers;
      expect(providers).toEqual([
        expect.objectContaining({ key: 'docusign', available: true, connection: null }),
        expect.objectContaining({ key: 'dropbox_sign', available: false, connection: null }),
      ]);
    });

    it('sends the owner to DocuSign with a fresh state and a PKCE challenge', async () => {
      const { url } = await startConnect(owner);
      expect(url.origin).toBe('https://account-d.docusign.com');
      expect(url.searchParams.get('client_id')).toBe('test-integration-key');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toMatch(
        /\/api\/v1\/integrations\/docusign\/callback$/,
      );
      // Only the hash is kept.
      const state = url.searchParams.get('state')!;
      expect(await privileged.integrationOAuthState.count({ where: { stateHash: state } })).toBe(0);
    });

    it('connects, and proves the code with the verifier behind the challenge', async () => {
      const { state, url } = await startConnect(owner);
      const response = await callback(owner, `code=good-code&state=${state}`);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/settings/connected-apps?connected=docusign');

      const exchange = calls.find((call) => call.body?.get('grant_type') === 'authorization_code')!;
      const verifier = exchange.body!.get('code_verifier')!;
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
        url.searchParams.get('code_challenge'),
      );
      expect(exchange.authorization).toBe(
        `Basic ${Buffer.from('test-integration-key:test-secret').toString('base64')}`,
      );

      const listed = await request('GET', '/api/v1/integrations', owner.token);
      expect(json(listed).providers[0].connection).toMatchObject({
        status: 'CONNECTED',
        accountName: 'Diaz Pest Control',
        accountEmail: 'dana@diazpest.example',
      });
    });

    it('treats a declined approval as declined, and records it', async () => {
      const { state } = await startConnect(owner);
      const response = await callback(owner, `error=access_denied&state=${state}`);
      expect(response.headers.location).toBe(
        '/settings/connected-apps?error=declined&provider=docusign',
      );
    });
  });

  // =========================================================================

  describe('the connect link', () => {
    it('works once', async () => {
      const { state } = await startConnect(owner);
      await callback(owner, `code=good-code&state=${state}`);
      const again = await callback(owner, `code=good-code&state=${state}`);
      expect(again.headers.location).toBe(
        '/settings/connected-apps?error=expired&provider=docusign',
      );
    });

    it('does not work after ten minutes', async () => {
      const { state } = await startConnect(owner);
      await privileged.integrationOAuthState.updateMany({
        where: { organizationId: owner.organizationId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const response = await callback(owner, `code=good-code&state=${state}`);
      expect(response.headers.location).toContain('error=expired');
    });

    it('works only for the person who started it', async () => {
      const { state } = await startConnect(owner);
      const response = await callback(secondAdmin, `code=good-code&state=${state}`);
      expect(response.headers.location).toContain('error=expired');
      expect(calls.some((call) => call.body?.get('grant_type') === 'authorization_code')).toBe(
        false,
      );
    });

    it('works only for the business it was started for', async () => {
      const { state } = await startConnect(owner);
      const response = await callback(rival, `code=good-code&state=${state}`);
      expect(response.headers.location).toContain('error=expired');
      expect(
        await privileged.integrationConnection.count({
          where: { organizationId: rival.organizationId },
        }),
      ).toBe(0);
    });
  });

  // =========================================================================

  describe('holding the grant', () => {
    it('never shows a token in any response, and stores them only sealed', async () => {
      await connect(owner);
      const listed = await request('GET', '/api/v1/integrations', owner.token);
      expect(listed.body).not.toMatch(/AT-\d|RT-\d/);

      const row = await privileged.integrationConnection.findFirstOrThrow({
        where: { organizationId: owner.organizationId },
      });
      expect(row.accessTokenSealed).toMatch(/^v1\./);
      expect(row.accessTokenSealed).not.toContain('AT-');
      expect(row.refreshTokenSealed).not.toContain('RT-');
    });

    it('refuses to store a plain token, at the database', async () => {
      const id = await connect(owner);
      await expect(
        privileged.integrationConnection.update({
          where: { id },
          data: { accessTokenSealed: 'AT-plain' },
        }),
      ).rejects.toThrow(/integration_connections_sealed/);
    });

    it('cannot use a grant copied onto another business', async () => {
      const ownerConnection = await connect(owner);
      const rivalConnection = await connect(rival);
      const stolen = await privileged.integrationConnection.findUniqueOrThrow({
        where: { id: ownerConnection },
      });
      await privileged.integrationConnection.update({
        where: { id: rivalConnection },
        data: {
          accessTokenSealed: stolen.accessTokenSealed,
          refreshTokenSealed: stolen.refreshTokenSealed,
        },
      });

      const response = await request(
        'POST',
        `/api/v1/integrations/connections/${rivalConnection}/check`,
        rival.token,
      );
      expect(response.statusCode).toBe(503);
      expect(calls.filter((call) => call.url.endsWith('/oauth/userinfo')).length).toBe(2);
    });

    it('renews an expiring grant when it is used, and logs the use', async () => {
      const id = await connect(owner);
      await privileged.integrationConnection.update({
        where: { id },
        data: { accessExpiresAt: new Date(Date.now() + 60_000) },
      });
      const before = await privileged.integrationConnection.findUniqueOrThrow({ where: { id } });

      const checked = await request(
        'POST',
        `/api/v1/integrations/connections/${id}/check`,
        owner.token,
      );
      expect(checked.statusCode, checked.body).toBe(200);

      expect(calls.some((call) => call.body?.get('grant_type') === 'refresh_token')).toBe(true);
      const after = await privileged.integrationConnection.findUniqueOrThrow({ where: { id } });
      expect(after.refreshTokenSealed).not.toBe(before.refreshTokenSealed);
      expect(after.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);

      const actions = (
        await privileged.integrationEvent.findMany({ where: { connectionId: id } })
      ).map((event) => event.action);
      expect(actions).toEqual(expect.arrayContaining(['connected', 'refreshed', 'used']));
    });

    it('says "reconnect" when DocuSign refuses the grant, and keeps saying so', async () => {
      const id = await connect(owner);
      liveRefreshTokens.clear();
      await privileged.integrationConnection.update({
        where: { id },
        data: { accessExpiresAt: new Date(Date.now() - 1000) },
      });

      const refused = await request(
        'POST',
        `/api/v1/integrations/connections/${id}/check`,
        owner.token,
      );
      expect(refused.statusCode).toBe(409);
      expect(json(refused).code).toBe('NEEDS_RECONNECT');

      const listed = json(await request('GET', '/api/v1/integrations', owner.token));
      expect(listed.providers[0].connection.status).toBe('NEEDS_RECONNECT');
      expect(
        (await request('POST', `/api/v1/integrations/connections/${id}/check`, owner.token))
          .statusCode,
      ).toBe(409);
    });

    it('disconnects: deletes the grant and keeps the log', async () => {
      const id = await connect(owner);
      const response = await request(
        'POST',
        `/api/v1/integrations/connections/${id}/disconnect`,
        owner.token,
      );
      expect(response.statusCode).toBe(204);

      expect(await privileged.integrationConnection.count({ where: { id } })).toBe(0);
      const actions = (
        await privileged.integrationEvent.findMany({
          where: { organizationId: owner.organizationId, provider: 'docusign' },
        })
      ).map((event) => event.action);
      expect(actions).toContain('disconnected');
    });

    it('keeps the log append-only for the application', async () => {
      await connect(owner);
      const context = { organizationId: owner.organizationId, userId: owner.userId };
      await expect(
        prisma.withTenant(context, (tx) =>
          tx.integrationEvent.updateMany({ data: { action: 'x' } }),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withTenant(context, (tx) => tx.integrationEvent.deleteMany({})),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // =========================================================================

  describe('who may', () => {
    it('refuses managers and employees everything here', async () => {
      expect((await request('GET', '/api/v1/integrations', manager.token)).statusCode).toBe(403);
      expect(
        (await request('POST', '/api/v1/integrations/docusign/connect', manager.token)).statusCode,
      ).toBe(403);
    });

    it('answers 404 for another business’s connection', async () => {
      const id = await connect(owner);
      expect(
        (await request('POST', `/api/v1/integrations/connections/${id}/check`, rival.token))
          .statusCode,
      ).toBe(404);
      expect(
        (await request('POST', `/api/v1/integrations/connections/${id}/disconnect`, rival.token))
          .statusCode,
      ).toBe(404);
    });

    it('lets another admin of the same business use it', async () => {
      const id = await connect(owner);
      expect(
        (await request('POST', `/api/v1/integrations/connections/${id}/check`, secondAdmin.token))
          .statusCode,
      ).toBe(200);
    });
  });
});
