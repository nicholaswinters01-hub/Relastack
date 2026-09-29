import { z } from 'zod';
import { integrationProviderKeySchema } from './integrations';

/**
 * Contracts: agreements a business sends its customers to sign, from its own
 * e-signature account. RelaStack keeps a record of each one, never the
 * document: templates and signed copies stay with the provider.
 */

export const contractStatusSchema = z.enum(['SENT', 'VIEWED', 'SIGNED', 'DECLINED', 'VOIDED']);
export type ContractStatus = z.infer<typeof contractStatusSchema>;

export const contractTemplateSchema = z.object({
  provider: integrationProviderKeySchema,
  templateId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
export type ContractTemplate = z.infer<typeof contractTemplateSchema>;

export const contractTemplatesResponseSchema = z.object({
  /** Some e-signature account is connected. If not, sending starts in Settings. */
  connected: z.boolean(),
  templates: z.array(contractTemplateSchema),
});
export type ContractTemplatesResponse = z.infer<typeof contractTemplatesResponseSchema>;

export const templateDetailSchema = contractTemplateSchema.extend({
  /** Who signs, as the template names them: "Customer", "Client"… */
  roles: z.array(z.string()),
  /** Text fields the template asks for, to be filled before sending. */
  fields: z.array(z.string()),
});
export type TemplateDetail = z.infer<typeof templateDetailSchema>;

export const contractSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  provider: integrationProviderKeySchema,
  templateName: z.string(),
  title: z.string(),
  signerName: z.string(),
  signerEmail: z.string(),
  status: contractStatusSchema,
  sentByName: z.string(),
  sentAt: z.string().datetime(),
  viewedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  declinedAt: z.string().datetime().nullable(),
  voidedAt: z.string().datetime().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
  /** May void it or send another: can edit this customer. */
  canManage: z.boolean(),
});
export type Contract = z.infer<typeof contractSchema>;

export const contractsResponseSchema = z.object({ contracts: z.array(contractSchema) });
export type ContractsResponse = z.infer<typeof contractsResponseSchema>;

export const contractResponseSchema = z.object({ contract: contractSchema });
export type ContractResponse = z.infer<typeof contractResponseSchema>;

export const contractsQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  status: contractStatusSchema.optional(),
});
export type ContractsQuery = z.infer<typeof contractsQuerySchema>;

export const sendContractRequestSchema = z.object({
  customerId: z.string().uuid(),
  provider: integrationProviderKeySchema,
  templateId: z.string().min(1).max(100),
  roleName: z.string().min(1).max(100),
  signerName: z.string().trim().min(1, 'Who signs?').max(100),
  signerEmail: z.string().trim().email('Enter the email the contract goes to').max(254),
  subject: z.string().trim().max(100).optional(),
  /** The template's text fields, by label. */
  fields: z
    .record(z.string().max(100), z.string().max(500))
    .refine((value) => Object.keys(value).length <= 50, 'Too many fields'),
});
export type SendContractRequest = z.infer<typeof sendContractRequestSchema>;

export const voidContractRequestSchema = z.object({
  reason: z.string().trim().min(1, 'Say why it is being withdrawn').max(200),
});
export type VoidContractRequest = z.infer<typeof voidContractRequestSchema>;
