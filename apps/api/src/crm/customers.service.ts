import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type TenantContext, type TransactionClient } from '@platform/db';
import {
  PERMISSIONS,
  type CreateCustomerRequest,
  type Customer,
  type CustomerDetail,
  type CustomerQuery,
  type CustomerStage,
  type CustomerType,
  type CustomFieldValues,
  type PermissionKey,
  type UpdateCustomerRequest,
  type CustomerImportPreview,
  type CustomerImportRequest,
  type CustomerImportResult,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';
import { ContactsService } from './contacts.service';
import { CustomFieldsService } from './custom-fields.service';
import { NotesService } from './notes.service';
import { analyzeImport } from './customer-import';

/**
 * Cross-tenant and out-of-scope access are both reported as "not found".
 *
 * A 403 would confirm the customer exists. For a customer list that is a real
 * leak: an employee at one branch could enumerate the company book by probing
 * ids and reading which ones came back 403 rather than 404.
 */
const NOT_FOUND = 'Customer not found';

const CUSTOMER_INCLUDE = {
  location: { select: { name: true } },
  ownerMembership: {
    select: { user: { select: { firstName: true, lastName: true, email: true } } },
  },
  sharedLocations: { select: { locationId: true } },
  tags: { include: { tag: true } },
} as const;

type CustomerRow = Prisma.CustomerGetPayload<{ include: typeof CUSTOMER_INCLUDE }>;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customFields: CustomFieldsService,
    private readonly contacts: ContactsService,
    private readonly notes: NotesService,
  ) {}

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  /**
   * Which customers the caller may see.
   *
   * Three ways in, and the OR between them is the whole point:
   *
   *   - organization-wide customer.read reaches everyone
   *   - the customer's primary location is one the caller is scoped to
   *   - the customer is SHARED with a location the caller is scoped to
   *
   * A customer with no location at all is reachable only organization-wide,
   * the same rule Phase 3 applies to an unassigned location. Someone has to be
   * able to see an unassigned lead, and it should be whoever runs the company
   * rather than whichever branch happens to guess the id.
   *
   * Note this is scoping WITHIN a tenant. The tenant boundary is already
   * handled — RLS makes another organization's customers invisible whatever
   * this returns.
   */
  private visibilityFilter(permissions: PermissionSet): Prisma.CustomerWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);

    // null means the permission is held organization-wide, so no filter at
    // all — deliberately not "the ids of the locations that exist right now",
    // which would be a snapshot excluding anything created afterwards.
    if (allowed === null) return {};

    const ids = [...allowed];

    return {
      OR: [{ locationId: { in: ids } }, { sharedLocations: { some: { locationId: { in: ids } } } }],
    };
  }

  /**
   * Combines the visibility filter with another condition.
   *
   * AND, never an object spread. The filter carries its own keys, so
   * `{ id, ...filter }` would silently discard the requested id and return
   * whatever the filter matched first — asking for one customer and getting a
   * different one, with a 200. That exact bug shipped once in Phase 3.
   */
  private scopedTo(
    permissions: PermissionSet,
    where: Prisma.CustomerWhereInput,
  ): Prisma.CustomerWhereInput {
    return { AND: [where, this.visibilityFilter(permissions)] };
  }

  /**
   * Holds the permission SOMEWHERE — organization-wide or at any location.
   *
   * Reading uses this rather than `has`, because a Location Manager holds
   * customer.read only at their branches. Asking `has` here would refuse them
   * outright and the visibility filter below would never run. Rule 7 in the
   * working agreement exists because this is easy to get backwards, and it was
   * got backwards here first.
   */
  private assertPermissionAnywhere(
    permissions: PermissionSet,
    permission: PermissionKey,
    action: string,
  ): void {
    if (!permissions.hasAnywhere(permission)) {
      throw new ForbiddenException(`You do not have permission to ${action}`);
    }
  }

  /** Holds the permission across the whole organization. */
  private assertPermissionOrganizationWide(
    permissions: PermissionSet,
    permission: PermissionKey,
    action: string,
  ): void {
    if (!permissions.has(permission)) {
      throw new ForbiddenException(`You do not have permission to ${action}`);
    }
  }

  /**
   * Writing is checked against the location the customer sits at.
   *
   * A Location Manager may edit their own branch's customers and nobody
   * else's. For an unassigned customer there is no location to check, so it
   * takes organization-wide authority.
   */
  private assertCanWrite(permissions: PermissionSet, locationId: string | null): void {
    if (locationId === null) {
      if (!permissions.has(PERMISSIONS.CUSTOMER_WRITE)) {
        throw new ForbiddenException(
          'Only an organization-wide role can change a customer that is not assigned to a location',
        );
      }
      return;
    }

    if (!permissions.hasAt(PERMISSIONS.CUSTOMER_WRITE, locationId)) {
      throw new ForbiddenException('You do not have permission to change customers here');
    }
  }

  // -------------------------------------------------------------------------
  // Shaping
  // -------------------------------------------------------------------------

  static displayNameFor(input: {
    type: CustomerType;
    companyName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  }): string {
    if (input.type === 'COMPANY') return input.companyName?.trim() ?? '';

    return [input.firstName, input.lastName]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(' ')
      .trim();
  }

  static toPublic(row: CustomerRow): Customer {
    const owner = row.ownerMembership?.user;

    return {
      id: row.id,
      // Required by a CHECK constraint; Prisma only thinks it optional.
      accountNumber: row.accountNumber ?? 0,
      stage: row.stage,
      type: row.type,
      displayName: row.displayName,
      companyName: row.companyName,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      phone: row.phone,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
      source: row.source,
      locationId: row.locationId,
      locationName: row.location?.name ?? null,
      sharedLocationIds: row.sharedLocations.map((entry) => entry.locationId),
      ownerMembershipId: row.ownerMembershipId,
      ownerName: owner
        ? [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email
        : null,
      customFields: (row.customFields ?? {}) as CustomFieldValues,
      tags: row.tags.map((entry) => ({
        id: entry.tag.id,
        name: entry.tag.name,
        color: entry.tag.color as never,
      })),
      convertedAt: row.convertedAt?.toISOString() ?? null,
      lastContactedAt: row.lastContactedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    context: TenantContext,
    permissions: PermissionSet,
    query: CustomerQuery,
  ): Promise<{ customers: Customer[]; nextCursor: string | null }> {
    this.assertPermissionAnywhere(permissions, PERMISSIONS.CUSTOMER_READ, 'view customers');

    const filters: Prisma.CustomerWhereInput[] = [];

    if (query.stage) {
      filters.push({ stage: query.stage });
    } else if (!query.includeArchived) {
      // Archived customers are hidden by default but never deleted. A business
      // must be able to find a former customer again.
      filters.push({ stage: { not: 'ARCHIVED' } });
    }

    if (query.locationId) filters.push({ locationId: query.locationId });
    if (query.ownerMembershipId) filters.push({ ownerMembershipId: query.ownerMembershipId });
    if (query.tagId) filters.push({ tags: { some: { tagId: query.tagId } } });

    if (query.search) {
      const term = query.search;
      // "1042" or "#1042" also finds that account.
      const asNumber = /^#?\d{1,8}$/.test(term) ? Number(term.replace('#', '')) : null;
      filters.push({
        OR: [
          ...(asNumber !== null ? [{ accountNumber: asNumber }] : []),
          { displayName: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term, mode: 'insensitive' } },
          { companyName: { contains: term, mode: 'insensitive' } },
        ],
      });
    }

    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.customer.findMany({
        where: this.scopedTo(permissions, filters.length > 0 ? { AND: filters } : {}),
        include: CUSTOMER_INCLUDE,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        // One more than asked for, so "is there another page" needs no count.
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );

    const page = rows.slice(0, query.limit);

    return {
      customers: page.map(CustomersService.toPublic),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async getById(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
  ): Promise<CustomerDetail> {
    this.assertPermissionAnywhere(permissions, PERMISSIONS.CUSTOMER_READ, 'view customers');

    const row = await this.prisma.withTenant(context, (tx) =>
      tx.customer.findFirst({
        where: this.scopedTo(permissions, { id }),
        include: {
          ...CUSTOMER_INCLUDE,
          contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
          notes: {
            include: {
              author: {
                select: { user: { select: { firstName: true, lastName: true, email: true } } },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
    );

    if (!row) throw new NotFoundException(NOT_FOUND);

    return {
      ...CustomersService.toPublic(row),
      contacts: row.contacts.map(ContactsService.toPublic),
      notes: row.notes.map(NotesService.toPublic),
    };
  }

  /**
   * Loads a customer for writing, checking scope.
   *
   * Reads through the visibility filter first, so a customer the caller cannot
   * see is "not found" rather than "forbidden" — otherwise the write path
   * would leak exactly what the read path is careful to hide.
   */
  private async loadForWrite(
    tx: TransactionClient,
    permissions: PermissionSet,
    id: string,
  ): Promise<{
    id: string;
    locationId: string | null;
    stage: CustomerStage;
    accountNumber: number | null;
  }> {
    const row = await tx.customer.findFirst({
      where: this.scopedTo(permissions, { id }),
      select: { id: true, locationId: true, stage: true, accountNumber: true },
    });

    if (!row) throw new NotFoundException(NOT_FOUND);

    this.assertCanWrite(permissions, row.locationId);

    return row;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(
    context: TenantContext,
    permissions: PermissionSet,
    input: CreateCustomerRequest,
  ): Promise<CustomerDetail> {
    const locationId = input.locationId ?? null;
    this.assertCanWrite(permissions, locationId);

    const displayName = CustomersService.displayNameFor({ ...input, type: input.type });
    const customFields = await this.customFields.validate(context, input.customFields ?? {});

    const created = await this.prisma.withTenant(context, async (tx) => {
      await this.assertLocationInScope(tx, locationId);

      return tx.customer.create({
        data: {
          organizationId: context.organizationId,
          stage: input.stage,
          type: input.type,
          displayName,
          companyName: input.companyName ?? null,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          region: input.region ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
          source: input.source ?? null,
          locationId,
          ownerMembershipId: input.ownerMembershipId ?? null,
          customFields,
          convertedAt: input.stage === 'ACTIVE' ? new Date() : null,
        },
        select: { id: true },
      });
    });

    this.logger.log(`Customer ${created.id} created in organization ${context.organizationId}`);

    return this.getById(context, permissions, created.id);
  }

  async update(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
    input: UpdateCustomerRequest,
  ): Promise<CustomerDetail> {
    // Fetched outside the transaction so the merge below can be validated
    // without nesting one withTenant call inside another.
    const definitions =
      input.customFields === undefined ? [] : await this.customFields.list(context);

    await this.prisma.withTenant(context, async (tx) => {
      const current = await this.loadForWrite(tx, permissions, id);

      // Moving a customer to a different branch needs authority at BOTH ends.
      // Otherwise a manager could hand themselves a customer from a branch they
      // do not run, or push an awkward one somewhere they cannot be followed.
      if (input.locationId !== undefined && input.locationId !== current.locationId) {
        this.assertCanWrite(permissions, input.locationId ?? null);
        await this.assertLocationInScope(tx, input.locationId ?? null);
      }

      const existing = await tx.customer.findUniqueOrThrow({
        where: { id },
        select: {
          type: true,
          companyName: true,
          firstName: true,
          lastName: true,
          customFields: true,
          convertedAt: true,
        },
      });

      // A PATCH naming one custom field must not wipe the rest. Merging
      // inside the transaction keeps a concurrent edit from losing a value,
      // and validating the MERGED result is what makes a required field mean
      // "the record has it" rather than "this request mentioned it".
      const customFields =
        input.customFields === undefined
          ? undefined
          : this.customFields.validateWith(definitions, {
              ...((existing.customFields ?? {}) as CustomFieldValues),
              ...input.customFields,
            });

      const merged = {
        type: input.type ?? existing.type,
        // undefined keeps the old value; null clears it.
        companyName: input.companyName !== undefined ? input.companyName : existing.companyName,
        firstName: input.firstName !== undefined ? input.firstName : existing.firstName,
        lastName: input.lastName !== undefined ? input.lastName : existing.lastName,
      };

      const displayName = CustomersService.displayNameFor(merged);

      if (!displayName) {
        throw new BadRequestException('A customer needs a name');
      }

      // Stamped once, on the FIRST conversion. A customer who lapses and comes
      // back keeps the date the relationship actually began — re-stamping it
      // would quietly rewrite the history every reporting query depends on.
      const firstConversion =
        input.stage === 'ACTIVE' && current.stage !== 'ACTIVE' && existing.convertedAt === null;

      // Numbers are handed out by the database. Choosing one is for an owner
      // bringing records over from another system, and a number must only ever
      // mean one account.
      const renumber =
        input.accountNumber !== undefined && input.accountNumber !== current.accountNumber;
      if (renumber) {
        this.assertPermissionOrganizationWide(
          permissions,
          PERMISSIONS.CUSTOMER_DELETE,
          'change account numbers',
        );
        const taken = await tx.customer.count({
          where: { accountNumber: input.accountNumber, id: { not: id } },
        });
        if (taken > 0) {
          throw new ConflictException(`Account #${input.accountNumber} is already in use`);
        }
      }

      await tx.customer.update({
        where: { id },
        data: {
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.companyName !== undefined ? { companyName: input.companyName ?? null } : {}),
          ...(input.firstName !== undefined ? { firstName: input.firstName ?? null } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName ?? null } : {}),
          ...(input.email !== undefined ? { email: input.email ?? null } : {}),
          ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
          ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 ?? null } : {}),
          ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 ?? null } : {}),
          ...(input.city !== undefined ? { city: input.city ?? null } : {}),
          ...(input.region !== undefined ? { region: input.region ?? null } : {}),
          ...(input.postalCode !== undefined ? { postalCode: input.postalCode ?? null } : {}),
          ...(input.country !== undefined ? { country: input.country ?? null } : {}),
          ...(input.source !== undefined ? { source: input.source ?? null } : {}),
          ...(input.locationId !== undefined ? { locationId: input.locationId ?? null } : {}),
          ...(input.ownerMembershipId !== undefined
            ? { ownerMembershipId: input.ownerMembershipId ?? null }
            : {}),
          ...(customFields !== undefined ? { customFields } : {}),
          ...(renumber ? { accountNumber: input.accountNumber } : {}),
          displayName,
          // Set once, on the first conversion, and left alone afterwards so a
          // customer who lapses and returns keeps their original date.
          ...(firstConversion ? { convertedAt: new Date() } : {}),
        },
      });
    });

    return this.getById(context, permissions, id);
  }

  /**
   * Archive, the ordinary way a customer goes away.
   *
   * A stage change, not a delete: the notes, the contacts and the history stay
   * exactly where they are, and the customer can be brought back.
   */
  async archive(context: TenantContext, permissions: PermissionSet, id: string): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      await this.loadForWrite(tx, permissions, id);

      await tx.customer.update({ where: { id }, data: { stage: 'ARCHIVED' } });
    });

    this.logger.log(`Customer ${id} archived`);
  }

  /**
   * Permanent removal. Needs customer.delete, which only an owner holds.
   *
   * Kept separate from archive because it destroys the note history too, and
   * that is not something a branch manager should be able to do by clicking
   * the same button they use for tidying up.
   */
  async remove(context: TenantContext, permissions: PermissionSet, id: string): Promise<void> {
    this.assertPermissionOrganizationWide(
      permissions,
      PERMISSIONS.CUSTOMER_DELETE,
      'delete customers',
    );

    const deleted = await this.prisma.withTenant(context, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: this.scopedTo(permissions, { id }),
        select: { id: true },
      });
      if (!customer) throw new NotFoundException(NOT_FOUND);

      // Every job, series and task cascades from the customer, so deleting one
      // with work attached would wipe that history from the schedule and the
      // reports. Refused, naming what is there; archiving keeps it all.
      const [jobs, series, tasks] = await Promise.all([
        tx.job.count({ where: { customerId: id } }),
        tx.jobSeries.count({ where: { customerId: id } }),
        tx.task.count({ where: { customerId: id } }),
      ]);
      const attached = [
        jobs > 0 ? `${jobs} job${jobs === 1 ? '' : 's'}` : null,
        series > 0 ? `${series} recurring series` : null,
        tasks > 0 ? `${tasks} task${tasks === 1 ? '' : 's'}` : null,
      ].filter((part): part is string => part !== null);

      if (attached.length > 0) {
        throw new ConflictException({
          statusCode: 409,
          code: 'CUSTOMER_HAS_WORK',
          message: `This customer has ${attached.join(', ')}. Remove (archive) them instead, which keeps that history.`,
        });
      }

      return tx.customer.deleteMany({ where: { id } });
    });

    if (deleted.count === 0) throw new NotFoundException(NOT_FOUND);

    this.logger.warn(`Customer ${id} permanently deleted from ${context.organizationId}`);
  }

  // -------------------------------------------------------------------------
  // Tags and sharing
  // -------------------------------------------------------------------------

  async setTags(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
    tagIds: string[],
  ): Promise<CustomerDetail> {
    await this.prisma.withTenant(context, async (tx) => {
      await this.loadForWrite(tx, permissions, id);

      // RLS already prevents another tenant's tag being read, and a database
      // trigger refuses one anyway. Checking here turns what would be a 500
      // into an honest 400.
      const found = await tx.tag.count({ where: { id: { in: tagIds } } });

      if (found !== new Set(tagIds).size) {
        throw new BadRequestException('One of those tags does not exist');
      }

      await tx.customerTag.deleteMany({ where: { customerId: id, tagId: { notIn: tagIds } } });

      for (const tagId of tagIds) {
        // Upsert rather than create-and-catch: PostgreSQL aborts the whole
        // transaction on a unique violation, so catching it and continuing
        // does not work.
        await tx.customerTag.upsert({
          where: { customerId_tagId: { customerId: id, tagId } },
          create: { customerId: id, tagId, organizationId: context.organizationId },
          update: {},
        });
      }
    });

    return this.getById(context, permissions, id);
  }

  /**
   * Share a customer with additional locations.
   *
   * Gated by the Shared Customers module at the controller. Requires
   * organization-wide write: deciding that a customer belongs to several
   * branches is a company decision, and a manager at one branch must not be
   * able to grant another branch sight of their book.
   */
  async setSharedLocations(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
    locationIds: string[],
  ): Promise<CustomerDetail> {
    // Organization-wide deliberately, not `hasAnywhere`: granting another
    // branch sight of your book is a company decision, and a manager at one
    // location must not be able to make it.
    this.assertPermissionOrganizationWide(
      permissions,
      PERMISSIONS.CUSTOMER_WRITE,
      'share customers across locations',
    );

    await this.prisma.withTenant(context, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: this.scopedTo(permissions, { id }),
        select: { id: true, locationId: true },
      });

      if (!customer) throw new NotFoundException(NOT_FOUND);

      const wanted = [...new Set(locationIds)].filter((value) => value !== customer.locationId);

      const found = await tx.location.count({ where: { id: { in: wanted } } });
      if (found !== wanted.length) {
        throw new BadRequestException('One of those locations does not exist');
      }

      await tx.customerLocation.deleteMany({
        where: { customerId: id, locationId: { notIn: wanted } },
      });

      for (const locationId of wanted) {
        await tx.customerLocation.upsert({
          where: { customerId_locationId: { customerId: id, locationId } },
          create: { customerId: id, locationId, organizationId: context.organizationId },
          update: {},
        });
      }
    });

    return this.getById(context, permissions, id);
  }

  // -------------------------------------------------------------------------

  /**
   * A location referenced by a write must exist in this organization.
   *
   * RLS makes another tenant's location invisible, so a count of zero means
   * either "does not exist" or "belongs to someone else" — and the caller is
   * told the same thing either way.
   */
  // -------------------------------------------------------------------------
  // Importing from a spreadsheet
  // -------------------------------------------------------------------------

  /**
   * Check every row of an import without saving anything.
   *
   * Owners and admins only: bulk-adding a customer list is a decision for the
   * whole business. Keeping old account numbers is owner-only, as it is one at
   * a time.
   */
  async previewImport(
    context: TenantContext,
    permissions: PermissionSet,
    request: CustomerImportRequest,
  ): Promise<CustomerImportPreview> {
    const { analysis } = await this.analyzeImportRequest(context, permissions, request);
    return {
      rows: analysis.results,
      counts: {
        ready: analysis.ready.length,
        duplicate: analysis.results.filter((r) => r.status === 'duplicate').length,
        invalid: analysis.results.filter((r) => r.status === 'invalid').length,
      },
    };
  }

  /**
   * Import the rows that pass, skipping duplicates and rows with problems.
   *
   * Checked again here rather than trusting the preview the browser holds.
   * Every imported customer gets the import's tag, so a bad import is easy to
   * find and archive. Saved in batches: each batch is all-or-nothing, and a
   * big list does not hold one transaction open for long.
   */
  async importCustomers(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    request: CustomerImportRequest,
  ): Promise<CustomerImportResult> {
    const { analysis } = await this.analyzeImportRequest(context, permissions, request);
    const skippedDuplicates = analysis.results.filter((r) => r.status === 'duplicate').length;
    const skippedInvalid = analysis.results.filter((r) => r.status === 'invalid').length;

    if (analysis.ready.length === 0) {
      return { created: 0, skippedDuplicates, skippedInvalid, tag: null };
    }

    const now = new Date();
    const tag = await this.prisma.withTenant(context, async (tx) => {
      const day = now.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      // Checked, not caught: an error inside a transaction aborts it.
      for (let attempt = 1; ; attempt += 1) {
        const name = attempt === 1 ? `Imported ${day}` : `Imported ${day} (${attempt})`;
        const taken = await tx.tag.findFirst({ where: { name }, select: { id: true } });
        if (!taken) {
          return tx.tag.create({
            data: { organizationId: context.organizationId, name },
            select: { id: true, name: true },
          });
        }
      }
    });

    const BATCH = 200;
    for (let start = 0; start < analysis.ready.length; start += BATCH) {
      const batch = analysis.ready.slice(start, start + BATCH).map((row) => ({
        ...row,
        // Chosen here, so notes and tags can name the customer without relying
        // on the order the database returns rows in.
        id: randomUUID(),
      }));

      await this.prisma.withTenant(context, async (tx) => {
        await tx.customer.createMany({
          data: batch.map(({ id, data, accountNumber, customFields }) => ({
            id,
            organizationId: context.organizationId,
            stage: data.stage,
            type: data.type,
            displayName: CustomersService.displayNameFor(data),
            companyName: data.companyName ?? null,
            firstName: data.firstName ?? null,
            lastName: data.lastName ?? null,
            email: data.email ?? null,
            phone: data.phone ?? null,
            addressLine1: data.addressLine1 ?? null,
            addressLine2: data.addressLine2 ?? null,
            city: data.city ?? null,
            region: data.region ?? null,
            postalCode: data.postalCode ?? null,
            country: data.country ?? null,
            source: data.source ?? null,
            locationId: request.locationId,
            customFields: customFields as Prisma.InputJsonValue,
            convertedAt: data.stage === 'ACTIVE' ? now : null,
            // Left out entirely when not chosen, so the database numbers it.
            ...(accountNumber !== null ? { accountNumber } : {}),
          })),
        });

        await tx.customerTag.createMany({
          data: batch.map(({ id }) => ({
            customerId: id,
            tagId: tag.id,
            organizationId: context.organizationId,
          })),
        });

        const notes = batch.filter((row) => row.note !== null);
        if (notes.length > 0) {
          await tx.customerNote.createMany({
            data: notes.map(({ id, note }) => ({
              organizationId: context.organizationId,
              customerId: id,
              authorMembershipId: membershipId,
              body: note!,
            })),
          });
        }
      });
    }

    this.logger.log(
      `Imported ${analysis.ready.length} customer(s) into ${context.organizationId}; skipped ${skippedDuplicates} duplicate(s), ${skippedInvalid} invalid`,
    );

    return { created: analysis.ready.length, skippedDuplicates, skippedInvalid, tag };
  }

  private async analyzeImportRequest(
    context: TenantContext,
    permissions: PermissionSet,
    request: CustomerImportRequest,
  ) {
    this.assertPermissionOrganizationWide(
      permissions,
      PERMISSIONS.CUSTOMER_WRITE,
      'import customers',
    );

    const definitions = await this.customFields.list(context);
    const existing = await this.prisma.withTenant(context, async (tx) => {
      await this.assertLocationInScope(tx, request.locationId);
      // Every customer, archived too: re-importing a former customer is still a duplicate.
      return tx.customer.findMany({
        select: { id: true, displayName: true, accountNumber: true, email: true, phone: true },
      });
    });

    const analysis = analyzeImport(request.rows, {
      stage: request.stage,
      locationId: request.locationId,
      canChooseNumbers: permissions.has(PERMISSIONS.CUSTOMER_DELETE),
      existing,
      definitions,
    });

    return { analysis };
  }

  private async assertLocationInScope(
    tx: TransactionClient,
    locationId: string | null,
  ): Promise<void> {
    if (locationId === null) return;

    const found = await tx.location.count({ where: { id: locationId } });

    if (found === 0) throw new BadRequestException('That location does not exist');
  }

  /** Used by the nested contact and note routes to check scope once. */
  async assertWritable(
    context: TenantContext,
    permissions: PermissionSet,
    customerId: string,
  ): Promise<void> {
    await this.prisma.withTenant(context, (tx) => this.loadForWrite(tx, permissions, customerId));
  }

  /** Used by the nested read routes. Throws 404 when out of scope. */
  async assertReadable(
    context: TenantContext,
    permissions: PermissionSet,
    customerId: string,
  ): Promise<void> {
    this.assertPermissionAnywhere(permissions, PERMISSIONS.CUSTOMER_READ, 'view customers');

    const found = await this.prisma.withTenant(context, (tx) =>
      tx.customer.count({ where: this.scopedTo(permissions, { id: customerId }) }),
    );

    if (found === 0) throw new NotFoundException(NOT_FOUND);
  }
}
