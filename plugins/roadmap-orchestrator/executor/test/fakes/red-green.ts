// A lane script that fails the first run and passes every later one; the state is a marker file.
// argv: <markerFile> [<red output>]. First run: creates the marker, prints the red output to stderr, exits 1.
import { writeFileSync } from 'node:fs';

const [marker, text] = process.argv.slice(2);
if (marker === undefined) throw new Error(`usage: red-green <markerFile> [<red output>], got ${JSON.stringify(process.argv.slice(2))}`);
try {
  writeFileSync(marker, 'red\n', { flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  process.stdout.write('green\n');
  process.exit(0);
}
process.stderr.write(`${text ?? 'red'}\n`);
process.exit(1);
