// argv: <file> <iterations>. Reads the file repeatedly while another process replaces it with
// durableWrite. Every read must be one complete version: all 'A' or all 'B' at the full length.
// Prints `{"a":n,"b":n}` and exits 0, or exits 1 naming the first torn read.
import { readFileSync } from 'node:fs';

const [file, iterations] = process.argv.slice(2);
if (file === undefined || iterations === undefined) {
  throw new Error(`usage: reader-child <file> <iterations>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const expectedLength = 256 * 1024;
const pause = new Int32Array(new SharedArrayBuffer(4));
const seen = { a: 0, b: 0 };
for (let i = 0; i < Number(iterations); i++) {
  const text = readFileSync(file, 'latin1');
  if (text.length === expectedLength && !/[^A]/.test(text)) seen.a++;
  else if (text.length === expectedLength && !/[^B]/.test(text)) seen.b++;
  else {
    process.stderr.write(`torn read at iteration ${i}: length ${text.length}, head ${JSON.stringify(text.slice(0, 8))}\n`);
    process.exit(1);
  }
  Atomics.wait(pause, 0, 0, 1);
}
process.stdout.write(`${JSON.stringify(seen)}\n`);
