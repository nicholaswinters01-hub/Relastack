/**
 * One CSV cell. Quoted when it must be, and a leading = + - @ is defused so a
 * spreadsheet never runs something a customer name smuggled in as a formula.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A whole file: a header row, then one row per record, with Excel's line endings. */
export function csvFile(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
