import { z } from 'zod';

/**
 * Connected apps (Phase 11a): a business's accounts in other services that
 * RelaStack may act in, such as its DocuSign. The grants themselves never
 * leave the API; these contracts describe connections, never contain them.
 */

export const INTEGRATION_PROVIDERS = [
  {
    key: 'docusign',
    name: 'DocuSign',
    description: 'Send contracts and agreements for signature from your own DocuSign account.',
  },
  {
    key: 'dropbox_sign',
    name: 'Dropbox Sign',
    description: 'Send contracts and agreements for signature from your own Dropbox Sign account.',
  },
] as const;

export type IntegrationProviderKey = (typeof INTEGRATION_PROVIDERS)[number]['key'];

export const integrationProviderKeySchema = z.enum(['docusign', 'dropbox_sign']);

export const integrationConnectionSchema = z.object({
  id: z.string().uuid(),
  provider: integrationProviderKeySchema,
  status: z.enum(['CONNECTED', 'NEEDS_RECONNECT']),
  accountName: z.string().nullable(),
  accountEmail: z.string().nullable(),
  connectedByName: z.string(),
  connectedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

export const integrationEventSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  action: z.string(),
  detail: z.string().nullable(),
  actorName: z.string(),
  createdAt: z.string().datetime(),
});
export type IntegrationEvent = z.infer<typeof integrationEventSchema>;

export const integrationsResponseSchema = z.object({
  providers: z.array(
    z.object({
      key: integrationProviderKeySchema,
      name: z.string(),
      description: z.string(),
      /** RelaStack has this provider set up. Not yet: shown as coming soon. */
      available: z.boolean(),
      connection: integrationConnectionSchema.nullable(),
    }),
  ),
  /** The most recent uses of any connection, for the owner to check. */
  events: z.array(integrationEventSchema),
});
export type IntegrationsResponse = z.infer<typeof integrationsResponseSchema>;

export const connectResponseSchema = z.object({
  /** Where to send the owner to approve, at the provider. */
  url: z.string().url(),
});
export type ConnectResponse = z.infer<typeof connectResponseSchema>;

export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
});
export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
