/**
 * Reading a CSV file exported from Excel, Google Sheets, or another system.
 *
 * Small on purpose, instead of a dependency: quoted cells, commas and line
 * breaks inside quotes, doubled quotes, Windows line endings, the byte-order
 * mark Excel adds, and semicolon-separated files from Excel set to a European
 * locale. Blank lines are dropped.
 */
export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  const count = (char: string) => firstLine.split(char).length - 1;
  const candidates: Array<',' | ';' | '\t'> = [',', ';', '\t'];
  return candidates.reduce((best, char) => (count(char) > count(best) ? char : best), ',');
}

export function parseCsv(input: string): ParsedCsv {
  // The byte-order mark Excel puts at the start of a UTF-8 file.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);

  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }

  const nonBlank = records.filter((r) => r.some((value) => value.trim() !== ''));
  const [headers = [], ...rows] = nonBlank;
  return { headers: headers.map((h) => h.trim()), rows };
}

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Common header spellings, so most columns match themselves. */
const ALIASES: Record<string, string[]> = {
  // A single "Name" column goes here too: "John Smith" displays as one name.
  firstName: [
    'firstname',
    'first',
    'fname',
    'givenname',
    'contactfirstname',
    'name',
    'fullname',
    'customername',
    'customer',
    'contact',
    'contactname',
    'clientname',
  ],
  lastName: ['lastname', 'last', 'lname', 'surname', 'familyname', 'contactlastname'],
  companyName: [
    'company',
    'companyname',
    'business',
    'businessname',
    'organization',
    'organisation',
  ],
  email: ['email', 'emailaddress', 'mail', 'eemail'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'cellphone', 'telephone', 'tel', 'mainphone'],
  addressLine1: [
    'address',
    'address1',
    'addressline1',
    'street',
    'streetaddress',
    'serviceaddress',
  ],
  addressLine2: ['address2', 'addressline2', 'unit', 'suite', 'apt'],
  city: ['city', 'town'],
  region: ['state', 'region', 'province', 'st'],
  postalCode: ['zip', 'zipcode', 'postalcode', 'postcode', 'postal'],
  country: ['country'],
  source: ['source', 'leadsource', 'referral', 'referredby'],
  accountNumber: [
    'account',
    'accountnumber',
    'acct',
    'acctno',
    'accountno',
    'customernumber',
    'customerid',
    'custno',
  ],
  note: ['note', 'notes', 'comment', 'comments', 'memo'],
};

/** Best guess at which field a header means, or null. */
export function guessField(
  header: string,
  customFields: Array<{ key: string; label: string }>,
): string | null {
  const key = normalise(header);
  for (const [field, aliases] of Object.entries(ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  const custom = customFields.find(
    (field) => normalise(field.label) === key || normalise(field.key) === key,
  );
  return custom ? `custom:${custom.key}` : null;
}
