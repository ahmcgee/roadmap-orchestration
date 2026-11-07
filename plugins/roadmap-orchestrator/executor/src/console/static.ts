import type { IncomingMessage, ServerResponse } from 'node:http';
/** Phase 3 installs the explicit content-hashed asset manifest here. */
export async function staticResponse(_path: string, _req: IncomingMessage, _res: ServerResponse): Promise<boolean> { return false; }
