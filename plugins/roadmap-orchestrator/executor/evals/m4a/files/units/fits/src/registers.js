// The harbour's berth register and the vessels that use it (data/berths.json, data/vessels.json).
import { readFileSync } from 'node:fs';
import { TidewaterError } from './errors.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
export const BERTHS = read('berths.json');
export const VESSELS = read('vessels.json');

export function berth(id) {
  const found = BERTHS.find((b) => b.id === id);
  if (found === undefined) throw new TidewaterError(`there is no berth ${id} (berths: ${BERTHS.map((b) => b.id).join(', ')})`);
  return found;
}

export function vessel(name) {
  const found = VESSELS.find((v) => v.name === name);
  if (found === undefined) throw new TidewaterError(`${name} is not a registered vessel`);
  return found;
}

/** The berths whose maximum draught takes a vessel drawing `draught` metres, shallowest first. */
export function berthsFor(draught) {
  if (!(draught > 0)) throw new TidewaterError(`a draught is a positive number of metres, not ${draught}`);
  return BERTHS.filter((b) => b.maxDraught >= draught).sort((a, b) => a.maxDraught - b.maxDraught);
}
