import {
  ACCOUNT_NUMBER_MAX,
  buildCustomFieldSchema,
  createCustomerRequestSchema,
  type CreateCustomerRequest,
  type CustomFieldDefinition,
  type CustomFieldValues,
  type ImportRow,
  type ImportRowResult,
} from '@platform/shared';

/**
 * Checking a spreadsheet of customers, row by row, before anything is saved.
 *
 * Pure: everything it needs is passed in, so every rule here is unit-tested
 * without a database. The service runs it for the preview, and again for the
 * import itself, since the server never trusts a preview the browser holds.
 */

export interface ExistingCustomer {
  id: string;
  displayName: string;
  accountNumber: number | null;
  email: string | null;
  phone: string | null;
}

export interface ImportContext {
  stage: 'ACTIVE' | 'LEAD';
  locationId: string | null;
  /** Only an owner may keep numbers from an old system. */
  canChooseNumbers: boolean;
  existing: ExistingCustomer[];
  definitions: CustomFieldDefinition[];
}

export interface ReadyRow {
  index: number;
  data: CreateCustomerRequest;
  accountNumber: number | null;
  customFields: CustomFieldValues;
  note: string | null;
}

export interface ImportAnalysis {
  results: ImportRowResult[];
  ready: ReadyRow[];
}

const emailKey = (email: string | null | undefined) => email?.trim().toLowerCase() || null;

/**
 * The last ten digits: "(813) 555-0142", "813.555.0142" and "+1 813 555 0142"
 * are the same phone. Fewer than seven digits is not a number worth matching on.
 */
export const phoneKey = (phone: string | null | undefined): string | null => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
};

const blank = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

const YES = new Set(['yes', 'y', 'true', '1', 'x']);
const NO = new Set(['no', 'n', 'false', '0']);

/**
 * A spreadsheet holds text; custom fields hold numbers, yes/no, dates and
 * choices. Converted here so the same validation as the form can judge them.
 * Anything unconvertible is passed through as text, and the validation says
 * what is wrong with it.
 */
function typedCustomFields(
  raw: Record<string, string> | undefined,
  definitions: CustomFieldDefinition[],
): CustomFieldValues {
  const values: CustomFieldValues = {};
  for (const definition of definitions) {
    const text = raw?.[definition.key]?.trim();
    if (!text) continue;

    switch (definition.type) {
      case 'NUMBER': {
        const number = Number(text.replace(/[$,\s]/g, ''));
        values[definition.key] = Number.isFinite(number) ? number : text;
        break;
      }
      case 'BOOLEAN': {
        const lower = text.toLowerCase();
        values[definition.key] = YES.has(lower) ? true : NO.has(lower) ? false : text;
        break;
      }
      case 'SELECT': {
        // "gold" in the file still means the choice "Gold".
        const match = definition.options.find(
          (option) => option.toLowerCase() === text.toLowerCase(),
        );
        values[definition.key] = match ?? text;
        break;
      }
      default:
        values[definition.key] = text;
    }
  }
  return values;
}

export function analyzeImport(rows: ImportRow[], context: ImportContext): ImportAnalysis {
  const byEmail = new Map<string, ExistingCustomer>();
  const byPhone = new Map<string, ExistingCustomer>();
  const numbersInUse = new Set<number>();
  for (const customer of context.existing) {
    const email = emailKey(customer.email);
    const phone = phoneKey(customer.phone);
    if (email && !byEmail.has(email)) byEmail.set(email, customer);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, customer);
    if (customer.accountNumber !== null) numbersInUse.add(customer.accountNumber);
  }

  // Earlier rows of this same file, so a list with a person twice imports them once.
  const seenEmail = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  const seenNumber = new Map<number, number>();

  const customFieldSchema =
    context.definitions.length > 0 ? buildCustomFieldSchema(context.definitions) : null;

  const results: ImportRowResult[] = [];
  const ready: ReadyRow[] = [];

  rows.forEach((row, index) => {
    const errors: string[] = [];
    const companyName = blank(row.companyName);
    const firstName = blank(row.firstName);
    const lastName = blank(row.lastName);

    // A company name with no person's name is a company; anything else a person.
    const type = companyName && !firstName && !lastName ? 'COMPANY' : 'PERSON';

    const parsed = createCustomerRequestSchema.safeParse({
      type,
      stage: context.stage,
      locationId: context.locationId,
      companyName,
      firstName,
      lastName,
      email: blank(row.email),
      phone: blank(row.phone),
      addressLine1: blank(row.addressLine1),
      addressLine2: blank(row.addressLine2),
      city: blank(row.city),
      region: blank(row.region),
      postalCode: blank(row.postalCode),
      country: blank(row.country),
      source: blank(row.source),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(
          issue.path[0] === 'firstName' && issue.message === 'A customer needs a name'
            ? 'No name: needs a first or last name, or a company name'
            : issue.message,
        );
      }
    }

    let accountNumber: number | null = null;
    const numberText = blank(row.accountNumber)?.replace(/^#/, '');
    if (numberText !== undefined) {
      if (!context.canChooseNumbers) {
        errors.push('Only an owner can keep account numbers from another system');
      } else if (
        !/^\d{1,8}$/.test(numberText) ||
        Number(numberText) < 1 ||
        Number(numberText) > ACCOUNT_NUMBER_MAX
      ) {
        errors.push(
          `Account number "${blank(row.accountNumber)}" isn't a whole number from 1 to ${ACCOUNT_NUMBER_MAX}`,
        );
      } else {
        accountNumber = Number(numberText);
        if (numbersInUse.has(accountNumber)) {
          errors.push(`Account #${accountNumber} is already in use`);
        } else if (seenNumber.has(accountNumber)) {
          errors.push(
            `Account #${accountNumber} is also on row ${seenNumber.get(accountNumber)! + 1}`,
          );
        }
      }
    }

    let customFields: CustomFieldValues = {};
    if (customFieldSchema) {
      const checked = customFieldSchema.safeParse(
        typedCustomFields(row.customFields, context.definitions),
      );
      if (checked.success) customFields = checked.data;
      else errors.push(...checked.error.issues.map((issue) => issue.message));
    }

    const note = blank(row.note) ?? null;

    if (errors.length > 0) {
      results.push({ index, status: 'invalid', errors, duplicateOf: null });
      return;
    }

    const data = parsed.data!;
    const email = emailKey(data.email);
    const phone = phoneKey(data.phone);

    const existing =
      (email !== null ? byEmail.get(email) : undefined) ??
      (phone !== null ? byPhone.get(phone) : undefined);
    if (existing) {
      results.push({
        index,
        status: 'duplicate',
        errors: [],
        duplicateOf: {
          customerId: existing.id,
          displayName: existing.displayName,
          accountNumber: existing.accountNumber,
          row: null,
        },
      });
      return;
    }

    const earlier =
      (email !== null ? seenEmail.get(email) : undefined) ??
      (phone !== null ? seenPhone.get(phone) : undefined);
    if (earlier !== undefined) {
      results.push({
        index,
        status: 'duplicate',
        errors: [],
        duplicateOf: { customerId: null, displayName: '', accountNumber: null, row: earlier + 1 },
      });
      return;
    }

    if (email) seenEmail.set(email, index);
    if (phone) seenPhone.set(phone, index);
    if (accountNumber !== null) seenNumber.set(accountNumber, index);

    results.push({ index, status: 'ready', errors: [], duplicateOf: null });
    ready.push({ index, data, accountNumber, customFields, note });
  });

  return { results, ready };
}
