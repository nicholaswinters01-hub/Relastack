import { z } from 'zod';

/**
 * The help desk (Phase 19c): questions, problems and ideas a business sends
 * us from inside the app, and our replies.
 *
 * A request is seen by whoever opened it and by the business's owners; the
 * staff console sees every business's requests, and nothing more than it
 * already could.
 */

export const supportKindSchema = z.enum(['QUESTION', 'PROBLEM', 'IDEA']);
export type SupportKind = z.infer<typeof supportKindSchema>;

export const supportStatusSchema = z.enum(['OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED']);
export type SupportStatus = z.infer<typeof supportStatusSchema>;

/** Stops a stuck script, or a bad day, filling the inbox. */
export const SUPPORT_REQUESTS_PER_DAY = 10;

const bodySchema = z
  .string()
  .trim()
  .min(1, 'Write a message')
  .max(5000, 'That message is too long');

export const openSupportRequestSchema = z.object({
  kind: supportKindSchema,
  subject: z.string().trim().min(3, 'Give it a short title').max(200),
  body: bodySchema,
});
export type OpenSupportRequest = z.infer<typeof openSupportRequestSchema>;

export const supportReplySchema = z.object({ body: bodySchema });
export type SupportReply = z.infer<typeof supportReplySchema>;

/** A staff reply, and where it leaves the request. Waiting on them, unless said otherwise. */
export const staffSupportReplySchema = z.object({
  body: bodySchema,
  status: supportStatusSchema.optional(),
});
export type StaffSupportReply = z.infer<typeof staffSupportReplySchema>;

export const staffSupportStatusSchema = z.object({ status: supportStatusSchema });
export type StaffSupportStatus = z.infer<typeof staffSupportStatusSchema>;

export const supportMessageSchema = z.object({
  id: z.string().uuid(),
  fromStaff: z.boolean(),
  /** "RelaStack" for staff: a business sees the team, not a personal address. */
  authorLabel: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
});
export type SupportMessage = z.infer<typeof supportMessageSchema>;

export const supportRequestSummarySchema = z.object({
  id: z.string().uuid(),
  kind: supportKindSchema,
  subject: z.string(),
  status: supportStatusSchema,
  openedByEmail: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SupportRequestSummary = z.infer<typeof supportRequestSummarySchema>;

export const supportRequestDetailSchema = supportRequestSummarySchema.extend({
  messages: z.array(supportMessageSchema),
});
export type SupportRequestDetail = z.infer<typeof supportRequestDetailSchema>;

export const supportRequestsResponseSchema = z.object({
  requests: z.array(supportRequestSummarySchema),
});
export type SupportRequestsResponse = z.infer<typeof supportRequestsResponseSchema>;

/** The staff inbox: the same, with the business beside each. */
export const staffSupportSummarySchema = supportRequestSummarySchema.extend({
  organizationId: z.string().uuid(),
  businessName: z.string(),
});
export type StaffSupportSummary = z.infer<typeof staffSupportSummarySchema>;

export const staffSupportDetailSchema = staffSupportSummarySchema.extend({
  messages: z.array(supportMessageSchema),
});
export type StaffSupportDetail = z.infer<typeof staffSupportDetailSchema>;

export const staffSupportFilterSchema = z.enum(['open', 'waiting', 'resolved', 'all']);
export const staffSupportQuerySchema = z.object({
  filter: staffSupportFilterSchema.default('open'),
});
export type StaffSupportQuery = z.infer<typeof staffSupportQuerySchema>;

export const staffSupportListSchema = z.object({ requests: z.array(staffSupportSummarySchema) });
export type StaffSupportList = z.infer<typeof staffSupportListSchema>;
