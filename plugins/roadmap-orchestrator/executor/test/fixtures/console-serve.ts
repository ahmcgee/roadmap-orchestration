// Test-only: a console in its own process (so its RSS is its own), driven over IPC: `stats` answers server.stats(arc).
import { serveConsole } from '../../src/console/http.ts';
const s = await serveConsole(JSON.parse(process.argv[2]!));
process.send!({ kind: 'ready', url: s.url });
process.on('message', (m: { kind: string; id: number; arc: string }) => { if (m.kind === 'stats') process.send!({ kind: 'stats', id: m.id, value: s.stats(m.arc) }); });
process.on('disconnect', () => { void s.close().then(() => process.exit()); });
