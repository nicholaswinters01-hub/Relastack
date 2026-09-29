import type { ContractStatus } from '@platform/shared';

/**
 * Contract status labels. A plain module, not a client component, so server
 * pages get the real values rather than client references.
 */
export const CONTRACT_STATUS: Record<ContractStatus, { label: string; tone: string }> = {
  SENT: { label: 'Sent', tone: 'border-[var(--color-line)] text-[var(--color-muted)]' },
  VIEWED: { label: 'Opened', tone: 'border-amber-500 text-amber-600 dark:text-amber-400' },
  SIGNED: { label: 'Signed', tone: 'border-[var(--color-ok)] text-[var(--color-ok)]' },
  DECLINED: { label: 'Declined', tone: 'border-[var(--color-bad)] text-[var(--color-bad)]' },
  VOIDED: { label: 'Withdrawn', tone: 'border-[var(--color-line)] text-[var(--color-muted)]' },
};
