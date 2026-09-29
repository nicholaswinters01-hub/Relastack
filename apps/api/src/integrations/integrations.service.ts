import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import type { TenantContext, TransactionClient } from '@platform/db';
import {
  INTEGRATION_PROVIDERS,
  type IntegrationConnection,
  type IntegrationProviderKey,
  type IntegrationsResponse,
  type OAuthCallbackQuery,
} from '@platform/shared';
import { createHash, randomBytes } from 'node:crypto';
import { SERVER_ENV } from '../config.provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProviderAuthError,
  ProviderRequestError,
  ProviderUnavailableError,
  isESignAdapter,
  type ESignAdapter,
  type IntegrationAdapter,
  type OAuthTokens,
} from './adapter';
import { TokenVault, VaultError } from './token-vault';

export const INTEGRATION_ADAPTERS = Symbol('INTEGRATION_ADAPTERS');

const STATE_MINUTES = 10;
/** Renew a grant this close to expiry rather than let a call fail halfway. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const EVENT_LIMIT = 20;

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');

export type ConnectionRow = NonNullable<
  Awaited<ReturnType<TransactionClient['integrationConnection']['findFirst']>>
>;

/**
 * Connected apps: the one place that holds a business's grants to act in
 * other services (ADR 0004: one connection layer, several adapters).
 *
 *   - "Connect" starts with a random state, kept only as a hash, single use,
 *     ten minutes, bound to the business and the person who clicked, and a
 *     PKCE verifier sealed alongside it.
 *   - Grants are sealed before they are stored, each bound to its business
 *     and provider, and never leave this service.
 *   - A grant is renewed when used, under a lock, so two requests never both
 *     spend the same refresh token. A refused grant marks the connection
 *     "needs reconnecting" and says so, rather than failing silently.
 *   - Every connect, refresh, use, failure and disconnect is logged.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly adapters: ReadonlyMap<string, IntegrationAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: TokenVault,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
    @Inject(INTEGRATION_ADAPTERS) adapters: IntegrationAdapter[],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.key, adapter]));
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(context: TenantContext): Promise<IntegrationsResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const [connections, events] = await Promise.all([
        tx.integrationConnection.findMany(),
        tx.integrationEvent.findMany({ orderBy: { createdAt: 'desc' }, take: EVENT_LIMIT }),
      ]);

      return {
        providers: INTEGRATION_PROVIDERS.map((provider) => {
          const connection = connections.find((row) => row.provider === provider.key);
          return {
            key: provider.key,
            name: provider.name,
            description: provider.description,
            available: this.available(provider.key),
            connection: connection ? this.toConnection(connection) : null,
          };
        }),
        events: events.map((event) => ({
          id: event.id,
          provider: event.provider,
          action: event.action,
          detail: event.detail,
          actorName: event.actorName,
          createdAt: event.createdAt.toISOString(),
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Connecting
  // -------------------------------------------------------------------------

  /** Where to send the owner to approve. */
  async startConnect(context: TenantContext, provider: IntegrationProviderKey): Promise<string> {
    const adapter = this.adapterFor(provider);
    const state = random();
    const verifier = random();
    const stateHash = sha256(state);

    await this.prisma.withTenant(context, async (tx) => {
      // Expired attempts go as new ones are made; nothing reads them.
      await tx.integrationOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await tx.integrationOAuthState.create({
        data: {
          organizationId: context.organizationId,
          provider,
          stateHash,
          codeVerifierSealed: this.vault.seal(
            verifier,
            this.binding(context, provider, `pkce:${stateHash}`),
          ),
          userId: context.userId,
          expiresAt: new Date(Date.now() + STATE_MINUTES * 60_000),
        },
      });
    });

    return adapter.authorizeUrl({
      state,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri: this.redirectUri(provider),
    });
  }

  /**
   * The provider sent the owner back. Returns where the browser goes next:
   * the settings page, saying whether it worked.
   */
  async completeConnect(
    context: TenantContext,
    membershipId: string,
    provider: IntegrationProviderKey,
    query: OAuthCallbackQuery,
  ): Promise<string> {
    const done = (outcome: string) => `/settings/connected-apps?${outcome}`;
    const adapter = this.adapterFor(provider);

    if (query.error || !query.code || !query.state) {
      await this.log(context, membershipId, null, provider, 'declined', query.error ?? null);
      return done(`error=declined&provider=${provider}`);
    }

    // Spent before it is used, in its own transaction: a state works once,
    // even if exchanging the code then fails.
    const stateHash = sha256(query.state);
    const verifier = await this.prisma.withTenant(context, async (tx) => {
      const row = await tx.integrationOAuthState.findUnique({ where: { stateHash } });
      if (!row) return null;
      await tx.integrationOAuthState.delete({ where: { id: row.id } });
      const valid =
        row.provider === provider && row.userId === context.userId && row.expiresAt > new Date();
      return valid
        ? this.vault.open(
            row.codeVerifierSealed,
            this.binding(context, provider, `pkce:${stateHash}`),
          )
        : null;
    });
    if (!verifier) {
      await this.log(
        context,
        membershipId,
        null,
        provider,
        'failed',
        'The connect link was not valid',
      );
      return done(`error=expired&provider=${provider}`);
    }

    let tokens: OAuthTokens;
    let account;
    try {
      tokens = await adapter.exchangeCode({
        code: query.code,
        codeVerifier: verifier,
        redirectUri: this.redirectUri(provider),
      });
      account = await adapter.account(tokens.accessToken);
    } catch (error) {
      const reason = error instanceof ProviderAuthError ? 'refused' : 'unavailable';
      await this.log(
        context,
        membershipId,
        null,
        provider,
        'failed',
        `${adapter.name} ${reason} the connection`,
      );
      return done(`error=${reason}&provider=${provider}`);
    }

    await this.prisma.withTenant(context, async (tx) => {
      const actor = await this.actorName(tx, membershipId);
      const sealed = {
        accessTokenSealed: this.vault.seal(
          tokens.accessToken,
          this.binding(context, provider, 'access'),
        ),
        refreshTokenSealed: this.vault.seal(
          tokens.refreshToken,
          this.binding(context, provider, 'refresh'),
        ),
        accessExpiresAt: tokens.expiresAt,
      };
      const row = await tx.integrationConnection.upsert({
        where: { organizationId_provider: { organizationId: context.organizationId, provider } },
        create: {
          organizationId: context.organizationId,
          provider,
          accountId: account.accountId,
          accountName: account.accountName,
          accountEmail: account.email,
          baseUri: account.baseUri,
          connectedById: membershipId,
          connectedByName: actor,
          ...sealed,
        },
        update: {
          status: 'CONNECTED',
          accountId: account.accountId,
          accountName: account.accountName,
          accountEmail: account.email,
          baseUri: account.baseUri,
          connectedById: membershipId,
          connectedByName: actor,
          connectedAt: new Date(),
          ...sealed,
        },
      });
      if (!row.hookTokenHash) {
        const hook = random();
        await tx.integrationConnection.update({
          where: { id: row.id },
          data: {
            hookTokenSealed: this.vault.seal(hook, this.binding(context, provider, 'hook')),
            hookTokenHash: sha256(hook),
          },
        });
      }
      await tx.integrationEvent.create({
        data: {
          organizationId: context.organizationId,
          connectionId: row.id,
          provider,
          action: 'connected',
          detail: account.accountName ?? account.email,
          actorId: membershipId,
          actorName: actor,
        },
      });
    });

    return done(`connected=${provider}`);
  }

  /**
   * Stop acting in the account. The provider is asked to cancel the grant
   * where it can; our copy is deleted either way.
   */
  async disconnect(
    context: TenantContext,
    membershipId: string,
    connectionId: string,
  ): Promise<void> {
    const row = await this.prisma.withTenant(context, (tx) =>
      tx.integrationConnection.findUnique({ where: { id: connectionId } }),
    );
    if (!row) throw new NotFoundException('That connection does not exist');

    const adapter = this.adapters.get(row.provider);
    if (adapter?.revoke) {
      try {
        await adapter.revoke(this.openTokens(context, row));
      } catch (error) {
        this.logger.warn(
          `Revoking ${row.provider} for ${context.organizationId} failed: ${String(error)}`,
        );
      }
    }

    await this.prisma.withTenant(context, async (tx) => {
      const actor = await this.actorName(tx, membershipId);
      await tx.integrationEvent.create({
        data: {
          organizationId: context.organizationId,
          connectionId: row.id,
          provider: row.provider,
          action: 'disconnected',
          detail: row.accountName ?? row.accountEmail,
          actorId: membershipId,
          actorName: actor,
        },
      });
      await tx.integrationConnection.delete({ where: { id: row.id } });
    });
  }

  /** Prove the connection still works: ask the provider which account it is. */
  async check(
    context: TenantContext,
    membershipId: string,
    connectionId: string,
  ): Promise<IntegrationConnection> {
    await this.withAccessToken(
      context,
      membershipId,
      connectionId,
      'Checked the connection',
      async (token, row) => {
        const account = await this.adapterFor(row.provider as IntegrationProviderKey).account(
          token,
        );
        await this.prisma.withTenant(context, (tx) =>
          tx.integrationConnection.update({
            where: { id: row.id },
            data: {
              accountName: account.accountName,
              accountEmail: account.email,
              baseUri: account.baseUri,
            },
          }),
        );
      },
    );
    const row = await this.prisma.withTenant(context, (tx) =>
      tx.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    return this.toConnection(row);
  }

  // -------------------------------------------------------------------------
  // Using a grant
  // -------------------------------------------------------------------------

  /**
   * Run `work` with a live access token for a connection, and log what for.
   *
   * The grant is renewed first when it is close to expiring, under a lock on
   * the connection, so concurrent requests never both spend one refresh
   * token. A refused grant marks the connection "needs reconnecting", which
   * is kept even though the request then fails (409 NEEDS_RECONNECT).
   */
  async withAccessToken<T>(
    context: TenantContext,
    membershipId: string | null,
    connectionId: string,
    purpose: string,
    work: (accessToken: string, connection: ConnectionRow) => Promise<T>,
  ): Promise<T> {
    const prepared = await this.prisma.withTenant(context, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`integration:${connectionId}`}, 0))`;
      const row = await tx.integrationConnection.findUnique({ where: { id: connectionId } });
      if (!row) throw new NotFoundException('That connection does not exist');
      if (row.status === 'NEEDS_RECONNECT') return { row, refused: true as const };

      const provider = row.provider as IntegrationProviderKey;
      let { accessToken, refreshToken } = this.openTokens(context, row);
      let expiresAt = row.accessExpiresAt;

      if (expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS) {
        try {
          const renewed = await this.adapterFor(provider).refresh(refreshToken);
          ({ accessToken, refreshToken, expiresAt } = renewed);
        } catch (error) {
          if (!(error instanceof ProviderAuthError)) throw this.unavailable(provider);
          await tx.integrationConnection.update({
            where: { id: row.id },
            data: { status: 'NEEDS_RECONNECT' },
          });
          await this.logIn(
            tx,
            context,
            membershipId,
            row.id,
            provider,
            'failed',
            'The grant was refused on renewal',
          );
          return { row, refused: true as const };
        }
        await this.logIn(tx, context, membershipId, row.id, provider, 'refreshed', null);
      }

      // Re-seal on every renewal, and whenever the key has been rotated.
      if (expiresAt !== row.accessExpiresAt || this.vault.isStale(row.refreshTokenSealed)) {
        await tx.integrationConnection.update({
          where: { id: row.id },
          data: {
            accessTokenSealed: this.vault.seal(
              accessToken,
              this.binding(context, provider, 'access'),
            ),
            refreshTokenSealed: this.vault.seal(
              refreshToken,
              this.binding(context, provider, 'refresh'),
            ),
            accessExpiresAt: expiresAt,
          },
        });
      }
      return { row, refused: false as const, accessToken };
    });

    if (prepared.refused) throw this.needsReconnect(prepared.row.provider);

    try {
      const result = await work(prepared.accessToken, prepared.row);
      await this.prisma.withTenant(context, async (tx) => {
        await tx.integrationConnection.update({
          where: { id: connectionId },
          data: { lastUsedAt: new Date() },
        });
        await this.logIn(
          tx,
          context,
          membershipId,
          connectionId,
          prepared.row.provider,
          'used',
          purpose,
        );
      });
      return result;
    } catch (error) {
      if (error instanceof ProviderAuthError) {
        await this.prisma.withTenant(context, async (tx) => {
          await tx.integrationConnection.update({
            where: { id: connectionId },
            data: { status: 'NEEDS_RECONNECT' },
          });
          await this.logIn(
            tx,
            context,
            membershipId,
            connectionId,
            prepared.row.provider,
            'failed',
            `${purpose}: refused`,
          );
        });
        throw this.needsReconnect(prepared.row.provider);
      }
      if (error instanceof ProviderUnavailableError) throw this.unavailable(prepared.row.provider);
      if (error instanceof ProviderRequestError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // For modules that act through a connection
  // -------------------------------------------------------------------------

  /** The business's connection to a provider, if it has one. */
  async connectionFor(
    context: TenantContext,
    provider: IntegrationProviderKey,
  ): Promise<{ id: string; status: 'CONNECTED' | 'NEEDS_RECONNECT' } | null> {
    return this.prisma.withTenant(context, (tx) =>
      tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: context.organizationId, provider } },
        select: { id: true, status: true },
      }),
    );
  }

  /** The adapter for a provider that can send documents for signature. */
  esign(provider: IntegrationProviderKey): IntegrationAdapter & ESignAdapter {
    const adapter = this.adapterFor(provider);
    if (!isESignAdapter(adapter)) {
      throw new BadRequestException(`${adapter.name} cannot send documents yet`);
    }
    return adapter;
  }

  /**
   * The secret address a provider reports progress to for this connection:
   * the business in the path, and a secret that proves the report came from
   * someone the provider was given the address by.
   */
  webhookUrl(context: TenantContext, connection: ConnectionRow): string | null {
    if (!connection.hookTokenSealed) return null;
    const token = this.vault.open(
      connection.hookTokenSealed,
      this.binding(context, connection.provider, 'hook'),
    );
    return `${this.env.APP_URL}/api/v1/webhooks/${connection.provider}/${context.organizationId}/${token}`;
  }

  /** Whether a webhook's secret matches this business's connection. */
  async matchesHook(
    context: TenantContext,
    provider: IntegrationProviderKey,
    token: string,
  ): Promise<string | null> {
    const row = await this.prisma.withTenant(context, (tx) =>
      tx.integrationConnection.findFirst({
        where: { provider, hookTokenHash: sha256(token) },
        select: { id: true },
      }),
    );
    return row?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private available(provider: string): boolean {
    return this.vault.available && (this.adapters.get(provider)?.configured() ?? false);
  }

  private adapterFor(provider: IntegrationProviderKey): IntegrationAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter || !this.available(provider)) {
      throw new BadRequestException('That service is not set up in RelaStack yet');
    }
    return adapter;
  }

  /** What a sealed value is for: its business, its provider, and which secret. */
  private binding(context: TenantContext, provider: string, what: string): string {
    return `${context.organizationId}:${provider}:${what}`;
  }

  private openTokens(context: TenantContext, row: ConnectionRow) {
    try {
      return {
        accessToken: this.vault.open(
          row.accessTokenSealed,
          this.binding(context, row.provider, 'access'),
        ),
        refreshToken: this.vault.open(
          row.refreshTokenSealed,
          this.binding(context, row.provider, 'refresh'),
        ),
      };
    } catch (error) {
      if (error instanceof VaultError) {
        // A key problem, not the customer's: loud in the log, plain to them.
        this.logger.error(
          `Could not open ${row.provider} grant for ${context.organizationId}: ${error.message}`,
        );
        throw new ServiceUnavailableException('That connection cannot be used right now');
      }
      throw error;
    }
  }

  private redirectUri(provider: string): string {
    return `${this.env.APP_URL}/api/v1/integrations/${provider}/callback`;
  }

  private needsReconnect(provider: string) {
    const name = INTEGRATION_PROVIDERS.find((entry) => entry.key === provider)?.name ?? provider;
    return new ConflictException({
      statusCode: 409,
      code: 'NEEDS_RECONNECT',
      message: `${name} needs reconnecting. An owner can do that under Settings → Connected apps.`,
    });
  }

  private unavailable(provider: string) {
    const name = INTEGRATION_PROVIDERS.find((entry) => entry.key === provider)?.name ?? provider;
    return new ServiceUnavailableException(`${name} could not be reached. Try again in a moment.`);
  }

  private async actorName(tx: TransactionClient, membershipId: string | null): Promise<string> {
    if (membershipId === null) return 'Automatic update';
    const membership = await tx.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    const user = membership?.user;
    return user
      ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email
      : 'Someone';
  }

  private async logIn(
    tx: TransactionClient,
    context: TenantContext,
    membershipId: string | null,
    connectionId: string | null,
    provider: string,
    action: string,
    detail: string | null,
  ): Promise<void> {
    await tx.integrationEvent.create({
      data: {
        organizationId: context.organizationId,
        connectionId,
        provider,
        action,
        detail,
        actorId: membershipId,
        actorName: await this.actorName(tx, membershipId),
      },
    });
  }

  private log(
    context: TenantContext,
    membershipId: string | null,
    connectionId: string | null,
    provider: string,
    action: string,
    detail: string | null,
  ): Promise<void> {
    return this.prisma.withTenant(context, (tx) =>
      this.logIn(tx, context, membershipId, connectionId, provider, action, detail),
    );
  }

  private toConnection(row: ConnectionRow): IntegrationConnection {
    return {
      id: row.id,
      provider: row.provider as IntegrationProviderKey,
      status: row.status,
      accountName: row.accountName,
      accountEmail: row.accountEmail,
      connectedByName: row.connectedByName,
      connectedAt: row.connectedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    };
  }
}
