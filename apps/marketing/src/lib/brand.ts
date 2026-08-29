/**
 * Everything name-shaped, in one place.
 *
 * Kept together so renaming is one edit rather than a search across a dozen
 * files. Two of these are still placeholders and are marked as such — a
 * privacy notice naming nobody, or pointing at an address no one reads, gives
 * a visitor no way to exercise their rights.
 */

export const BRAND = {
  /**
   * Cased to match the logo: capital B, capital F. Worth being consistent
   * about from the first day, because it ends up in the domain, the email
   * footer, the app title and every invoice.
   */
  productName: 'BizFoundry',

  tagline: 'Business software, built around you.',

  /**
   * PLACEHOLDER — the legal entity that controls the data, which is not
   * necessarily the product name. If you trade through a company, that
   * company's registered name belongs here.
   */
  legalEntity: 'BizFoundry',

  /** PLACEHOLDER — must be a real, monitored address before publishing. */
  contactEmail: 'hello@bizfoundry.example',

  /** PLACEHOLDER — the jurisdiction whose law governs the privacy notice. */
  jurisdiction: 'the United States',
} as const;

/**
 * The logo's colours live in globals.css as `--color-brand` and
 * `--color-accent`, not here. Defining them in both places is how a brand
 * drifts: one gets updated, the other does not, and nobody notices until the
 * logo and the buttons disagree.
 */
