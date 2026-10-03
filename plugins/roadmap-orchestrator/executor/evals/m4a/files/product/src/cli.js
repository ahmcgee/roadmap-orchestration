#!/usr/bin/env node
// tidewater: berth booking for the harbour's tide windows.
//
//   tidewater windows <date>                          the tide windows of a date
//   tidewater berths                                  the berth register
//   tidewater book <vessel> <berth> <date> <hw>       book a berth for the window around high water <hw>
//   tidewater list [<date>]                           the bookings
//   tidewater cancel <booking>                        cancel a booking
//
// A refusal prints `tidewater: <why>` on stderr and exits 2.
import { TidewaterError } from './errors.js';
import { book, cancel, list } from './ledger.js';
import { BERTHS, berth, vessel } from './registers.js';
import { windowOf, windowsFor } from './tides.js';

const out = (line) => process.stdout.write(`${line}\n`);

function usage(expected) {
  throw new TidewaterError(`usage: tidewater ${expected}`);
}

const commands = {
  windows(args) {
    if (args.length !== 1) usage('windows <date>');
    for (const w of windowsFor(args[0])) out(`HW ${w.highWater}  window ${w.opens}-${w.closes}`);
  },
  berths(args) {
    if (args.length !== 0) usage('berths');
    for (const b of BERTHS) out(`${b.id}  max draught ${b.maxDraught.toFixed(1)} m`);
  },
  book(args) {
    if (args.length !== 4) usage('book <vessel> <berth> <date> <hw>');
    const [name, berthId, date, hw] = args;
    vessel(name);
    berth(berthId);
    windowOf(date, hw);
    const b = book({ vessel: name, berth: berthId, date, window: hw });
    out(`booked ${b.id}: ${b.vessel} in ${b.berth} on ${b.date}, ${b.window} high water`);
  },
  list(args) {
    if (args.length > 1) usage('list [<date>]');
    for (const b of list(args[0])) out(`${b.id}  ${b.date} ${b.window}  ${b.berth}  ${b.vessel}`);
  },
  cancel(args) {
    if (args.length !== 1) usage('cancel <booking>');
    const b = cancel(args[0]);
    out(`cancelled ${b.id}: ${b.berth} on ${b.date}, ${b.window} high water is free`);
  },
};

try {
  const [command, ...args] = process.argv.slice(2);
  const run = commands[command];
  if (run === undefined) throw new TidewaterError(`unknown command ${command ?? '(none)'}; one of ${Object.keys(commands).join(', ')}`);
  run(args);
} catch (error) {
  if (!(error instanceof TidewaterError)) throw error;
  process.stderr.write(`tidewater: ${error.message}\n`);
  process.exitCode = 2;
}
