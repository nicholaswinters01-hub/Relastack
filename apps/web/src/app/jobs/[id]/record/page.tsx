import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MODULES, pestTreatmentRecordSchema } from '@platform/shared';
import { PrintButton } from '@/components/print-button';
import {
  getCurrentOrganization,
  getJob,
  getJobMaterials,
  getJobSignoff,
  getModules,
} from '@/lib/api';
import { formatQuantity } from '@/lib/inventory-format';

export const dynamic = 'force-dynamic';

const when = (iso: string, timezone: string | null) =>
  new Date(iso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timezone ? { timeZone: timezone } : {}),
  });

/**
 * One visit's application record, laid out to print or save as PDF.
 *
 * Everything on it comes from what was recorded at the time: the product's
 * registration number and the applicator's license were copied onto each
 * line, so this page reads the same whenever it is printed.
 */
export default async function ApplicationRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { id } = await params;
  const [job, modules] = await Promise.all([getJob(id), getModules()]);
  if (!job) notFound();
  if (!modules.some((m) => m.key === MODULES.PEST_CONTROL && m.enabled)) notFound();

  const [materials, signoff] = await Promise.all([getJobMaterials(id), getJobSignoff(id)]);
  const lines = (materials?.materials ?? []).flatMap((line) => {
    const parsed = pestTreatmentRecordSchema.safeParse(line.packFields[MODULES.PEST_CONTROL]);
    return parsed.success ? [{ line, pest: parsed.data }] : [];
  });
  const address = [
    [job.addressLine1, job.addressLine2].filter(Boolean).join(' '),
    [job.city, [job.region, job.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join(', ');

  const th = 'border-b border-gray-300 px-2 py-1.5 text-left font-semibold';
  const td = 'border-b border-gray-200 px-2 py-1.5 align-top';

  return (
    <main className="mx-auto max-w-5xl bg-white px-6 py-10 text-[13px] text-black print:max-w-none print:p-0">
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/jobs/${job.id}`} className="text-sm underline underline-offset-4">
          Back to the job
        </Link>
        <PrintButton />
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-black pb-3">
        <div>
          <p className="text-lg font-bold">{organization.organization.name}</p>
          <p>Pesticide application record</p>
        </div>
        <div className="text-right">
          <p>
            <span className="font-semibold">Visit:</span> {job.title}
          </p>
          <p>
            <span className="font-semibold">Date:</span> {when(job.startsAt, job.locationTimezone)}
          </p>
          {job.locationName && (
            <p>
              <span className="font-semibold">Branch:</span> {job.locationName}
            </p>
          )}
        </div>
      </header>

      <section className="mt-4 grid gap-1 sm:grid-cols-2">
        <p>
          <span className="font-semibold">Customer:</span> {job.customerName ?? '—'}
          {job.customerAccountNumber !== null && ` (#${job.customerAccountNumber})`}
        </p>
        <p>
          <span className="font-semibold">Service address:</span> {address || '—'}
        </p>
      </section>

      {lines.length === 0 ? (
        <p className="mt-6">No treatments are recorded on this visit.</p>
      ) : (
        <table className="mt-6 w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>Product</th>
              <th className={th}>EPA Reg. No.</th>
              <th className={th}>Amount</th>
              <th className={th}>Mix rate</th>
              <th className={th}>Target pests</th>
              <th className={th}>Areas treated</th>
              <th className={th}>Method</th>
              <th className={th}>Weather</th>
              <th className={th}>Applicator / license</th>
              <th className={th}>Time</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ line, pest }) => (
              <tr key={line.id} className={line.voided ? 'text-gray-500' : ''}>
                <td className={td}>
                  <span className={line.voided ? 'line-through' : ''}>{pest.productName}</span>
                  {pest.activeIngredient && (
                    <span className="block text-[11px]">{pest.activeIngredient}</span>
                  )}
                  {line.voided && (
                    <span className="block text-[11px]">
                      VOID: {line.voided.reason} ({line.voided.byName})
                    </span>
                  )}
                </td>
                <td className={td}>{pest.epaRegistrationNumber ?? '—'}</td>
                <td className={td}>
                  {formatQuantity(line.quantity)} {line.unit}
                </td>
                <td className={td}>{pest.mixRate ?? '—'}</td>
                <td className={td}>{pest.targetPests.join(', ')}</td>
                <td className={td}>{pest.areas.join(', ')}</td>
                <td className={td}>{pest.method}</td>
                <td className={td}>
                  {[
                    pest.windMph != null && `${pest.windMph} mph`,
                    pest.temperatureF != null && `${pest.temperatureF}°F`,
                  ]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </td>
                <td className={td}>
                  {pest.applicatorName}
                  <span className="block text-[11px]">
                    {pest.applicatorLicense ?? 'No license on file'}
                    {pest.applicatorLicenseExpiresOn &&
                      ` (exp. ${pest.applicatorLicenseExpiresOn})`}
                  </span>
                </td>
                <td className={td}>{when(line.createdAt, job.locationTimezone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="mt-8 grid gap-6 sm:grid-cols-2">
        <div>
          <p className="font-semibold">Customer signature</p>
          {signoff ? (
            <>
              <img
                src={signoff.image}
                alt={`Signature of ${signoff.signerName}`}
                className="mt-1 h-20"
              />
              <p>
                {signoff.signerName}, {when(signoff.signedAt, job.locationTimezone)}
              </p>
            </>
          ) : (
            <p className="mt-6 border-t border-black pt-1">Not signed</p>
          )}
        </div>
      </section>
    </main>
  );
}
