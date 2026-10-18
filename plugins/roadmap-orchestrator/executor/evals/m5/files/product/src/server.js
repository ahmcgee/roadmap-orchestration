// The shelf's web server: zero dependencies, pages rendered on the server, no client-side JavaScript.
// `PORT` (default 3000) and `SWAPSHELF_DATA` (default data/shelf.json) configure it; it listens on 127.0.0.1.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { notFoundPage, shelfPage } from './pages.js';
import { DEFAULT_DATA, loadShelf } from './store.js';

const PUBLIC = new URL('../public/', import.meta.url);

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

export function createApp({ dataPath }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', shelfPage(await loadShelf(dataPath)));
      if (req.method === 'GET' && url.pathname === '/style.css') return send(res, 200, 'text/css; charset=utf-8', await readFile(new URL('style.css', PUBLIC)));
      return send(res, 404, 'text/html; charset=utf-8', notFoundPage());
    } catch (error) {
      console.error(error);
      return send(res, 500, 'text/plain; charset=utf-8', 'Something went wrong on our side. Try again in a minute.\n');
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createApp({ dataPath: process.env.SWAPSHELF_DATA ?? DEFAULT_DATA });
  server.listen(port, '127.0.0.1', () => console.log(`swapshelf listening on http://127.0.0.1:${server.address().port}/`));
}
