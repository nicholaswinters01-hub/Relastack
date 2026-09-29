import type { IntegrationProviderKey } from '@platform/shared';

/** What a provider grants: short-lived access, and the means to renew it. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** Which account at the provider a grant belongs to. */
export interface ProviderAccount {
  accountId: string;
  accountName: string | null;
  email: string | null;
  /** Where that account's API lives, when the provider has more than one (DocuSign). */
  baseUri: string | null;
}

/** The provider refused the grant: revoked, expired, or never valid. Reconnect. */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

/** The provider could not be reached or answered with an error of its own. Try again later. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * One provider's side of the connection layer. The layer does the rest once:
 * state, sealing, refresh, audit, disconnect. A new provider is a new adapter.
 */
export interface IntegrationAdapter {
  readonly key: IntegrationProviderKey;
  readonly name: string;
  /** RelaStack has credentials for this provider. */
  configured(): boolean;
  /** PKCE where the provider supports it; the layer always sends a challenge. */
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  account(accessToken: string): Promise<ProviderAccount>;
  /** Ask the provider to cancel the grant, where it offers that. */
  revoke?(tokens: { accessToken: string; refreshToken: string }): Promise<void>;
}

// --- E-signature ---------------------------------------------------------------

/** The provider refused the request itself (a bad address, a missing role). Say why. */
export class ProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

/** What an e-signature call needs to reach the right account. */
export interface ProviderConnection {
  accessToken: string;
  accountId: string;
  baseUri: string | null;
}

export interface ProviderTemplate {
  templateId: string;
  name: string;
  description: string | null;
}

export interface ProviderEnvelopeStatus {
  status: 'SENT' | 'VIEWED' | 'SIGNED' | 'DECLINED' | 'VOIDED';
  viewedAt: Date | null;
  completedAt: Date | null;
  declinedAt: Date | null;
  voidedAt: Date | null;
}

/** An adapter that can send documents for signature. */
export interface ESignAdapter {
  listTemplates(connection: ProviderConnection): Promise<ProviderTemplate[]>;
  templateDetail(
    connection: ProviderConnection,
    templateId: string,
  ): Promise<ProviderTemplate & { roles: string[]; fields: string[] }>;
  send(
    connection: ProviderConnection,
    input: {
      templateId: string;
      roleName: string;
      signerName: string;
      signerEmail: string;
      subject: string;
      fields: Record<string, string>;
      /** Where the provider reports progress; null to rely on checking. */
      webhookUrl: string | null;
    },
  ): Promise<{ envelopeId: string }>;
  status(connection: ProviderConnection, envelopeId: string): Promise<ProviderEnvelopeStatus>;
  document(connection: ProviderConnection, envelopeId: string): Promise<Buffer>;
  voidEnvelope(connection: ProviderConnection, envelopeId: string, reason: string): Promise<void>;
}

export const isESignAdapter = (adapter: unknown): adapter is IntegrationAdapter & ESignAdapter =>
  typeof (adapter as Partial<ESignAdapter> | null)?.send === 'function' &&
  typeof (adapter as Partial<ESignAdapter> | null)?.listTemplates === 'function';
