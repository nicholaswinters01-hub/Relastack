import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import { SERVER_ENV } from '../config.provider';
import { EmailService } from './email.service';

/** At most one alert email per window; anything later waits and goes as one digest. */
export const ALERT_WINDOW_MS = 15 * 60_000;
/** Listed in one email. Past this a count is enough: the logs have the rest. */
const MAX_LISTED = 20;

export interface Incident {
  /** Where: a route pattern such as "GET /api/v1/customers/:id", or background work. */
  where: string;
  /** What kind of failure: the error's class, and a database code if it has one. Never its message. */
  what: string;
  /** Matches the log line, and what a person quotes to the help desk. */
  reference?: string;
}

/** The class of an error and any code it carries, without its message. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.constructor.name} ${code}` : error.constructor.name;
}

/**
 * Tells whoever runs RelaStack that something broke, before a participant
 * has to.
 *
 * Only unexpected failures come here: a crash in a request, background work
 * that failed, a message that gave up retrying. Refusals and validation
 * errors are the system working, and a provider being down already has its
 * own answer.
 *
 * The email names where and what, never an error's message or a request's
 * contents, which can carry a business's customer data. The stack trace is in
 * the logs under the same reference.
 *
 * Throttled so a failure on every request cannot flood an inbox: the first
 * goes at once, the rest wait for the window and go together. Kept in memory,
 * which is enough while background work runs as a single instance.
 */
@Injectable()
export class OpsAlertsService implements OnModuleDestroy {
  private readonly logger = new Logger(OpsAlertsService.name);
  private pending: Array<Incident & { at: Date }> = [];
  private unlisted = 0;
  private lastSentAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly email: EmailService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  report(incident: Incident): void {
    if (this.pending.length < MAX_LISTED) this.pending.push({ ...incident, at: new Date() });
    else this.unlisted += 1;

    const wait = this.lastSentAt + ALERT_WINDOW_MS - Date.now();
    if (wait <= 0) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, wait);
      this.timer.unref?.();
    }
  }

  /** Sends whatever is waiting. Never throws: an alert that fails must not fail anything else. */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const incidents = this.pending;
    const unlisted = this.unlisted;
    this.pending = [];
    this.unlisted = 0;
    this.lastSentAt = Date.now();

    const total = incidents.length + unlisted;
    const lines = incidents.map(
      (incident) =>
        `${incident.at.toISOString()}  ${incident.where}  ${incident.what}` +
        (incident.reference ? `  ref ${incident.reference}` : ''),
    );
    if (unlisted > 0) lines.push(`…and ${unlisted} more.`);

    try {
      await this.email.send({
        to: this.env.SUPPORT_NOTIFY_EMAIL,
        subject: `RelaStack: ${total} ${total === 1 ? 'error' : 'errors'} in production`,
        body: [
          `Something failed that should not have. Search the API logs on Render for each reference to see the full error.`,
          '',
          ...lines,
          '',
          `Further errors in the next ${ALERT_WINDOW_MS / 60_000} minutes will arrive together in one email.`,
        ].join('\n'),
      });
    } catch (error) {
      this.logger.error(`Could not send an error alert: ${describeError(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }
}
