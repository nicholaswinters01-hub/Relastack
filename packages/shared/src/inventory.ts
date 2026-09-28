import { z } from 'zod';

/**
 * Inventory: items, the places stock sits, and every change to it.
 *
 * Quantities are numbers with up to three decimal places (2.5 gallons,
 * 0.125 lb). The database stores them exactly; the API sends plain numbers.
 */

/** Suggestions for the unit field. Any short word is accepted. */
export const INVENTORY_UNITS = [
  'each',
  'box',
  'case',
  'bag',
  'bottle',
  'can',
  'gal',
  'qt',
  'oz',
  'fl oz',
  'lb',
  'ft',
  'roll',
] as const;

const MAX_QUANTITY = 999_999_999;

const hasAtMostThreeDecimals = (value: number) =>
  Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6;

const quantity = z
  .number({ invalid_type_error: 'Enter a number' })
  .finite()
  .refine(hasAtMostThreeDecimals, 'Use at most three decimal places');

/** A positive amount: what was received, used, moved or lost. */
export const positiveQuantitySchema = quantity
  .refine((value) => value > 0, 'Enter an amount above zero')
  .refine((value) => value <= MAX_QUANTITY, 'That amount is too large');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

// --- Items -----------------------------------------------------------------

export const createItemRequestSchema = z.object({
  name: z.string().trim().min(1, 'Give the item a name').max(120),
  sku: optionalText(60),
  unit: z.string().trim().min(1, 'Choose a unit').max(20),
  category: optionalText(60),
  costCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  lowStockLevel: quantity
    .refine((value) => value >= 0, 'The low-stock level cannot be below zero')
    .nullable()
    .optional(),
});
export type CreateItemRequest = z.infer<typeof createItemRequestSchema>;

export const updateItemRequestSchema = createItemRequestSchema.partial().extend({
  /** Archived items keep their history and leave the everyday lists. */
  archived: z.boolean().optional(),
});
export type UpdateItemRequest = z.infer<typeof updateItemRequestSchema>;

export const stockPlaceKindSchema = z.enum(['BRANCH']);
export type StockPlaceKind = z.infer<typeof stockPlaceKindSchema>;

export const stockPlaceSchema = z.object({
  id: z.string().uuid(),
  kind: stockPlaceKindSchema,
  name: z.string(),
  locationId: z.string().uuid(),
  /** The branch has been deactivated. Its stock and history stay visible. */
  inactive: z.boolean(),
  employeesCanTake: z.boolean(),
  /** May receive, count, correct and change this place's setting. */
  canManage: z.boolean(),
  /** May record using and moving stock here. */
  canTake: z.boolean(),
});
export type StockPlace = z.infer<typeof stockPlaceSchema>;

export const placeQuantitySchema = z.object({
  placeId: z.string().uuid(),
  onHand: z.number(),
  /** At or below the item's low-stock level, at a place that carries it. */
  low: z.boolean(),
});

export const inventoryItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  unit: z.string(),
  category: z.string().nullable(),
  costCents: z.number().int().nullable(),
  lowStockLevel: z.number().nullable(),
  archived: z.boolean(),
  /** Across the places the reader can see, never the company total. */
  onHand: z.number(),
  /** Only places that have ever held this item. */
  places: z.array(placeQuantitySchema),
  low: z.boolean(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

export const inventoryResponseSchema = z.object({
  items: z.array(inventoryItemSchema),
  places: z.array(stockPlaceSchema),
});
export type InventoryResponse = z.infer<typeof inventoryResponseSchema>;

export const inventoryQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

// --- Changes ---------------------------------------------------------------

export const stockMovementReasonSchema = z.enum([
  'RECEIVED',
  'USED',
  'COUNTED',
  'DAMAGED',
  'MOVED_OUT',
  'MOVED_IN',
  'CORRECTED',
]);
export type StockMovementReason = z.infer<typeof stockMovementReasonSchema>;

export const stockMovementSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  placeId: z.string().uuid(),
  placeName: z.string(),
  quantity: z.number(),
  reason: stockMovementReasonSchema,
  countedQuantity: z.number().nullable(),
  transferId: z.string().uuid().nullable(),
  note: z.string().nullable(),
  recordedByName: z.string(),
  createdAt: z.string().datetime(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

export const itemDetailResponseSchema = z.object({
  item: inventoryItemSchema,
  places: z.array(stockPlaceSchema),
  movements: z.array(stockMovementSchema),
});
export type ItemDetailResponse = z.infer<typeof itemDetailResponseSchema>;

const note = z.string().trim().max(500).optional();
/** Resubmit with this set to record a change that takes stock below zero. */
const acknowledgeNegative = z.boolean().default(false);

export const stockChangeRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('receive'),
    itemId: z.string().uuid(),
    placeId: z.string().uuid(),
    quantity: positiveQuantitySchema,
    note,
  }),
  z.object({
    action: z.enum(['use', 'damaged']),
    itemId: z.string().uuid(),
    placeId: z.string().uuid(),
    quantity: positiveQuantitySchema,
    note,
    acknowledgeNegative,
  }),
  z.object({
    action: z.literal('count'),
    itemId: z.string().uuid(),
    placeId: z.string().uuid(),
    counted: quantity
      .refine((value) => value >= 0, 'A count cannot be below zero')
      .refine((value) => value <= MAX_QUANTITY, 'That amount is too large'),
    note,
  }),
  z.object({
    action: z.literal('move'),
    itemId: z.string().uuid(),
    placeId: z.string().uuid(),
    toPlaceId: z.string().uuid(),
    quantity: positiveQuantitySchema,
    note,
    acknowledgeNegative,
  }),
  z.object({
    action: z.literal('correct'),
    itemId: z.string().uuid(),
    placeId: z.string().uuid(),
    /** Signed: what to add (positive) or take away (negative). */
    change: quantity
      .refine((value) => value !== 0, 'Enter the amount to correct by')
      .refine((value) => Math.abs(value) <= MAX_QUANTITY, 'That amount is too large'),
    /** A correction must say why; it is the one change with no everyday reason. */
    note: z.string().trim().min(1, 'Say what the correction is for').max(500),
    acknowledgeNegative,
  }),
]);
export type StockChangeRequest = z.infer<typeof stockChangeRequestSchema>;

export const stockChangeResponseSchema = z.object({
  /** On hand afterwards at each place the change touched. */
  onHand: z.array(z.object({ placeId: z.string().uuid(), onHand: z.number() })),
});
export type StockChangeResponse = z.infer<typeof stockChangeResponseSchema>;

export const updatePlaceRequestSchema = z.object({
  employeesCanTake: z.boolean(),
});
export type UpdatePlaceRequest = z.infer<typeof updatePlaceRequestSchema>;
