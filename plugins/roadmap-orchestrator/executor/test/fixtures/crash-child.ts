// Reaches crashPoint('a') three times, printing after each one it survives. With the argument `units`, each
// round reaches it once for unit u1 and once for u2 (the per-unit selector, G8).
import { crashPoint } from '../../src/core/crash.ts';
import { unitId } from '../../src/core/ids.ts';

const units = process.argv.includes('units');
for (let i = 1; i <= 3; i++) {
  if (!units) {
    crashPoint('a');
    process.stdout.write(`passed a ${i}\n`);
    continue;
  }
  for (const u of ['u1', 'u2']) {
    crashPoint('a', unitId(u));
    process.stdout.write(`passed a ${u} ${i}\n`);
  }
}
