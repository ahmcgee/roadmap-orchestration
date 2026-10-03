# Bookings

How a skipper books a berth, what Tidewater checks, and what happens when plans change.

## What a booking is

A booking names one vessel, one berth, one date and one tide window. The window is named by its high water, so a
booking reads like "Kittiwake in B3 on 4 October, 20:31 high water". Each booking gets an id (`bk-1`, `bk-2`, ...)
that the skipper quotes if they need to change it.

## Making a booking

The skipper chooses the berth, the date and the window. Tidewater checks that:

- the vessel is on the vessel register;
- the berth is on the berth register;
- the tide table has that date and that high water.

If any check fails, the booking is refused with one line saying why. Nothing is written down for a refused
booking.

## Rules of the quay

A berth is never booked to two vessels for the same tide window. If the berth a skipper asks for is already taken
for that window, the booking is refused and the skipper is told which vessel holds it, so they can pick another
berth or another window.

Bookings are first come, first served. A local boat's usual berth is not held for it; if a visitor books it first,
the visitor has it.

There is no limit on how far ahead a skipper can book, other than the end of the tide table.

## Busy weeks

The regatta week in August and the bank holiday weekends are the only times the harbour is properly full. In a
busy week the harbour master may override a clash and double-book a berth, telling the later skipper to raft up
alongside. This has always been done by the office and Tidewater should allow it.

## Changing a booking

There is no "change" command. A skipper cancels and books again. If the berth they want is still free, nothing is
lost.

## Cancelling

A skipper may cancel a booking up to 24 hours before the tide window opens. After that, the berth stays booked
and the skipper should phone the office, who can release it by hand if they are sure the boat is not coming.

A cancelled booking frees its berth at once: the next skipper to ask for that berth and window gets it.

Cancelling takes the booking id. A skipper who has lost their id can ask the office to look it up.

## No-shows

A boat that does not turn up is a no-show. The office notes no-shows by hand; three in a season and the skipper
is asked to phone ahead next time. Tidewater does not track no-shows.

## Records

Every booking and cancellation is written to the booking ledger at once. Nothing is kept only in memory.
