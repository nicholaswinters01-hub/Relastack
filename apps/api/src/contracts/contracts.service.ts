import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TenantContext, TransactionClient } from '@platform/db';
import {
  EVENT_TYPES,
  INTEGRATION_PROVIDERS,
  PERMISSIONS,
  type Contract,
  type ContractStatus,
  type ContractTemplatesResponse,
  type ContractsQuery,
  type IntegrationProviderKey,
  type SendContractRequest,
  type TemplateDetail,
} from '@platform/shared';
import type { ProviderConnection, ProviderEnvelopeStatus } from '../integrations/adapter';
import { IntegrationsService, type ConnectionRow } from '../integrations/integrations.service';
import { EventsService } from '../notifications/events.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const NOT_FOUND = 'Contract not found';

/** How far along a contract is. Status only ever moves forward. */
const RANK: Record<ContractStatus, number> = {
  SENT: 0,
  VIEWED: 1,
  SIGNED: 2,
  DECLINED: 2,
  VOIDED: 2,
};

const CONTRACT_INCLUDE = {
  customer: { select: { displayName: true, locationId: true } },
} as const;
type ContractRow = Prisma.ContractGetPayload<{ include: typeof CONTRACT_INCLUDE }>;

const nameOf = (
  user?: { firstName: string | null; lastName: string | null; email: string } | null,
) => (user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email : 'Someone');

const providerConnection = (accessToken: string, row: ConnectionRow): ProviderConnection => ({
  accessToken,
  accountId: row.accountId,
  baseUri: row.baseUri,
});

/** For work nobody signed in asked for: a provider reporting back. */
const systemContext = (organizationId: string): TenantContext => ({
  organizationId,
  userId: '00000000-0000-0000-0000-000000000000',
});

/**
 * Contracts: documents sent to customers to sign, from the business's own
 * e-signature account (docs/design/contracts-and-integrations.md, stage 2).
 *
 * RelaStack keeps a record of sending, never the document. Visibility follows
 * the customer exactly as the customer list does, so someone who cannot see a
 * customer cannot see or even confirm their contracts. Sending or voiding one
 * needs customer.write where the customer sits.
 *
 * Status comes from the provider: its webhook pokes, and "check" asks. Both
 * re-read the envelope from the provider rather than trusting what the poke
 * said, and a status only ever moves forward, so a replayed or forged poke can
 * at most cause a check. Moving to signed or declined tells the sender, once.
 */
