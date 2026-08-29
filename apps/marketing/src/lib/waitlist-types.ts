/**
 * The shape every waitlist destination implements.
 *
 * Split into its own file so a provider can import the types without importing
 * the registry that imports it back.
 */

export interface SubscribeInput {
  email: string;
  /** When the visitor ticked the consent box. Recorded, not inferred. */
  consentedAt: string;
  /** Free text, e.g. the trade they are in. Optional. */
  note?: string;
}

export type SubscribeResult =
  | { ok: true }
  /**
   * Already on the list. Reported separately so the caller can decide what to
   * say — the route deliberately does NOT pass this on to the visitor.
   */
  | { ok: true; duplicate: true }
  | { ok: false; reason: string };

export interface WaitlistProvider {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
}
