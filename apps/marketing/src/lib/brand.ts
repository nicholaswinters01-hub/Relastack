/**
 * Everything name-shaped, in one place.
 *
 * The product does not have a name yet — the codebase calls it "platform",
 * which is a codename rather than a brand. PRODUCT_NAME below is a PLACEHOLDER
 * and appears on the page, in the browser tab, and in the privacy notice.
 *
 * It lives here alone so naming it later is one edit rather than a search
 * across a dozen files. The same goes for the legal entity and contact
 * address, which must be real before the site is published: a privacy notice
 * naming nobody is not a privacy notice.
 */

export const BRAND = {
  /** PLACEHOLDER — replace before publishing. */
  productName: 'Fieldwork',

  /** PLACEHOLDER — the legal entity that controls the data. */
  legalEntity: 'Fieldwork Software',

  /** PLACEHOLDER — a real, monitored address is required by law. */
  contactEmail: 'hello@example.com',

  /** PLACEHOLDER — the jurisdiction whose law governs the privacy notice. */
  jurisdiction: 'the United States',

  tagline: 'The software your business actually runs on.',
} as const;
