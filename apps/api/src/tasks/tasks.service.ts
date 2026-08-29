import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TenantContext, type TransactionClient } from '@platform/db';
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  PERMISSIONS,
  type CreateTaskRequest,
  type PermissionKey,
  type Task,
  type TaskQuery,
  type UpdateTaskRequest,
  EVENT_TYPES,
} from '@platform/shared';
import { EventsService } from '../notifications/events.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const NOT_FOUND = 'Task not found';

const TASK_INCLUDE = {
  location: { select: { name: true } },
  customer: { select: { displayName: true, locationId: true } },
  assignee: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
  createdBy: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
} as const;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

const nameOf = (person?: { firstName: string | null; lastName: string | null; email: string }) =>
  person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email : null;

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  /**
   * Which tasks the caller may see.
   *
   * Three ways in:
   *
   *   - organization-wide task.read reaches everything
   *   - the task sits at a location they work at
   *   - the task is ASSIGNED to them, wherever it sits
   *
   * That third clause is a deliberate widening, and it is the product
   * decision: if a manager gives you a job at another branch, you can see it.
   * Without it, assigning across locations fails silently — the task exists,
   * the assignee cannot find it, and nobody discovers the problem until the
   * work has not been done.
   *
   * The widening is narrow on purpose. It grants sight of one row that someone
   * explicitly handed over, not of the location it belongs to.
   */
  private visibilityFilter(
    permissions: PermissionSet,
    membershipId: string,
  ): Prisma.TaskWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.TASK_READ);

    if (allowed === null) return {};

    return {
      OR: [{ locationId: { in: [...allowed] } }, { assigneeMembershipId: membershipId }],
    };
  }

  private scopedTo(
    permissions: PermissionSet,
    membershipId: string,
    where: Prisma.TaskWhereInput,
  ): Prisma.TaskWhereInput {
    // AND, never a spread — the filter carries its own keys.
    return { AND: [where, this.visibilityFilter(permissions, membershipId)] };
  }

  private assertPermissionAnywhere(
    permissions: PermissionSet,
    permission: PermissionKey,
    action: string,
  ): void {
    if (!permissions.hasAnywhere(permission)) {
      throw new ForbiddenException(`You do not have permission to ${action}`);
    }
  }

  /**
   * Writing is checked against the location the task sits at.
   *
   * A task with no location is company-wide work, so changing it needs
   * organization-wide authority.
   */
  private assertCanWrite(permissions: PermissionSet, locationId: string | null): void {
    if (locationId === null) {
      if (!permissions.has(PERMISSIONS.TASK_WRITE)) {
        throw new ForbiddenException(
          'Only an organization-wide role can change a task that is not tied to a location',
        );
      }
      return;
    }

    if (!permissions.hasAt(PERMISSIONS.TASK_WRITE, locationId)) {
      throw new ForbiddenException('You do not have permission to change tasks here');
    }
  }

  // -------------------------------------------------------------------------
  // Shaping
  // -------------------------------------------------------------------------

  /**
   * Turns a row into the public shape, hiding the customer name when the
   * reader is not allowed to see that customer.
   *
   * This is the subtle leak in the whole phase. A task is visible because it
   * is assigned to you or sits at your branch — neither of which implies you
   * may see the CUSTOMER it concerns. Returning `customerName` unconditionally
   * would let anyone with a task list enumerate customers at branches they
   * have no access to, straight past the Phase 7 rules.
   *
   * `visibleCustomerLocations` is null when the caller holds customer.read
   * organization-wide, which is the "sees everything" case.
   */
  static toPublic(row: TaskRow, visibleCustomerLocations: ReadonlySet<string> | null): Task {
    const customerVisible =
      row.customer === null ||
      visibleCustomerLocations === null ||
      (row.customer.locationId !== null && visibleCustomerLocations.has(row.customer.locationId));

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      dueAt: row.dueAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      locationId: row.locationId,
      locationName: row.location?.name ?? null,
      assigneeMembershipId: row.assigneeMembershipId,
      assigneeName: nameOf(row.assignee?.user),
      createdByName: nameOf(row.createdBy?.user),
      // The id goes too, not just the name — otherwise the task links through
      // to a customer page that will 404, which tells the reader it exists.
      customerId: customerVisible ? row.customerId : null,
      customerName: customerVisible ? (row.customer?.displayName ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Which locations' customers this caller may see. Null means all of them. */
  private customerScope(permissions: PermissionSet): ReadonlySet<string> | null {
    return permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    query: TaskQuery,
  ): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    this.assertPermissionAnywhere(permissions, PERMISSIONS.TASK_READ, 'view tasks');

    const filters: Prisma.TaskWhereInput[] = [];

    if (query.status) filters.push({ status: query.status });
    else if (query.openOnly) filters.push({ status: { in: OPEN_STATUSES } });

    if (query.mine) filters.push({ assigneeMembershipId: membershipId });
    else if (query.assigneeMembershipId) {
      filters.push({ assigneeMembershipId: query.assigneeMembershipId });
    }

    if (query.customerId) filters.push({ customerId: query.customerId });
    if (query.locationId) filters.push({ locationId: query.locationId });

    if (query.overdue) {
      // Past due AND still open. A task finished late is done, not overdue —
      // a list that can never be cleared is a list people stop reading.
      filters.push({ dueAt: { lt: new Date() }, status: { notIn: CLOSED_STATUSES } });
    }

    if (query.search) {
      filters.push({
        OR: [
          { title: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.task.findMany({
        where: this.scopedTo(permissions, membershipId, filters.length > 0 ? { AND: filters } : {}),
        include: TASK_INCLUDE,
        // Open work first, then by due date with undated last, then newest.
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );

    const page = rows.slice(0, query.limit);
    const scope = this.customerScope(permissions);

    return {
      tasks: page.map((row) => TasksService.toPublic(row, scope)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async getById(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
  ): Promise<Task> {
    this.assertPermissionAnywhere(permissions, PERMISSIONS.TASK_READ, 'view tasks');

    const row = await this.prisma.withTenant(context, (tx) =>
      tx.task.findFirst({
        where: this.scopedTo(permissions, membershipId, { id }),
        include: TASK_INCLUDE,
      }),
    );

    if (!row) throw new NotFoundException(NOT_FOUND);

    return TasksService.toPublic(row, this.customerScope(permissions));
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    input: CreateTaskRequest,
  ): Promise<Task> {
    const locationId = input.locationId ?? null;
    this.assertCanWrite(permissions, locationId);

    const created = await this.prisma.withTenant(context, async (tx) => {
      await this.assertReferencesExist(
        tx,
        input.locationId,
        input.customerId,
        input.assigneeMembershipId,
      );

      const task = await tx.task.create({
        data: {
          organizationId: context.organizationId,
          title: input.title,
          description: input.description ?? null,
          status: input.status,
          priority: input.priority,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          completedAt: input.status === 'DONE' ? new Date() : null,
          locationId,
          assigneeMembershipId: input.assigneeMembershipId ?? null,
          createdByMembershipId: membershipId,
          customerId: input.customerId ?? null,
        },
        select: { id: true },
      });

      // Emitted inside the same transaction as the task. If the process dies
      // here, both roll back together — the alternative is a task nobody was
      // told about, which fails silently and leaves no trace.
      if (input.assigneeMembershipId && input.assigneeMembershipId !== membershipId) {
        await this.events.emit(tx, context.organizationId, EVENT_TYPES.TASK_ASSIGNED, {
          taskId: task.id,
          title: input.title,
          assigneeMembershipId: input.assigneeMembershipId,
        });
      }

      return task;
    });

    this.logger.log(`Task ${created.id} created in organization ${context.organizationId}`);

    return this.getById(context, permissions, membershipId, created.id);
  }

  async update(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
    input: UpdateTaskRequest,
  ): Promise<Task> {
    await this.prisma.withTenant(context, async (tx) => {
      const current = await tx.task.findFirst({
        where: this.scopedTo(permissions, membershipId, { id }),
        select: {
          id: true,
          title: true,
          locationId: true,
          status: true,
          completedAt: true,
          assigneeMembershipId: true,
        },
      });

      if (!current) throw new NotFoundException(NOT_FOUND);

      /*
       * Whoever the task is assigned to can always move its status, whatever
       * their role. Being handed work you cannot then mark as done would be
       * absurd, and it is the one case where authority comes from the row
       * rather than from the role.
       *
       * Deliberately narrow: only the status. An assignee without task.write
       * cannot retitle the task, move it to another branch, change its due
       * date, or hand it to somebody else.
       */
      const isAssignee = current.assigneeMembershipId === membershipId;
      const statusOnly = Object.keys(input).length === 1 && input.status !== undefined;

      if (!(isAssignee && statusOnly)) {
        this.assertCanWrite(permissions, current.locationId);
      }

      if (input.locationId !== undefined && input.locationId !== current.locationId) {
        // Authority at BOTH ends, so a task cannot be pushed somewhere the
        // mover has no reach, nor pulled from a branch they do not run.
        this.assertCanWrite(permissions, input.locationId ?? null);
      }

      await this.assertReferencesExist(
        tx,
        input.locationId,
        input.customerId,
        input.assigneeMembershipId,
      );

      const becomingDone = input.status === 'DONE' && current.status !== 'DONE';

      await tx.task.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.dueAt !== undefined
            ? { dueAt: input.dueAt ? new Date(input.dueAt) : null }
            : {}),
          ...(input.locationId !== undefined ? { locationId: input.locationId ?? null } : {}),
          ...(input.assigneeMembershipId !== undefined
            ? { assigneeMembershipId: input.assigneeMembershipId ?? null }
            : {}),
          ...(input.customerId !== undefined ? { customerId: input.customerId ?? null } : {}),
          // Stamped on the FIRST completion only, so reopening and finishing
          // again keeps the date the work was actually first delivered.
          ...(becomingDone && current.completedAt === null ? { completedAt: new Date() } : {}),
        },
      });

      /*
       * Handing work to somebody else tells them, exactly as creating it
       * assigned to them does.
       *
       * Without this, fixing a mis-assignment was silent: the task moved to
       * the right person and the right person never found out, which is worse
       * than the original mistake because the sender believes it is handled.
       *
       * Only on a real change of hands. Editing a due date on a task somebody
       * already holds must not re-announce it, and reassigning something to
       * yourself is not news. Unassigning tells nobody — there is nobody to
       * tell, and the person losing it finds out from the list.
       */
      const newAssignee = input.assigneeMembershipId;

      if (
        newAssignee !== undefined &&
        newAssignee !== null &&
        newAssignee !== current.assigneeMembershipId &&
        newAssignee !== membershipId
      ) {
        await this.events.emit(tx, context.organizationId, EVENT_TYPES.TASK_ASSIGNED, {
          taskId: id,
          title: input.title ?? current.title,
          assigneeMembershipId: newAssignee,
        });
      }
    });

    return this.getById(context, permissions, membershipId, id);
  }

  /**
   * Permanent removal. Needs task.delete, which only an owner holds.
   *
   * Cancelling already expresses "this is not happening" without erasing that
   * it was ever asked for, so this is the rarer, sharper tool.
   */
  async remove(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
  ): Promise<void> {
    if (!permissions.has(PERMISSIONS.TASK_DELETE)) {
      throw new ForbiddenException('You do not have permission to delete tasks');
    }

    const deleted = await this.prisma.withTenant(context, (tx) =>
      tx.task.deleteMany({ where: this.scopedTo(permissions, membershipId, { id }) }),
    );

    if (deleted.count === 0) throw new NotFoundException(NOT_FOUND);

    this.logger.warn(`Task ${id} permanently deleted from ${context.organizationId}`);
  }

  // -------------------------------------------------------------------------

  /**
   * Every reference must exist in this organization.
   *
   * RLS makes another tenant's rows invisible, so a count of zero means either
   * "does not exist" or "belongs to someone else" — and the caller is told the
   * same thing either way. Database triggers refuse a mismatch regardless;
   * checking here turns what would be a 500 into an honest 400.
   */
  private async assertReferencesExist(
    tx: TransactionClient,
    locationId?: string | null,
    customerId?: string | null,
    assigneeMembershipId?: string | null,
  ): Promise<void> {
    if (locationId) {
      if ((await tx.location.count({ where: { id: locationId } })) === 0) {
        throw new BadRequestException('That location does not exist');
      }
    }

    if (customerId) {
      if ((await tx.customer.count({ where: { id: customerId } })) === 0) {
        throw new BadRequestException('That customer does not exist');
      }
    }

    if (assigneeMembershipId) {
      if ((await tx.organizationMembership.count({ where: { id: assigneeMembershipId } })) === 0) {
        throw new BadRequestException('That person is not in this organization');
      }
    }
  }
}
