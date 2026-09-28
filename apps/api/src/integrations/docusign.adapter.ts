import { Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import { SERVER_ENV } from '../config.provider';
import {
  ProviderAuthError,
  ProviderUnavailableError,
  type IntegrationAdapter,
  type OAuthTokens,
  type ProviderAccount,
} from './adapter';

const AUTH_HOST = {
  demo: 'https://account-d.docusign.com',
  production: 'https://account.docusign.com',
} as const;

/** Sending envelopes, and a refresh token that lasts as long as it is used. */
const SCOPES = 'signature extended';

type Fetch = typeof fetch;

/**
 * DocuSign, by the Authorization Code Grant with PKCE.
 *
 * DocuSign has no endpoint to revoke a grant. Disconnecting deletes our copy,
 * and the owner is told they can also remove RelaStack under Connected Apps
 * in their DocuSign profile.
 */
@Injectable()
export class DocuSignAdapter implements IntegrationAdapter {
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
