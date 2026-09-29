import { z } from 'zod';

/**
 * Notifications, and the events behind them.
 *
 * Deliberately quiet. Only work handed to a specific person, and money,
 * produce a notification — a bell that lights up for everything is one people
 * learn to ignore, and that is very hard to undo.
 */

/**
 * The event types that exist.
 *
 * Dotted and stable: handlers match on these, Phase 12's automation triggers
 * will too, and preferences are stored against them. Renaming one is a
 * migration, not an edit.
 */
export const EVENT_TYPES = {
  TASK_ASSIGNED: 'task.assigned',
  JOB_ASSIGNED: 'job.assigned',
  JOB_CHANGED: 'job.changed',
  JOB_CANCELLED: 'job.cancelled',
  SUBSCRIPTION_PAST_DUE: 'subscription.past_due',
  SUBSCRIPTION_READ_ONLY: 'subscription.read_only',
  INVITATION_SENT: 'invitation.sent',
  SUPPORT_REPLIED: 'support.replied',
  HELP_REQUESTED: 'job.help_requested',
  HELP_ACKNOWLEDGED: 'job.help_acknowledged',
  CONTRACT_SIGNED: 'contract.signed',
  CONTRACT_DECLINED: 'contract.declined',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** What a person can turn off, and what each one means to them. */
export const NOTIFIABLE: Array<{ type: EventType; label: string; description: string }> = [
  {
    type: EVENT_TYPES.TASK_ASSIGNED,
    label: 'A task is assigned to you',
    description: 'Someone gives you something to do.',
  },
  {
    type: EVENT_TYPES.JOB_ASSIGNED,
    label: 'You are put on a job',
    description: 'You are added to the crew for a booked visit.',
  },
  {
    type: EVENT_TYPES.JOB_CHANGED,
    label: 'A job you are on moves',
    description: 'The time or place of a visit you are booked on changes.',
  },
  {
    type: EVENT_TYPES.JOB_CANCELLED,
    label: 'A job you are on is called off',
    description: 'A visit you were booked on is cancelled.',
  },
  {
    type: EVENT_TYPES.SUBSCRIPTION_PAST_DUE,
    label: 'A payment is due or fails',
    description: 'Owners only. A payment is due or was declined, and the grace period has started.',
  },
  {
    type: EVENT_TYPES.SUPPORT_REPLIED,
    label: 'We reply to your help request',
    description: 'The RelaStack team answers something you asked through Help.',
  },
  {
    type: EVENT_TYPES.HELP_REQUESTED,
    label: 'Someone in the field needs a manager',
    description: 'Managers. A tech on a job at your branch asks for you.',
  },
  {
    type: EVENT_TYPES.HELP_ACKNOWLEDGED,
    label: 'A manager answers your call',
    description: 'A manager has seen your "Need a manager" and is on it.',
  },
  {
    type: EVENT_TYPES.CONTRACT_SIGNED,
    label: 'A contract you sent is signed',
    description: 'The customer has signed an agreement you sent them.',
  },
  {
    type: EVENT_TYPES.CONTRACT_DECLINED,
    label: 'A contract you sent is declined',
    description: 'The customer has declined to sign an agreement you sent them.',
  },
];

export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  /** Relative, so it survives a domain change. */
  linkPath: z.string().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type Notification = z.infer<typeof notificationSchema>;

export const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  /** Drives the badge, so the client need not count what it was not sent. */
  unread: z.number().int().nonnegative(),
});

export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const notificationQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

export const notificationPreferenceSchema = z.object({
  type: z.string(),
  label: z.string(),
  description: z.string(),
  inApp: z.boolean(),
  email: z.boolean(),
});

export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

export const preferencesResponseSchema = z.object({
  preferences: z.array(notificationPreferenceSchema),
});

export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;

export const updatePreferenceRequestSchema = z.object({
  type: z.string().min(1),
  inApp: z.boolean(),
  email: z.boolean(),
});

export type UpdatePreferenceRequest = z.infer<typeof updatePreferenceRequestSchema>;

export const markReadRequestSchema = z.object({
  /** Empty marks everything read, which is the button people actually press. */
  ids: z.array(z.string().uuid()).max(200).default([]),
});

export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;
