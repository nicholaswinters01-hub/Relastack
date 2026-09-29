import { z } from 'zod';
import { isoDateSchema } from './fleet';
import { MODULES, type ModuleKey } from './module';

/**
 * How people are doing: per-person measures over a period, for the managers
 * of the branches they work at, and for each person about themselves.
 *
 * Each measure belongs to a module and is offered only when the business has
 * it, so a business without Contracts never sees a contracts column. A
 * measure's count is what stands someone out; its detail gives the count its
 * context, so one lead won from one appointment is not read as a bad month.
 *
 * Calling for a manager is deliberately not a measure. Asking for help is what
 * the field should do, and counting it would teach people not to.
 */

export const PERFORMANCE_MEASURES = [
  {
    key: 'jobs',
    module: MODULES.SCHEDULING,
    label: 'Jobs',
    count: 'completed',
    detail: 'ran over',
    detailKind: 'part',
  },
  {
    key: 'contracts',
    module: MODULES.CONTRACTS,
    label: 'Contracts',
    count: 'signed',
    detail: 'sent',
    detailKind: 'outOf',
  },
  {
    key: 'leads',
    module: MODULES.CRM,
    label: 'Leads',
    count: 'won',
    detail: 'still open',
    detailKind: 'context',
  },
  {
    key: 'tasks',
    module: MODULES.CORE,
    label: 'Tasks',
    count: 'done',
    detail: 'late',
    detailKind: 'part',
  },
  {
    key: 'treatments',
    module: MODULES.PEST_CONTROL,
    label: 'Treatments',
    count: 'recorded',
    detail: null,
    detailKind: null,
  },
] as const satisfies readonly {
  key: string;
  module: ModuleKey;
  label: string;
  count: string;
  /** What the second number means, or null when there is none. */
  detail: string | null;
  /**
   * `part`: some of the count (jobs that ran over). `outOf`: the count is out
   * of this many (signed out of sent). `context`: a separate number that
   * frames the count (leads still open).
   */
  detailKind: 'part' | 'outOf' | 'context' | null;
}[];

export type PerformanceMeasure = (typeof PERFORMANCE_MEASURES)[number];
export type PerformanceMeasureKey = PerformanceMeasure['key'];

export const performanceMeasureKeySchema = z.enum(
  PERFORMANCE_MEASURES.map((measure) => measure.key) as [
    PerformanceMeasureKey,
    ...PerformanceMeasureKey[],
  ],
);

export const performanceQuerySchema = z
  .object({
    /** First day, inclusive, in the branch's own time zone. */
    from: isoDateSchema.optional(),
    /** Last day, inclusive. */
    to: isoDateSchema.optional(),
    locationId: z.string().uuid().optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'The period must end on or after it starts',
    path: ['to'],
  });
export type PerformanceQuery = z.infer<typeof performanceQuerySchema>;

export const performanceStatSchema = z.object({
  count: z.number().int(),
  detail: z.number().int().nullable(),
});
export type PerformanceStat = z.infer<typeof performanceStatSchema>;

const statsSchema = z.record(performanceMeasureKeySchema, performanceStatSchema);

export const performancePersonSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string(),
  stats: statsSchema,
});
export type PerformancePerson = z.infer<typeof performancePersonSchema>;

export const performanceStandoutSchema = z.object({
  measure: performanceMeasureKeySchema,
  names: z.array(z.string()),
  count: z.number().int(),
});
export type PerformanceStandout = z.infer<typeof performanceStandoutSchema>;

export const performanceResponseSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  /** The measures this business has, in display order. */
  measures: z.array(performanceMeasureKeySchema),
  /** What the numbers cover, so a branch view never reads as a company total. */
  scope: z.object({
    organizationWide: z.boolean(),
    locations: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  }),
  people: z.array(performancePersonSchema),
  standouts: z.array(performanceStandoutSchema),
});
export type PerformanceResponse = z.infer<typeof performanceResponseSchema>;

export const myPerformanceResponseSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  measures: z.array(performanceMeasureKeySchema),
  stats: statsSchema,
});
export type MyPerformanceResponse = z.infer<typeof myPerformanceResponseSchema>;
