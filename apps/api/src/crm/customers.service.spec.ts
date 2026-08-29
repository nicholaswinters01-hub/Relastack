import { describe, expect, it } from 'vitest';
import { buildCustomFieldSchema, type CustomFieldDefinition } from '@platform/shared';
import { CustomersService } from './customers.service';

/**
 * The pure parts of the CRM: how a customer gets its display name, and how
 * one organization's custom field definitions turn into a validator.
 *
 * Both are easy to get subtly wrong and cheap to test without a database.
 */

const field = (overrides: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  id: '11111111-1111-4111-8111-111111111111',
  key: 'gate_code',
  label: 'Gate code',
  type: 'TEXT',
  options: [],
  isRequired: false,
  position: 0,
  archivedAt: null,
  ...overrides,
});

describe('displayName', () => {
  it('uses the company name for a company', () => {
    expect(
      CustomersService.displayNameFor({
        type: 'COMPANY',
        companyName: 'Acme Property Group',
        firstName: 'Dana',
        lastName: 'Reed',
      }),
    ).toBe('Acme Property Group');
  });

  it('joins the person name for a person', () => {
    expect(
      CustomersService.displayNameFor({ type: 'PERSON', firstName: 'Dana', lastName: 'Reed' }),
    ).toBe('Dana Reed');
  });

  it('copes with only one half of a name', () => {
    // A lead phoned in as "Dana, no surname given" must still be storable.
    expect(CustomersService.displayNameFor({ type: 'PERSON', firstName: 'Dana' })).toBe('Dana');
    expect(CustomersService.displayNameFor({ type: 'PERSON', lastName: 'Reed' })).toBe('Reed');
  });

  it('returns empty when there is nothing to show', () => {
    // The caller turns this into a validation error rather than storing a
    // blank row that no list can render.
    expect(CustomersService.displayNameFor({ type: 'PERSON' })).toBe('');
    expect(CustomersService.displayNameFor({ type: 'COMPANY' })).toBe('');
  });

  it('does not leave stray whitespace when a part is blank', () => {
    expect(
      CustomersService.displayNameFor({ type: 'PERSON', firstName: 'Dana', lastName: '  ' }),
    ).toBe('Dana');
  });
});

describe('custom field validation', () => {
  it('accepts a value of the declared type', () => {
    const schema = buildCustomFieldSchema([field({ key: 'visits', type: 'NUMBER' })]);

    expect(schema.safeParse({ visits: 3 }).success).toBe(true);
  });

  it('rejects a value of the wrong type', () => {
    const schema = buildCustomFieldSchema([field({ key: 'visits', type: 'NUMBER' })]);

    const result = schema.safeParse({ visits: 'three' });

    expect(result.success).toBe(false);
  });

  it('restricts a choice field to its options', () => {
    const schema = buildCustomFieldSchema([
      field({ key: 'tier', type: 'SELECT', options: ['Bronze', 'Silver'] }),
    ]);

    expect(schema.safeParse({ tier: 'Silver' }).success).toBe(true);
    expect(schema.safeParse({ tier: 'Platinum' }).success).toBe(false);
  });

  it('requires a required field', () => {
    const schema = buildCustomFieldSchema([field({ key: 'gate_code', isRequired: true })]);

    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ gate_code: '1234' }).success).toBe(true);
  });

  it('allows an optional field to be absent or null', () => {
    const schema = buildCustomFieldSchema([field({ key: 'gate_code' })]);

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ gate_code: null }).success).toBe(true);
  });

  it('ignores an archived definition', () => {
    const schema = buildCustomFieldSchema([
      field({ key: 'old_field', isRequired: true, archivedAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    // A retired field must not start failing every save because it was once
    // required.
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('strips an unknown key rather than failing the save', () => {
    const schema = buildCustomFieldSchema([field({ key: 'gate_code' })]);

    const result = schema.safeParse({ gate_code: '1234', retired_field: 'x' });

    // A field archived between the form rendering and the form submitting
    // would otherwise fail a save the user cannot fix.
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ gate_code: '1234' });
  });

  it('accepts anything when no fields are defined', () => {
    expect(buildCustomFieldSchema([]).safeParse({}).success).toBe(true);
  });

  it('names the field in the message, not the key', () => {
    const schema = buildCustomFieldSchema([
      field({ key: 'visits_last_year', label: 'Visits last year', type: 'NUMBER' }),
    ]);

    const result = schema.safeParse({ visits_last_year: 'lots' });

    // The person filling the form knows the label, not the machine key.
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toContain(
      'Visits last year',
    );
  });

  it('validates a date field is parseable', () => {
    const schema = buildCustomFieldSchema([field({ key: 'renewal', type: 'DATE' })]);

    expect(schema.safeParse({ renewal: '2026-03-01' }).success).toBe(true);
    expect(schema.safeParse({ renewal: 'next tuesday' }).success).toBe(false);
  });
});
