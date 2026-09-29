import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEnv } from '@platform/config';
import { DispatcherService } from './dispatcher.service';
import type { OpsAlertsService } from './ops-alerts.service';
import type { EmailService } from './email.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * When the dispatcher touches the database.
 *
 * The point is what it does NOT do: poll. A hosted database that sleeps when
 * idle is only free if nothing wakes it, so delivery has to be prompted by
 * events rather than by a timer checking every few seconds.
 */

const HOUR = 60 * 60 * 1000;

function makeService(interval: number) {
  const service = new DispatcherService(
    {} as PrismaService,
    {} as EmailService,
    { DISPATCH_INTERVAL_SECONDS: interval } as ServerEnv,
    { report: () => undefined } as unknown as OpsAlertsService,
  );
  const drain = vi.spyOn(service, 'drain').mockResolvedValue(0);

  return { service, drain };
}

describe('DispatcherService scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drains once at startup, then leaves the database alone', async () => {
    const { service, drain } = makeService(3600);

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drain).toHaveBeenCalledTimes(1);

    // A whole idle hour: no polling at all. The hourly fallback lives in the
    // sweep, not here.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(drain).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
  });

  it('delivers about a second after an event, and again as a safety net', async () => {
    const { service, drain } = makeService(3600);

    service.nudge();

    await vi.advanceTimersByTimeAsync(999);
    expect(drain).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(1);

    // The second pass catches an event whose transaction committed slowly.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(drain).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst into one quick pass', async () => {
    const { service, drain } = makeService(3600);

    for (let i = 0; i < 10; i++) {
      service.nudge();
      await vi.advanceTimersByTimeAsync(200);
    }

    // Ten nudges over two seconds: the quick pass kept moving back, so it has
    // run once, a second after the last one.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('does not let steady activity postpone delivery past about five seconds', async () => {
    const { service, drain } = makeService(3600);

    // A nudge every half second, for eight seconds. Without the cap the quick
    // pass would be pushed back forever and nothing would arrive until the
    // activity stopped.
    for (let i = 0; i < 16; i++) {
      service.nudge();
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(drain.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('does nothing at all when background delivery is switched off', async () => {
    const { service, drain } = makeService(0);

    service.onModuleInit();
    service.nudge();
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(drain).not.toHaveBeenCalled();
  });
});
