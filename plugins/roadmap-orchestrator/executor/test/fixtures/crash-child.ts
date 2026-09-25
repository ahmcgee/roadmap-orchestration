// Reaches crashPoint('a') three times, printing after each one it survives.
import { crashPoint } from '../../src/core/crash.ts';

for (let i = 1; i <= 3; i++) {
  crashPoint('a');
  process.stdout.write(`passed a ${i}\n`);
}
