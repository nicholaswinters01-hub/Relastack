import Link from 'next/link';
import { MODULE_REGISTRY, type Plan, type PlanComparisonExtra } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { getCurrentOrganization, getPlans, getSubscription } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Compare plans · RelaStack' };

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });

function Included({ value }: { value: boolean }) {
  return value ? (
    <span className="text-lg text-[var(--color-ok)]" aria-label="Included">
      ✓
    </span>
  ) : (
    <span className="text-lg text-[var(--color-muted)] opacity-60" aria-label="Not included">
      ✗
    </span>
  );
}

function Cell({ value }: { value: PlanComparisonExtra['value'] | undefined }) {
  if (value === undefined) return <Included value={false} />;
  if (typeof value === 'boolean') return <Included value={value} />;
  return <span className="text-sm">{value}</span>;
}

function ComingSoon() {
  return (
    <span className="ml-2 inline-block whitespace-nowrap rounded-full border border-[var(--color-line)] px-2 py-0.5 align-middle font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
      coming soon
    </span>
  );
}

/**
 * Plans side by side.
 *
 * Open to anyone, so the marketing site can link here before somebody has an
 * account. Every tick comes from plan data — modules from plan_modules, the
 * rest from each plan's comparison rows — so the page cannot promise what a
 * plan does not actually unlock. Modules without screens yet say so.
 */
