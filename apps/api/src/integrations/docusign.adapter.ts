import { Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import { SERVER_ENV } from '../config.provider';
import {
  ProviderAuthError,
  ProviderRequestError,
  ProviderUnavailableError,
  type ESignAdapter,
  type IntegrationAdapter,
  type OAuthTokens,
  type ProviderAccount,
  type ProviderConnection,
  type ProviderEnvelopeStatus,
  type ProviderTemplate,
} from './adapter';

const AUTH_HOST = {
  demo: 'https://account-d.docusign.com',
  production: 'https://account.docusign.com',
} as const;

/** Sending envelopes, and a refresh token that lasts as long as it is used. */
const SCOPES = 'signature extended';

type Fetch = typeof fetch;

/**
 * Where an account's API may live. DocuSign names it at connection time; it
 * is checked on every call so a changed row can never point our requests,
 * with a customer's token attached, at some other host.
 */
const DOCUSIGN_API_HOST = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.docusign\.(net|com)$/;

const ENVELOPE_STATUS: Record<string, ProviderEnvelopeStatus['status']> = {
  created: 'SENT',
  sent: 'SENT',
  delivered: 'VIEWED',
  signed: 'SIGNED',
  completed: 'SIGNED',
  declined: 'DECLINED',
  voided: 'VOIDED',
};

const dateOrNull = (value: unknown) =>
  typeof value === 'string' && value !== '' ? new Date(value) : null;

/**
 * DocuSign, by the Authorization Code Grant with PKCE.
 *
 * DocuSign has no endpoint to revoke a grant. Disconnecting deletes our copy,
 * and the owner is told they can also remove RelaStack under Connected Apps
 * in their DocuSign profile.
 */
@Injectable()
export class DocuSignAdapter implements IntegrationAdapter, ESignAdapter {
  readonly key = 'docusign' as const;
  readonly name = 'DocuSign';

  /** Replaced in tests with recorded responses; never live in CI. */
  http: Fetch = (input, init) => fetch(input, init);

  constructor(@Inject(SERVER_ENV) private readonly env: ServerEnv) {}

  configured(): boolean {
    return Boolean(this.env.DOCUSIGN_CLIENT_ID && this.env.DOCUSIGN_CLIENT_SECRET);
  }

  private get host(): string {
    return AUTH_HOST[this.env.DOCUSIGN_ENVIRONMENT];
  }

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      scope: SCOPES,
      client_id: this.env.DOCUSIGN_CLIENT_ID ?? '',
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.host}/oauth/auth?${params}`;
  }

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async account(accessToken: string): Promise<ProviderAccount> {
    const response = await this.call(`${this.host}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as {
      email?: string;
      name?: string;
      accounts?: Array<{
        account_id: string;
        account_name?: string;
        base_uri?: string;
        is_default?: boolean;
      }>;
    };
    const account = body.accounts?.find((entry) => entry.is_default) ?? body.accounts?.[0];
    if (!account) throw new ProviderAuthError('That DocuSign login has no account to send from');

    return {
      accountId: account.account_id,
      accountName: account.account_name ?? body.name ?? null,
      email: body.email ?? null,
      baseUri: account.base_uri ?? null,
    };
  }

  // --- E-signature ---------------------------------------------------------

  async listTemplates(connection: ProviderConnection): Promise<ProviderTemplate[]> {
    const body = (await this.rest(connection, 'GET', '/templates?count=100&order_by=name')) as {
      envelopeTemplates?: Array<{ templateId: string; name?: string; description?: string }>;
    };
    return (body.envelopeTemplates ?? []).map((template) => ({
      templateId: template.templateId,
      name: template.name || 'Untitled template',
      description: template.description || null,
    }));
  }

  async templateDetail(connection: ProviderConnection, templateId: string) {
    const id = encodeURIComponent(templateId);
    const [template, recipients] = (await Promise.all([
      this.rest(connection, 'GET', `/templates/${id}`),
      this.rest(connection, 'GET', `/templates/${id}/recipients?include_tabs=true`),
    ])) as [
      { templateId: string; name?: string; description?: string },
      {
        signers?: Array<{ roleName?: string; tabs?: { textTabs?: Array<{ tabLabel?: string }> } }>;
      },
    ];
    const signers = recipients.signers ?? [];
    return {
      templateId: template.templateId,
      name: template.name || 'Untitled template',
      description: template.description || null,
      roles: signers.map((signer) => signer.roleName).filter((role): role is string => !!role),
      fields: [
        ...new Set(
          signers.flatMap((signer) =>
            (signer.tabs?.textTabs ?? [])
              .map((tab) => tab.tabLabel)
              .filter((label): label is string => !!label),
          ),
        ),
      ],
    };
  }

  async send(
    connection: ProviderConnection,
    input: {
      templateId: string;
      roleName: string;
      signerName: string;
      signerEmail: string;
      subject: string;
      fields: Record<string, string>;
      webhookUrl: string | null;
    },
  ): Promise<{ envelopeId: string }> {
    const textTabs = Object.entries(input.fields).map(([tabLabel, value]) => ({ tabLabel, value }));
    const body = (await this.rest(connection, 'POST', '/envelopes', {
      templateId: input.templateId,
      status: 'sent',
      emailSubject: input.subject,
      templateRoles: [
        {
          roleName: input.roleName,
          name: input.signerName,
          email: input.signerEmail,
          ...(textTabs.length > 0 ? { tabs: { textTabs } } : {}),
        },
      ],
      ...(input.webhookUrl
        ? {
            // Per-envelope Connect: DocuSign reports progress to this
            // envelope's own secret address, with no account setup.
            eventNotification: {
              url: input.webhookUrl,
              requireAcknowledgment: 'true',
              includeDocuments: 'false',
              envelopeEvents: ['sent', 'delivered', 'completed', 'declined', 'voided'].map(
                (envelopeEventStatusCode) => ({ envelopeEventStatusCode }),
              ),
              eventData: { version: 'restv2.1', format: 'json' },
            },
          }
        : {}),
    })) as { envelopeId?: string };
    if (!body.envelopeId) throw new ProviderUnavailableError('DocuSign did not say what it sent');
    return { envelopeId: body.envelopeId };
  }

  async status(
    connection: ProviderConnection,
    envelopeId: string,
  ): Promise<ProviderEnvelopeStatus> {
    const body = (await this.rest(
      connection,
      'GET',
      `/envelopes/${encodeURIComponent(envelopeId)}`,
    )) as Record<string, unknown>;
    return {
      status: ENVELOPE_STATUS[String(body.status)] ?? 'SENT',
      viewedAt: dateOrNull(body.deliveredDateTime),
      completedAt: dateOrNull(body.completedDateTime),
      declinedAt: dateOrNull(body.declinedDateTime),
      voidedAt: dateOrNull(body.voidedDateTime),
    };
  }

  async document(connection: ProviderConnection, envelopeId: string): Promise<Buffer> {
    const response = await this.restRaw(
      connection,
      'GET',
      `/envelopes/${encodeURIComponent(envelopeId)}/documents/combined`,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async voidEnvelope(
    connection: ProviderConnection,
    envelopeId: string,
    reason: string,
  ): Promise<void> {
    await this.rest(connection, 'PUT', `/envelopes/${encodeURIComponent(envelopeId)}`, {
      status: 'voided',
      voidedReason: reason,
    });
  }

  private async rest(
    connection: ProviderConnection,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.restRaw(connection, method, path, body);
    return response.json();
  }

  private async restRaw(
    connection: ProviderConnection,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const host = connection.baseUri ?? '';
    if (!DOCUSIGN_API_HOST.test(host)) {
      throw new ProviderRequestError('This DocuSign connection needs reconnecting');
    }
    let response: Response;
    try {
      response = await this.http(
        `${host}/restapi/v2.1/accounts/${encodeURIComponent(connection.accountId)}${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${connection.accessToken}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw new ProviderUnavailableError('DocuSign could not be reached');
    }
    if (response.ok) return response;
    if (response.status === 401) throw new ProviderAuthError('DocuSign refused the connection');
    if (response.status === 400 || response.status === 404) {
      // DocuSign explains itself ("INVALID_EMAIL_ADDRESS_FOR_RECIPIENT"); pass
      // the explanation on, never the request.
      const detail = (await response.json().catch(() => ({}))) as { message?: string };
      throw new ProviderRequestError(`DocuSign: ${detail.message ?? 'the request was refused'}`);
    }
    throw new ProviderUnavailableError(`DocuSign answered ${response.status}`);
  }

  private async token(form: Record<string, string>): Promise<OAuthTokens> {
    const basic = Buffer.from(
      `${this.env.DOCUSIGN_CLIENT_ID ?? ''}:${this.env.DOCUSIGN_CLIENT_SECRET ?? ''}`,
    ).toString('base64');
    const response = await this.call(`${this.host}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token || !body.refresh_token || !body.expires_in) {
      throw new ProviderUnavailableError('DocuSign answered without a usable grant');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    };
  }

  /**
   * One request. A refused grant (400 invalid_grant, 401) means reconnect; an
   * outage means try later. Neither message carries a token.
   */
  private async call(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.http(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ProviderUnavailableError('DocuSign could not be reached');
    }
    if (response.ok) return response;
    if (response.status === 400 || response.status === 401) {
      throw new ProviderAuthError('DocuSign refused the connection');
    }
    throw new ProviderUnavailableError(`DocuSign answered ${response.status}`);
  }
}
