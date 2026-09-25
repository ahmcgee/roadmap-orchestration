// argv: <portFile>. Listens on 127.0.0.1 (an external resource), writes the port to <portFile>, runs until killed.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const portFile = process.argv[2];
if (portFile === undefined) throw new Error('usage: workload-listen <portFile>');
const server = createServer((socket) => socket.end('held\n'));
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`unexpected address ${JSON.stringify(address)}`);
  writeFileSync(portFile, String(address.port));
});
