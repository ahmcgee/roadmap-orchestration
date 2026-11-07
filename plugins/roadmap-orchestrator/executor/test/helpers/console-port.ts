// Allocate a free explicit test port without ever binding the product default on this host.
import { execFileSync } from 'node:child_process';
export function freeConsolePort(): number {
  return Number(execFileSync(process.execPath, ['-e', "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>{if(p===4747)process.exit(1);process.stdout.write(String(p))})})"], { encoding: 'utf8' }));
}
