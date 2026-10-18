// The shelf's books live in one JSON file: `{ "books": [{ id, title, author, condition, arrived, reservedBy }] }`.
// `reservedBy` is a neighbour's first name, or null while the book is free. Every write replaces the file atomically.
import { readFile, rename, writeFile } from 'node:fs/promises';

export const DEFAULT_DATA = 'data/shelf.json';

export async function loadShelf(path) {
  const shelf = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(shelf.books)) throw new Error(`${path}: no books array`);
  return shelf;
}

export async function saveShelf(path, shelf) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(shelf, null, 2)}\n`);
  await rename(tmp, path);
}
