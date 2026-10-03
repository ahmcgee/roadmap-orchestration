# ADR 0002: Tide windows from the printed tide table

- Status: accepted
- Date: 2024-11-16

## Context

There are free online tide services that give predicted high waters for nearby ports. Using one would save typing
in the table each winter. But the nearest prediction port is eleven miles up the coast, the services have been down
for days at a time, and the harbour master trusts the printed tables the harbour buys, which are corrected for our
sill.

## Decision

We will use the static tide table as the single source of tide windows. The table is typed in from the printed
tables each winter and kept in `data/tides.json`.

## Consequences

Tidewater keeps working with no network. Someone has to type in and check the table every winter; a typing mistake
gives wrong windows until someone notices. Bookings can only be made for dates the table covers.