@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly events: EventsService,
  ) {}

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  async templates(
    context: TenantContext,
    membershipId: string,
  ): Promise<ContractTemplatesResponse> {
    const templates: ContractTemplatesResponse['templates'] = [];
    let connected = false;

    for (const provider of INTEGRATION_PROVIDERS.map((entry) => entry.key)) {
      const connection = await this.integrations.connectionFor(context, provider);
      if (!connection || connection.status !== 'CONNECTED') continue;
      connected = true;
      const listed = await this.integrations.withAccessToken(
        context,
        membershipId,
        connection.id,
        'Listed templates',
        (token, row) =>
          this.integrations.esign(provider).listTemplates(providerConnection(token, row)),
      );
      templates.push(...listed.map((template) => ({ provider, ...template })));
    }

    return { connected, templates };
  }

  async template(
    context: TenantContext,
    membershipId: string,
    provider: IntegrationProviderKey,
    templateId: string,
  ): Promise<TemplateDetail> {
    const connection = await this.requireConnection(context, provider);
    const detail = await this.integrations.withAccessToken(
      context,
      membershipId,
      connection.id,
      'Read a template',
      (token, row) =>
        this.integrations
          .esign(provider)
          .templateDetail(providerConnection(token, row), templateId),
    );
    return { provider, ...detail };
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async send(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    input: SendContractRequest,
  ): Promise<Contract> {
    const customer = await this.prisma.withTenant(context, (tx) =>
      tx.customer.findFirst({
        where: { AND: [{ id: input.customerId }, this.customerFilter(permissions)] },
        select: { id: true, locationId: true },
      }),
    );
    if (!customer) throw new NotFoundException('Customer not found');
    if (!this.canManage(permissions, customer.locationId)) {
      throw new ForbiddenException('You do not have permission to send this customer anything');
    }

    const connection = await this.requireConnection(context, input.provider);
    const adapter = this.integrations.esign(input.provider);

    const sent = await this.integrations.withAccessToken(
      context,
      membershipId,
      connection.id,
      `Sent a document to ${input.signerEmail}`,
      async (token, row) => {
        const target = providerConnection(token, row);
        const detail = await adapter.templateDetail(target, input.templateId);
        if (!detail.roles.includes(input.roleName)) {
          throw new BadRequestException(`That template has no signer called "${input.roleName}"`);
        }
        // Only the template's own fields: anything else would be silently
        // ignored by the provider, or worse, land somewhere unexpected.
        const fields = Object.fromEntries(
          Object.entries(input.fields).filter(([label]) => detail.fields.includes(label)),
        );
        const subject = input.subject?.trim() || detail.name;
        const { envelopeId } = await adapter.send(target, {
          templateId: input.templateId,
          roleName: input.roleName,
          signerName: input.signerName,
          signerEmail: input.signerEmail,
          subject,
          fields,
          webhookUrl: this.integrations.webhookUrl(context, row),
        });
        return { envelopeId, templateName: detail.name, subject, fields };
      },
    );

    const row = await this.prisma.withTenant(context, async (tx) =>
      tx.contract.create({
        data: {
          organizationId: context.organizationId,
          customerId: customer.id,
          provider: input.provider,
          providerEnvelopeId: sent.envelopeId,
          templateId: input.templateId,
          templateName: sent.templateName,
          title: sent.subject,
          signerName: input.signerName,
          signerEmail: input.signerEmail,
          fields: sent.fields,
          sentById: membershipId,
          sentByName: await this.memberName(tx, membershipId),
        },
        include: CONTRACT_INCLUDE,
      }),
    );
    return this.toContract(row, permissions);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    context: TenantContext,
    permissions: PermissionSet,
    query: ContractsQuery,
  ): Promise<Contract[]> {
    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.contract.findMany({
        where: {
          customer: this.customerFilter(permissions),
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        include: CONTRACT_INCLUDE,
        orderBy: { sentAt: 'desc' },
        take: 500,
      }),
    );
    return rows.map((row) => this.toContract(row, permissions));
  }

  async get(context: TenantContext, permissions: PermissionSet, id: string): Promise<Contract> {
    const row = await this.prisma.withTenant(context, (tx) =>
      this.loadVisible(tx, permissions, id),
    );
    return this.toContract(row, permissions);
  }

  /** The signed copy, fetched from the provider now. Never stored here. */
  async document(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const row = await this.prisma.withTenant(context, (tx) =>
      this.loadVisible(tx, permissions, id),
    );
    const provider = row.provider as IntegrationProviderKey;
    const connection = await this.requireConnection(context, provider);
    const pdf = await this.integrations.withAccessToken(
      context,
      membershipId,
      connection.id,
      `Opened "${row.title}"`,
      (token, conn) =>
        this.integrations
          .esign(provider)
          .document(providerConnection(token, conn), row.providerEnvelopeId),
    );
    const filename = `${row.title.replace(/[^A-Za-z0-9 _.-]/g, '').trim() || 'contract'}.pdf`;
    return { pdf, filename };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** "Check status": ask the provider now. */
  async check(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
  ): Promise<Contract> {
    const row = await this.prisma.withTenant(context, (tx) =>
      this.loadVisible(tx, permissions, id),
    );
    await this.refresh(context, membershipId, row);
    return this.get(context, permissions, id);
  }

  async voidContract(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
    reason: string,
  ): Promise<Contract> {
    const row = await this.prisma.withTenant(context, (tx) =>
      this.loadVisible(tx, permissions, id),
    );
    if (!this.canManage(permissions, row.customer.locationId)) {
      throw new ForbiddenException('You do not have permission to withdraw this contract');
    }
    if (RANK[row.status] === 2) {
      throw new BadRequestException('That contract is already finished and cannot be withdrawn');
    }

    const provider = row.provider as IntegrationProviderKey;
    const connection = await this.requireConnection(context, provider);
    await this.integrations.withAccessToken(
      context,
      membershipId,
      connection.id,
      `Withdrew "${row.title}"`,
      (token, conn) =>
        this.integrations
          .esign(provider)
          .voidEnvelope(providerConnection(token, conn), row.providerEnvelopeId, reason),
    );
    await this.prisma.withTenant(context, (tx) =>
      tx.contract.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'VOIDED', voidedAt: new Date(), lastCheckedAt: new Date() },
      }),
    );
    return this.get(context, permissions, id);
  }

  /**
   * A provider reporting progress on an envelope. The address carries the
   * business and a secret; a wrong secret is refused as not found. The report
   * itself is only a prompt to check: the status is read back from the
   * provider, never taken from the report.
   */
  async webhook(
    organizationId: string,
    provider: IntegrationProviderKey,
    token: string,
    payload: unknown,
  ): Promise<boolean> {
    const context = systemContext(organizationId);
    const connectionId = await this.integrations.matchesHook(context, provider, token);
    if (!connectionId) return false;

    const envelopeId = envelopeIdOf(payload);
    if (!envelopeId) return true;
    const row = await this.prisma.withTenant(context, (tx) =>
      tx.contract.findFirst({
        where: { provider, providerEnvelopeId: envelopeId },
        include: CONTRACT_INCLUDE,
      }),
    );
    if (row) await this.refresh(context, null, row);
    return true;
  }

  private async refresh(
    context: TenantContext,
    membershipId: string | null,
    row: ContractRow,
  ): Promise<void> {
    const provider = row.provider as IntegrationProviderKey;
    const connection = await this.requireConnection(context, provider);
    const status: ProviderEnvelopeStatus = await this.integrations.withAccessToken(
      context,
      membershipId,
      connection.id,
      `Checked "${row.title}"`,
      (token, conn) =>
        this.integrations
          .esign(provider)
          .status(providerConnection(token, conn), row.providerEnvelopeId),
    );

    await this.prisma.withTenant(context, async (tx) => {
      const forward = RANK[status.status] > RANK[row.status];
      const updated = await tx.contract.updateMany({
        // Only from the status it was read at: two reports arriving together
        // move it once, and tell the sender once.
        where: { id: row.id, status: row.status },
        data: {
          lastCheckedAt: new Date(),
          ...(forward ? { status: status.status } : {}),
          viewedAt: row.viewedAt ?? status.viewedAt,
          completedAt: row.completedAt ?? status.completedAt,
          declinedAt: row.declinedAt ?? status.declinedAt,
          voidedAt: row.voidedAt ?? status.voidedAt,
        },
      });
      if (!forward || updated.count === 0 || !row.sentById) return;
      if (status.status === 'SIGNED' || status.status === 'DECLINED') {
        await this.events.emit(
          tx,
          context.organizationId,
          status.status === 'SIGNED' ? EVENT_TYPES.CONTRACT_SIGNED : EVENT_TYPES.CONTRACT_DECLINED,
          {
            membershipId: row.sentById,
            contractId: row.id,
            customerId: row.customerId,
            customerName: row.customer.displayName,
            title: row.title,
          },
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** The customer list's own rule: organization-wide, or a branch the reader can see. */
  private customerFilter(permissions: PermissionSet): Prisma.CustomerWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);
    if (allowed === null) return {};
    const ids = [...allowed];
    return {
      OR: [{ locationId: { in: ids } }, { sharedLocations: { some: { locationId: { in: ids } } } }],
    };
  }

  private canManage(permissions: PermissionSet, locationId: string | null): boolean {
    return locationId === null
      ? permissions.has(PERMISSIONS.CUSTOMER_WRITE)
      : permissions.hasAt(PERMISSIONS.CUSTOMER_WRITE, locationId);
  }

  private async loadVisible(
    tx: TransactionClient,
    permissions: PermissionSet,
    id: string,
  ): Promise<ContractRow> {
    const row = await tx.contract.findFirst({
      where: { AND: [{ id }, { customer: this.customerFilter(permissions) }] },
      include: CONTRACT_INCLUDE,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }

  private async requireConnection(context: TenantContext, provider: IntegrationProviderKey) {
    const connection = await this.integrations.connectionFor(context, provider);
    if (!connection) {
      const name = INTEGRATION_PROVIDERS.find((entry) => entry.key === provider)?.name ?? provider;
      throw new BadRequestException(
        `${name} is not connected. An owner can connect it under Settings → Connected apps.`,
      );
    }
    return connection;
  }

  private async memberName(tx: TransactionClient, membershipId: string): Promise<string> {
    const membership = await tx.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    return nameOf(membership?.user);
  }

  private toContract(row: ContractRow, permissions: PermissionSet): Contract {
    return {
      id: row.id,
      customerId: row.customerId,
      customerName: row.customer.displayName,
      provider: row.provider as IntegrationProviderKey,
      templateName: row.templateName,
      title: row.title,
      signerName: row.signerName,
      signerEmail: row.signerEmail,
      status: row.status,
      sentByName: row.sentByName,
      sentAt: row.sentAt.toISOString(),
      viewedAt: row.viewedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      declinedAt: row.declinedAt?.toISOString() ?? null,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      canManage: this.canManage(permissions, row.customer.locationId),
    };
  }
}

/** DocuSign Connect (JSON) puts it at data.envelopeId; older shapes at the top. */
function envelopeIdOf(payload: unknown): string | null {
  const body = payload as { data?: { envelopeId?: unknown }; envelopeId?: unknown } | null;
  const id = body?.data?.envelopeId ?? body?.envelopeId;
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}
