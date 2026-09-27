import { z } from 'zod';

/**
 * Tasks.
 *
 * Part of core rather than a module: a platform that cannot record "ring Mrs
 * Patel back on Thursday" looks unfinished on any plan, and Scheduling and
 * Automation are both built on top of these.
 *
 * A task can hang off a customer or stand alone. Phase 9 jobs will attach to
 * the same table through a second nullable reference rather than a parallel
 * one — that is what makes this infrastructure rather than a CRM sub-feature.
 */

export const taskStatusSchema = z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

/** Statuses that mean the work is still live. */
export const OPEN_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED'];

/** Statuses that mean nobody is waiting on it any more. */
export const CLOSED_STATUSES: TaskStatus[] = ['DONE', 'CANCELLED'];

export function isOpen(status: TaskStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/**
 * Overdue means past due AND still open.
 *
 * A task completed late is not overdue, it is done. Treating it otherwise
 * leaves a list that can never be cleared, which is how people learn to
 * ignore the colour red.
 */
export function isOverdue(task: { dueAt: string | null; status: TaskStatus }): boolean {
  if (task.dueAt === null || !isOpen(task.status)) return false;

  return new Date(task.dueAt).getTime() < Date.now();
}

export const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  dueAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),

  locationId: z.string().uuid().nullable(),
  locationName: z.string().nullable(),

  assigneeMembershipId: z.string().uuid().nullable(),
  assigneeName: z.string().nullable(),

  /** Null when the person who asked has left the company. */
  createdByName: z.string().nullable(),

  customerId: z.string().uuid().nullable(),
  /**
   * Null when the task is standalone — but ALSO null when the reader is not
   * allowed to see that customer. A task title is harmless; the name of a
   * customer at a branch you do not work at is not, and would otherwise leak
   * through the task list.
   */
  customerName: z.string().nullable(),
  /** Hidden exactly when the name is. */
  customerAccountNumber: z.number().int().nullable(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Task = z.infer<typeof taskSchema>;

const taskFields = {
  title: z.string().trim().min(1, 'A task needs a title').max(200),
  /*
   * Empty becomes null, not undefined.
   *
   * Undefined means "not mentioned", and the update leaves anything not
   * mentioned alone — so an emptied box would have silently failed to clear
   * the description while reporting success. Null is how you say "remove
   * this", and it is the only way a form can express it.
   */
  description: z
    .string()
    .trim()
    .max(5000)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  priority: taskPrioritySchema.default('NORMAL'),
  dueAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  locationId: z.string().uuid().nullable().optional(),
  assigneeMembershipId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
};

export const createTaskRequestSchema = z.object({
  ...taskFields,
  status: taskStatusSchema.default('TODO'),
});

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.object({
  ...taskFields,
  title: taskFields.title.optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
});

export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const taskQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  /** Open work only — the default view, since closed tasks pile up forever. */
  openOnly: z.coerce.boolean().default(false),
  assigneeMembershipId: z.string().uuid().optional(),
  /** Shorthand for "assigned to me", so the client need not know its own id. */
  mine: z.coerce.boolean().default(false),
  customerId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  overdue: z.coerce.boolean().default(false),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export type TaskQuery = z.infer<typeof taskQuerySchema>;

export const tasksResponseSchema = z.object({
  tasks: z.array(taskSchema),
  nextCursor: z.string().uuid().nullable(),
});

export type TasksResponse = z.infer<typeof tasksResponseSchema>;

export const taskResponseSchema = z.object({ task: taskSchema });
export type TaskResponse = z.infer<typeof taskResponseSchema>;
