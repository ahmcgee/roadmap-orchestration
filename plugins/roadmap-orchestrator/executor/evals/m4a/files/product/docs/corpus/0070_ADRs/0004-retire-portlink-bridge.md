# ADR 0004: Retire the PortLink bridge

- Status: accepted
- Date: 2025-10-11

## Context

Since 2025 the regional port authority has wanted to know which vessels use the harbour. The first answer was the
PortLink bridge: a small program that relayed each booking to the authority's SOAP service every hour. It was
fragile. The authority's service was down most Sunday nights, the bridge's queue filled the office machine's disk
twice, and in September the authority announced it would switch the SOAP service off at the end of the year.

The authority now offers a simpler route: each harbour drops a CSV file of the day's bookings in a shared folder,
and the authority collects it overnight.

## Decision

We will retire the PortLink bridge. Tidewater will instead write a CSV export of each day's bookings to the
authority's shared folder every night, and the authority pulls it from there. Nothing is sent to the authority
during the day.

## Consequences

One less program to keep running and no queue on the office machine's disk. The authority sees a day's bookings
the next morning instead of within the hour, which they have said is fine. The bridge's code and queue are deleted.
