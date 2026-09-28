/**
 * Inventory display helpers. A plain module, not a client component, so
 * server pages get the real functions rather than client references.
 */
export const formatQuantity = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: 3 });

export const REASON_LABEL: Record<string, string> = {
  RECEIVED: 'Received',
  USED: 'Used',
  COUNTED: 'Counted',
  DAMAGED: 'Damaged or lost',
  MOVED_OUT: 'Moved out',
  MOVED_IN: 'Moved in',
  CORRECTED: 'Corrected',
};
