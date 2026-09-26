// argv: <code>. Writes "out\n" to stdout, "err\n" to stderr, echoes stdin to stdout, then exits with <code>.
import { readFileSync } from 'node:fs';

const code = Number(process.argv[2]);
process.stdout.write('out\n');
process.stderr.write('err\n');
process.stdout.write(readFileSync(0));
process.exitCode = code;
