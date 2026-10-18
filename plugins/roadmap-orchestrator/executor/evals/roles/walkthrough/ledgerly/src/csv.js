// The import format (design/cli.md): a header line, then one entry per line. Fields never contain commas or quotes.
import { InputError } from './errors.js';

export const CSV_COLUMNS = ['team', 'month', 'vendor', 'amount', 'note'];

/** The rows of `text` (read from `file`), each with its line number; an InputError naming the line otherwise. */
export function parseCsv(text, file) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.trim()).join(',');
  if (header !== CSV_COLUMNS.join(',')) {
    throw new InputError(`${file}:1: the header must be "${CSV_COLUMNS.join(',')}", got "${lines[0]}"`);
  }
  const rows = [];
  lines.slice(1).forEach((raw, i) => {
    const line = i + 2;
    if (raw.trim() === '') return;
    const cells = raw.split(',').map((c) => c.trim());
    if (cells.length !== CSV_COLUMNS.length) {
      throw new InputError(`${file}:${line}: expected ${CSV_COLUMNS.length} fields (${CSV_COLUMNS.join(', ')}), got ${cells.length}; a note cannot contain a comma`);
    }
    rows.push({ line, ...Object.fromEntries(CSV_COLUMNS.map((c, k) => [c, cells[k]])) });
  });
  if (rows.length === 0) throw new InputError(`${file}: no entries after the header`);
  return rows;
}
