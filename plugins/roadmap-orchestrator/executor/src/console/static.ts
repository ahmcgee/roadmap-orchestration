import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { sha256Hex } from '../core/json.ts';
import { CONSOLE_PROTOCOL } from '../observation/protocol.ts';
import { readEvidence } from './evidence.ts';

const root = fileURLToPath(new URL('../../web/', import.meta.url));
const FILES = ['app.js', 'app.css', 'vendor/react.production.min.js', 'vendor/react-dom.production.min.js', 'vendor/bundle.js', 'vendor/bundle.css', 'vendor/tokens.css',
  'vendor/fonts/space-grotesk.woff2', 'vendor/fonts/spectral-400.woff2', 'vendor/fonts/spectral-500.woff2', 'vendor/fonts/spectral-italic-400.woff2', 'vendor/fonts/ibm-plex-mono-400.woff2'] as const;
const ASSETS = FILES.map((name) => ({ name, bytes: readEvidence(root, join(root, name)) }));
const digest = sha256Hex(ASSETS.map((f) => `${f.name}:${sha256Hex(f.bytes)}`).join('\n'));
export const ASSET_ROOT = `/assets/${digest}`;
const MANIFEST = new Map(ASSETS.map((f) => [`${ASSET_ROOT}/${f.name}`, f]));
const TYPES: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };
export async function staticResponse(path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (path === '/') {
    const html = readEvidence(root, join(root, 'index.html')).toString('utf8').replaceAll('__ASSET_ROOT__', ASSET_ROOT).replaceAll('__PROTOCOL__', CONSOLE_PROTOCOL);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : html); return true;
  }
  const name = MANIFEST.get(path);
  if (!name) return false;
  const bytes = name.bytes;
  res.writeHead(200, { 'content-type': TYPES[extname(name.name)]!, 'content-length': bytes.length, 'cache-control': 'public, max-age=31536000, immutable', etag: `"${sha256Hex(bytes)}"` });
  res.end(req.method === 'HEAD' ? undefined : bytes); return true;
}
