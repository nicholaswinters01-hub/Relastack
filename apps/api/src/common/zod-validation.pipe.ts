import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

export interface ValidationErrorDetail {
  field: string;
  message: string;
}

/**
 * Validates a request payload against a Zod schema.
 *
 * This is the pipe promised in Phase 0, when Nest's built-in ValidationPipe
 * was removed. That pipe requires class-validator, which would have meant
 * defining every rule twice — once as a decorated class for the server, once
 * as a schema for the web client — and inevitably letting the two drift.
 *
 * Instead, one schema in @platform/shared serves both sides.
 *
 * Zod also *transforms* while validating (trimming, lowercasing email), so the
 * handler receives normalised data and never has to remember to normalise.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const errors: ValidationErrorDetail[] = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      }));

      // Every problem at once. Returning only the first means a user with
      // three bad fields fixes them one submission at a time.
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors,
      });
    }

    return result.data;
  }
}
