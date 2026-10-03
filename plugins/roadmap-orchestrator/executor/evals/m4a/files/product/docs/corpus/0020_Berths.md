# Berths

The inner basin has six berths. This document says what a berth is in Tidewater and how the register is kept.
The register itself is in `0020_Berths/berth-register.md`; tide windows have their own page in
`0020_Berths/tide-windows.md`.

## What a berth is

A berth is a length of wall with rings and a ladder, and a depth of water at the bottom of the tide. In Tidewater
a berth has an id (B1 to B6) and a maximum draught in metres. A vessel whose draught is deeper than a berth's
maximum must not be put there: at low water it would sit on the mud, and some of the older hulls do not take that
well.

Berths are booked per tide window, not per day. A boat that comes in on the morning tide and leaves on the evening
tide holds its berth for both windows and everything in between, but for booking purposes we only care about the
window it arrives on. The harbour master sorts out departures on the day.

## Which boats go where

The harbour master's rule of thumb, which the office has always used:

1. Local boats keep their usual berth when it is free.
2. Visiting boats go to the deepest free berth that fits, so the shallow berths stay free for the locals.
3. Nobody is put in B6 unless they need the depth; it is the only berth a fishing boat of any size can use.

Tidewater does not choose berths for skippers yet. Skippers pick one and Tidewater checks it.

## Keeping the register

The register is kept by the harbour office. Changes are rare: a berth's depth changes after dredging, or a berth
is closed while the wall is repaired. When a berth is closed, existing bookings for it are moved by hand and the
skippers are phoned.

The register lives in `data/berths.json` in the code. The copy in `0020_Berths/berth-register.md` is for people;
when they disagree, the data file is what Tidewater uses and the page should be fixed.

## Draught

Draught is the depth of the hull below the waterline. Skippers give it when their vessel is registered. We round
up to the next tenth of a metre. A visiting yacht that does not know its draught is asked to find out before it
books; the office will not guess.

A booking for a berth whose maximum draught is less than the vessel's draught should be refused. This check is
done by the office today, by eye, when the day's list is printed.
