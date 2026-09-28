import Link from 'next/link';
import type { PestRecord } from '@platform/shared';
import { formatQuantity } from '@/lib/inventory-format';

/**
 * Application records as a table. Server-rendered: no interaction, so no
 * client bundle, and it prints as it looks.
 */
export function PestRecordsTable({
  records,
  showCustomer = true,
}: {
  records: PestRecord[];
  showCustomer?: boolean;
}) {
  if (records.length === 0) {
    return <p className="mt-6 text-sm text-[var(--color-muted)]">No treatments recorded.</p>;
  }

  const th = 'px-3 py-2 text-left text-xs font-semibold text-[var(--color-muted)]';
  const td = 'px-3 py-2 align-top';

  return (
    <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="border-b border-[var(--color-line)]">
          <tr>
            <th className={th}>Date</th>
            {showCustomer && <th className={th}>Customer</th>}
            <th className={th}>Product</th>
            <th className={th}>Amount</th>
            <th className={th}>Pests · areas · method</th>
            <th className={th}>Applicator</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {records.map((record) => {
            const t = record.treatment;
            return (
              <tr key={record.movementId} className={record.voided ? 'opacity-50' : ''}>
                <td className={td}>
                  <Link href={`/jobs/${record.jobId}`} className="underline underline-offset-4">
                    {new Date(record.appliedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      ...(record.timezone ? { timeZone: record.timezone } : {}),
                    })}
                  </Link>
                  {record.voided && (
                    <span className="block text-xs text-[var(--color-bad)]">voided</span>
                  )}
                </td>
                {showCustomer && (
                  <td className={td}>
                    {record.customerName ?? '—'}
                    {record.address && (
                      <span className="block text-xs text-[var(--color-muted)]">
                        {record.address}
                      </span>
                    )}
                  </td>
                )}
                <td className={td}>
                  {t.productName}
                  {t.epaRegistrationNumber && (
                    <span className="block font-mono text-xs text-[var(--color-muted)]">
                      EPA {t.epaRegistrationNumber}
                    </span>
                  )}
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  {formatQuantity(record.quantity)} {record.unit}
                  {t.mixRate && (
                    <span className="block text-xs text-[var(--color-muted)]">{t.mixRate}</span>
                  )}
                </td>
                <td className={td}>
                  {t.targetPests.join(', ')}
                  <span className="block text-xs text-[var(--color-muted)]">
                    {t.areas.join(', ')} · {t.method}
                  </span>
                </td>
                <td className={td}>
                  {t.applicatorName}
                  <span className="block text-xs text-[var(--color-muted)]">
                    {t.applicatorLicense ?? 'no license on file'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
