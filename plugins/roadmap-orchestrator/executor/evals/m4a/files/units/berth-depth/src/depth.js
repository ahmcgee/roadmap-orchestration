// The depth line of a berth, as the office tells a skipper what her boat will sit in.
import { berth } from './registers.js';

/** `<berth>: up to <draught> m draught` for berth `id`. */
export function depthLine(id) {
  return `${id}: up to ${berth(id).maxDraught.toFixed(1)} m draught`;
}
