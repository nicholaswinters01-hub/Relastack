import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import { SERVER_ENV } from '../config.provider';

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. Deliberately not HTML — see the note below. */
  body: string;
  /** Where the message wants the reader to go, rendered as a bare URL. */
  link?: string;
}

/**
 * Outbound email.
 *
 * An adapter over the provider, the same shape as billing and the waitlist:
 * whichever service sends mail today will not be the one sending it in two
 * years, and every quirk stays behind this interface.
 *
 * **Plain text, on purpose.** HTML email means a rendering pipeline, inlined
 * CSS, dark-mode handling and a decade of client bugs, none of which makes a
 * "you have been assigned a task" message land better. A short plain message
 * is also far less likely to be filtered. When marketing email arrives it can
 * bring its own renderer; this is transactional.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(@Inject(SERVER_ENV) private readonly env: ServerEnv) {}

  /**
   * The footer every message carries.
   *
   * CAN-SPAM requires a physical postal address on commercial email in the US,
   * which is the market. Built here rather than in each template so it is
   * impossible to send something that quietly omits it.
   */
  private footer(): string {
    const lines = [`${this.env.APP_URL}/account — change what you are emailed about`];

    if (this.env.EMAIL_POSTAL_ADDRESS) lines.push(this.env.EMAIL_POSTAL_ADDRESS);

    return lines.join('\n');
  }

  private render(message: EmailMessage): string {
    return [message.body, message.link ? `\n${message.link}` : '', '\n—\n', this.footer()]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Sends, or throws.
   *
   * Throwing matters: the caller is the outbox dispatcher, and a thrown error
   * is what makes the event retry rather than being marked done with nothing
   * delivered.
   */
  async send(message: EmailMessage): Promise<void> {
    const text = this.render(message);

    if (this.env.EMAIL_PROVIDER === 'log') {
      // Not a no-op. A misconfigured deployment writes the message somewhere
      // recoverable rather than losing it, and local development needs no
      // account at all.
      this.logger.log(`[email] to=${message.to} subject=${message.subject}\n${text}`);
      return;
    }

    if (!this.env.EMAIL_API_KEY) {
      throw new Error(
        `EMAIL_PROVIDER is "${this.env.EMAIL_PROVIDER}" but EMAIL_API_KEY is not set`,
      );
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.EMAIL_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend responded ${response.status}: ${await response.text()}`);
    }
  }
}
