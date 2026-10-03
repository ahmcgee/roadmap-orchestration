# ADR 0003: One JSON file for the booking ledger

- Status: accepted
- Date: 2024-12-07

## Context

The spreadsheet that came before Tidewater lost bookings when two people had it open at once. We considered a
small database, but the office machine is looked after by volunteers and nobody wanted to look after a database
server too.

## Decision

We will keep all bookings in one JSON file that only the tidewater command reads and writes. Each command reads the
whole file and writes it back.

## Consequences

The ledger is easy to read, copy and back up. Two commands run at exactly the same moment could still lose one
write; at the harbour's size we accept that and the kiosk and the office rarely book at the same second. If the
harbour grows, this is the first decision to revisit.
