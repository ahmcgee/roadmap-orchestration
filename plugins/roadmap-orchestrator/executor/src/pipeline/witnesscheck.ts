// Witness presence before the gate (M4a rev 3, D1; corpus arcs, LR-h): after a green certified spec series, the unit's
// required arc lanes run once at the salvage SHA as a journey series in their own checkout (`witnessWorktree`), and any
// missing or failed required id is `witnesses-missing` (a fix round, no gate call). The lane files the build's
// `witness-check` commands read are published here before the build call (`WITNESS_FILES`).
// PLACEHOLDER (step N0, H3): step N3 replaces this module in place.
import { notYet } from '../core/notyet.ts';

export function witnessPresence(): never {
  return notYet('witness presence (D1)', 'N3');
}
