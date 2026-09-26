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
   * Cased to match the logo: capital R twice, "RelaStack". Worth being
   * consistent about from the first day, because it ends up in the domain
   * (which is lowercase regardless — that is just how domains work, not a
   * casing decision), the email footer, the app title and every invoice.
   */
  productName: 'RelaStack',

  tagline: 'Business software, built around you.',

  /**
   * The legal entity that controls the data, which is not the product name.
   *
   * Named ahead of formation, at the product owner's explicit direction
   * (2026-09-26): B&N Business Solutions LLC is expected to register on
   * 2026-10-01 and this is set in advance of that date. Until the filing
   * actually goes through, "B&N Business Solutions" names an entity that does
   * not yet legally exist — a deletion or complaint sent to it before then has
   * no registered company to reach, only the person behind it.
   *
   * CONFIRM on or after 2026-10-01 that formation actually completed. If it
   * slips, this needs to read a person's name again until it does — see the
   * same note this replaced, on `legalEntity: 'Nicholas Winters'`.
   */
  legalEntity: 'B&N Business Solutions',

  /**
   * Published in the privacy notice as the address to write to. It has to
   * actually reach someone — this is where deletion requests arrive.
   */
  contactEmail: 'hello@relastack.com',

  /** PLACEHOLDER — the jurisdiction whose law governs the privacy notice. */
  jurisdiction: 'the United States',
} as const;

/**
 * The logo's colours live in globals.css as `--color-brand` and
 * `--color-accent`, not here. Defining them in both places is how a brand
 * drifts: one gets updated, the other does not, and nobody notices until the
 * logo and the buttons disagree.
 */
