import { z } from 'zod';

/**
 * Quick search (Ctrl+K).
 *
 * Every kind of result comes from the same service, and the same visibility
 * filter, as its own list page. Search is a faster way to reach what someone
 * can already see, never a second way to see more.
 */

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(120),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResultKindSchema = z.enum(['customer', 'job', 'task', 'member', 'location']);
export type SearchResultKind = z.infer<typeof searchResultKindSchema>;

export const searchResultSchema = z.object({
  kind: searchResultKindSchema,
  id: z.string().uuid(),
  title: z.string(),
  /** A second line: contact details, the customer, a status. Already filtered for visibility. */
  subtitle: z.string().nullable(),
  /** A moment worth showing (a job's start), rendered by the browser in local time. */
  at: z.string().datetime().nullable(),
  /** Where the result opens: a relative path, so it works in any window. */
  href: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({ results: z.array(searchResultSchema) });
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** Results per kind. Enough to recognise the one you meant; the list page has the rest. */
export const SEARCH_RESULTS_PER_KIND = 5;
