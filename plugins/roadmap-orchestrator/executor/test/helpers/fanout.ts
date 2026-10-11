// How many cells at once a crash matrix runs. The matrices run in the serial tier (one file at a time), so they size
// from the host, not from a constant.
import { availableParallelism } from 'node:os';

/**
 * Three quarters of the host's cpus. A matrix cell is a supervised run: a handful of short-lived processes, mostly
 * waiting on polls and the supervisor's backoff. Measured alone on 16 cpus, the whole-pipeline matrix took 818 s at
 * 12 cells and 796 s at 16, with a 1-min load of about 17 against 20 (about 5 of either from outside the suite):
 * past three quarters, more cells only add load.
 */
export const FANOUT = Math.max(1, Math.floor((availableParallelism() * 3) / 4));
