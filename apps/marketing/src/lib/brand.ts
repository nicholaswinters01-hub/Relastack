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
   * The legal entity that controls the data, which is not the product name.
   *
   * Trading as an individual until an LLC is formed, so the controller is a
   * person. That is normal for a pre-launch project and it is the honest
   * answer — naming a company that does not exist yet would make the privacy
   * notice point at nobody.
   *
   * CHANGE THIS when the LLC is registered: the notice must name whoever
   * actually holds the data at the time, and the copyright line below uses it
   * too.
   */
  legalEntity: 'Nicholas Winters',

  /**
   * Published in the privacy notice as the address to write to. It has to
   * actually reach someone — this is where deletion requests arrive.
   */
  contactEmail: 'hello@bizfoundry.net',

  /** PLACEHOLDER — the jurisdiction whose law governs the privacy notice. */
  jurisdiction: 'the United States',
} as const;

/**
 * The logo's colours live in globals.css as `--color-brand` and
 * `--color-accent`, not here. Defining them in both places is how a brand
 * drifts: one gets updated, the other does not, and nobody notices until the
 * logo and the buttons disagree.
 */
