import { z } from 'zod';

/**
 * Employee groups: labels a business gives its people ("Field crew",
 * "Office", "Accounting").
 *
 * They grant nothing. Roles decide what someone may do and locations where;
 * a group only helps find and organise people. Each business names its own.
 */

/** A fixed palette, so every group colour reads well in light and dark. */
export const GROUP_COLORS = [
  'slate',
  'blue',
  'green',
  'amber',
  'red',
  'violet',
  'teal',
  'pink',
] as const;
export const groupColorSchema = z.enum(GROUP_COLORS);
export type GroupColor = z.infer<typeof groupColorSchema>;

const groupName = z
  .string()
  .trim()
  .min(1, 'Give the group a name')
  .max(60, 'That name is too long');

export const memberGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: groupColorSchema,
  memberCount: z.number().int().nonnegative(),
});
export type MemberGroup = z.infer<typeof memberGroupSchema>;

export const groupsResponseSchema = z.object({ groups: z.array(memberGroupSchema) });
export type GroupsResponse = z.infer<typeof groupsResponseSchema>;

export const createGroupRequestSchema = z.object({
  name: groupName,
  color: groupColorSchema,
});
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

export const updateGroupRequestSchema = z.object({
  name: groupName.optional(),
  color: groupColorSchema.optional(),
});
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;

/** Sets a person's groups in one go: the list replaces what was there. */
export const setMemberGroupsRequestSchema = z.object({
  groupIds: z.array(z.string().uuid()).max(50),
});
export type SetMemberGroupsRequest = z.infer<typeof setMemberGroupsRequestSchema>;