export default async function PlansPage() {
  const organization = await getCurrentOrganization();
  const [plans, billing] = await Promise.all([
    getPlans(),
    organization ? getSubscription() : Promise.resolve(null),
  ]);
  const currentKey = billing?.subscription.planKey ?? null;

  // Extra rows in the order the cheapest plan lists them, then any others.
  const extraLabels = [
    ...new Set(plans.flatMap((plan) => plan.comparisonExtras.map((extra) => extra.label))),
  ];
  const extra = (plan: Plan, label: string) =>
    plan.comparisonExtras.find((entry) => entry.label === label);

  const column = (plan: Plan) => (plan.key === currentKey ? 'bg-[var(--color-canvas)]' : '');

  return (
    <>
      {organization ? (
        <AppNav current="billing" />
      ) : (
        <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
            <Link href="/" className="font-semibold tracking-tight">
              RelaStack
            </Link>
            <div className="flex items-center gap-4 text-sm">
              <Link href="/register" className="text-[var(--color-muted)] hover:underline">
                Have an access code?
              </Link>
              <Link
                href="/login"
                className="rounded-lg bg-[var(--color-ink)] px-3 py-1.5 font-medium text-[var(--color-canvas)]"
              >
                Sign in
              </Link>
            </div>
          </div>
        </header>
      )}

      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        {organization && (
          <Link
            href="/billing"
            className="text-sm text-[var(--color-muted)] underline underline-offset-4"
          >
            Billing
          </Link>
        )}
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Compare plans</h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted)]">
          Priced by business location, never by user. Every plan includes one location and everyone
          who works there.
        </p>
        {billing && !plans.some((plan) => plan.key === currentKey) && (
          <p className="mt-3 max-w-2xl text-sm">
            {billing.subscription.status === 'TRIALING'
              ? `You are on the free trial${
                  billing.subscription.trialEndsAt
                    ? ` until ${new Date(billing.subscription.trialEndsAt).toLocaleDateString(
                        'en-US',
                        { month: 'long', day: 'numeric', year: 'numeric' },
                      )}`
                    : ''
                }. Pick the plan that fits and we will set it up.`
              : `You are on ${billing.subscription.planName}, a plan we no longer offer. It stays yours for as long as you want it.`}
          </p>
        )}

        {plans.length === 0 ? (
          <p className="mt-8 text-sm text-[var(--color-muted)]">
            We could not load the plans. Try again in a moment.
          </p>
        ) : (
          <div className="mt-8 overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
            <table className="w-full min-w-[520px] sm:min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--color-line)] align-top">
                  <th
                    scope="col"
                    className="sticky left-0 w-32 bg-[var(--color-surface)] p-4 sm:static sm:w-2/5"
                  >
                    <span className="sr-only">Feature</span>
                  </th>
                  {plans.map((plan) => (
                    <th
                      key={plan.key}
                      scope="col"
                      className={`p-4 text-center font-normal ${column(plan)}`}
                    >
                      <div className="font-semibold">{plan.name}</div>
                      {plan.key === currentKey && (
                        <div className="font-mono text-xs text-[var(--color-muted)]">your plan</div>
                      )}
                      <div className="mt-2 text-2xl font-semibold tracking-tight">
                        {money(plan.basePriceCents)}
                        <span className="text-sm font-normal text-[var(--color-muted)]">/mo</span>
                      </div>
                      <p className="mt-1 hidden text-xs sm:block text-[var(--color-muted)]">
                        {plan.description}
                      </p>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="[&>tr]:border-b [&>tr]:border-[var(--color-line)] [&>tr:last-child]:border-0">
                <SectionRow title="The basics" span={plans.length} />
                <Row label="Locations included" plans={plans} column={column}>
                  {(plan) => <span className="text-sm">{plan.includedLocations}</span>}
                </Row>
                <Row label="Each extra location" plans={plans} column={column}>
                  {(plan) =>
                    plan.maxLocations !== null && plan.maxLocations <= plan.includedLocations ? (
                      <Included value={false} />
                    ) : (
                      <span className="text-sm">{money(plan.perLocationPriceCents)}/mo</span>
                    )
                  }
                </Row>
                <Row label="Users" plans={plans} column={column}>
                  {() => <span className="text-sm">Unlimited</span>}
                </Row>
                <Row label="Pay yearly" plans={plans} column={column}>
                  {(plan) =>
                    plan.annualBillingMonths < 12 ? (
                      <span className="text-sm">
                        {money(plan.basePriceCents * plan.annualBillingMonths)}/yr
                        <span className="block text-xs text-[var(--color-muted)]">
                          {12 - plan.annualBillingMonths} months free
                        </span>
                      </span>
                    ) : (
                      <Included value={false} />
                    )
                  }
                </Row>
                <Row label="Free trial" plans={plans} column={column}>
                  {(plan) =>
                    plan.trialDays > 0 ? (
                      <span className="text-sm">{plan.trialDays} days</span>
                    ) : (
                      <Included value={false} />
                    )
                  }
                </Row>

                <SectionRow title="Modules" span={plans.length} />
                {MODULE_REGISTRY.filter((module) => module.kind === 'module').map((module) => (
                  <Row
                    key={module.key}
                    label={module.name}
                    detail={module.description}
                    comingSoon={!module.ready}
                    plans={plans}
                    column={column}
                  >
                    {(plan) => (
                      <Included value={module.isCore || plan.modules.includes(module.key)} />
                    )}
                  </Row>
                ))}

                {extraLabels.length > 0 && <SectionRow title="And more" span={plans.length} />}
                {extraLabels.map((label) => (
                  <Row
                    key={label}
                    label={label}
                    comingSoon={plans.some((plan) => extra(plan, label)?.comingSoon)}
                    plans={plans}
                    column={column}
                  >
                    {(plan) => <Cell value={extra(plan, label)?.value} />}
                  </Row>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-6 text-sm text-[var(--color-muted)]">
          {organization
            ? 'To change plan, email hello@relastack.com and we will switch it over for you.'
            : 'RelaStack is invite-only while we work with our first businesses.'}{' '}
          Coming soon means it is on the way and not in the app yet. A lapsed payment never locks
          you out of your own data.
        </p>
      </main>
    </>
  );
}

function SectionRow({ title, span }: { title: string; span: number }) {
  return (
    <tr>
      <th
        scope="colgroup"
        colSpan={span + 1}
        className="px-4 pb-2 pt-6 text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]"
      >
        <span className="sticky left-4 inline-block">{title}</span>
      </th>
    </tr>
  );
}

function Row({
  label,
  detail,
  comingSoon = false,
  plans,
  column,
  children,
}: {
  label: string;
  detail?: string;
  comingSoon?: boolean;
  plans: Plan[];
  column: (plan: Plan) => string;
  children: (plan: Plan) => React.ReactNode;
}) {
  return (
    <tr className="align-middle">
      <th
        scope="row"
        className="sticky left-0 bg-[var(--color-surface)] p-3 font-normal sm:static sm:p-4"
      >
        <span className="text-sm font-medium">{label}</span>
        {comingSoon && <ComingSoon />}
        {detail && (
          <p className="mt-0.5 hidden text-xs sm:block text-[var(--color-muted)]">{detail}</p>
        )}
      </th>
      {plans.map((plan) => (
        <td key={plan.key} className={`p-4 text-center ${column(plan)}`}>
          {children(plan)}
        </td>
      ))}
    </tr>
  );
}
