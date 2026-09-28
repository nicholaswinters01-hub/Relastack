import type { CustomFieldDefinition } from '@platform/shared';
import { describe, expect, it } from 'vitest';
import { analyzeImport, phoneKey, type ImportContext } from './customer-import';

/**
 * The row checks behind customer import. Every rule a spreadsheet can trip,
 * without a database: the service runs this same function for the preview and
 * again for the import.
 */

const base: ImportContext = {
  stage: 'ACTIVE',
  locationId: null,
  canChooseNumbers: true,
  existing: [],
  definitions: [],
};

const definition = (overrides: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  id: '00000000-0000-4000-8000-000000000001',
  key: 'field',
  label: 'Field',
  type: 'TEXT',
  options: [],
  isRequired: false,
  position: 0,
  archivedAt: null,
  ...overrides,
});

describe('analyzeImport', () => {
  it('accepts a person, and a company with no person named', () => {
    const { results, ready } = analyzeImport(
      [{ firstName: 'Dana', lastName: 'Diaz' }, { companyName: 'Maple Street HOA' }],
      base,
    );

    expect(results.map((r) => r.status)).toEqual(['ready', 'ready']);
    expect(ready[0]!.data.type).toBe('PERSON');
    expect(ready[1]!.data.type).toBe('COMPANY');
  });

  it('refuses a row with no name at all, saying why', () => {
    const { results } = analyzeImport([{ email: 'nobody@example.test' }], base);

    expect(results[0]!.status).toBe('invalid');
    expect(results[0]!.errors[0]).toMatch(/No name/);
  });

  it('refuses a bad email with the same message as the form', () => {
    const { results } = analyzeImport([{ firstName: 'Ed', email: 'not-an-email' }], base);

    expect(results[0]!.errors).toContain('Enter a valid email address');
  });

  it('treats blank cells as empty, not as values', () => {
    const { ready } = analyzeImport([{ firstName: 'Ann', email: '   ', city: '' }], base);

    expect(ready[0]!.data.email).toBeUndefined();
    expect(ready[0]!.data.city).toBeUndefined();
  });

  it('skips a customer who already exists, matched by email or by phone digits', () => {
    const existing = [
      {
        id: 'c1',
        displayName: 'Dana',
        accountNumber: 1001,
        email: 'Dana@Example.test',
        phone: null,
      },
      { id: 'c2', displayName: 'Nils', accountNumber: 1002, email: null, phone: '(813) 555-0142' },
    ];

    const { results, ready } = analyzeImport(
      [
        { firstName: 'Dana', email: 'dana@example.test' },
        { firstName: 'Nils', phone: '+1 813.555.0142' },
        { firstName: 'New', phone: '813-555-0199' },
      ],
      { ...base, existing },
    );

    expect(results.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'ready']);
    expect(results[0]!.duplicateOf).toMatchObject({ customerId: 'c1', accountNumber: 1001 });
    expect(results[1]!.duplicateOf).toMatchObject({ customerId: 'c2' });
    expect(ready).toHaveLength(1);
  });

  it('imports someone listed twice in the same file once', () => {
    const { results } = analyzeImport(
      [
        { firstName: 'Twin', email: 'twin@example.test' },
        { firstName: 'Twin again', email: 'TWIN@example.test' },
      ],
      base,
    );

    expect(results.map((r) => r.status)).toEqual(['ready', 'duplicate']);
    expect(results[1]!.duplicateOf?.row).toBe(1);
  });

  it('keeps old account numbers for an owner, and refuses clashes', () => {
    const { results, ready } = analyzeImport(
      [
        { firstName: 'Kept', accountNumber: '#512' },
        { firstName: 'Clash', accountNumber: '1001' },
        { firstName: 'Twice', accountNumber: '512' },
        { firstName: 'Nonsense', accountNumber: '12a' },
      ],
      {
        ...base,
        existing: [{ id: 'c1', displayName: 'X', accountNumber: 1001, email: null, phone: null }],
      },
    );

    expect(ready[0]!.accountNumber).toBe(512);
    expect(results[1]!.errors[0]).toMatch(/#1001 is already in use/);
    expect(results[2]!.errors[0]).toMatch(/also on row 1/);
    expect(results[3]!.errors[0]).toMatch(/isn't a whole number/);
  });

  it('refuses account numbers from anyone who is not an owner', () => {
    const { results } = analyzeImport([{ firstName: 'Kept', accountNumber: '512' }], {
      ...base,
      canChooseNumbers: false,
    });

    expect(results[0]!.errors[0]).toMatch(/Only an owner/);
  });

  it('converts custom field text to numbers, yes/no and choices before checking', () => {
    const definitions = [
      definition({ key: 'lot', label: 'Lot size', type: 'NUMBER' }),
      definition({ key: 'gate', label: 'Gate code on file', type: 'BOOLEAN' }),
      definition({ key: 'tier', label: 'Tier', type: 'SELECT', options: ['Gold', 'Silver'] }),
    ];

    const { ready } = analyzeImport(
      [{ firstName: 'Cam', customFields: { lot: '1,200', gate: 'Yes', tier: 'gold' } }],
      { ...base, definitions },
    );

    expect(ready[0]!.customFields).toEqual({ lot: 1200, gate: true, tier: 'Gold' });
  });

  it('holds imports to required custom fields, like the form does', () => {
    const { results } = analyzeImport([{ firstName: 'Cam' }], {
      ...base,
      definitions: [definition({ key: 'gate', label: 'Gate code', isRequired: true })],
    });

    expect(results[0]!.status).toBe('invalid');
  });
});

describe('phoneKey', () => {
  it('matches the same number however it is written, and ignores short fragments', () => {
    expect(phoneKey('(813) 555-0142')).toBe(phoneKey('+1 813 555 0142'));
    expect(phoneKey('555')).toBeNull();
  });
});
