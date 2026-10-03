# Overview

This folder is the design record for Tidewater, the berth booking system for the harbour. It grew over two
seasons, so some of it is older than the rest. When documents disagree, ask the harbour master; the vision
document (0005) is the tie-breaker.

## The harbour in one page

The harbour has an outer basin and an inner basin behind a sill. At low water the inner basin holds its level
but nothing can cross the sill; around high water there is enough depth over it for most of the boats that use
the harbour. That period is what we call a tide window.

There are six berths in the inner basin, B1 to B6, each with a maximum draught. The deeper berths (B5, B6) are
on the north wall; the shallow ones are by the slipway. Visiting boats are put where they fit.

Tide windows are worked out from the harbour's own printed tide table; Tidewater never asks a live tide service.

## Who uses it

- **Skippers** of local and visiting boats. They book a berth for a window, look up windows for a day, and
  cancel when plans change.
- **The harbour master** and the office staff. They see the day's bookings, deal with the odd clash and keep
  the berth register up to date.
- **The regional port authority**, which wants to know which vessels are in the harbour and when.

## What Tidewater does today

Tidewater is a small command-line tool for now. The harbour office runs it on the office machine and skippers
use it through the office's kiosk on the quay.

- `windows <date>` prints the tide windows of a day from the tide table.
- `berths` prints the berth register.
- `book <vessel> <berth> <date> <hw>` books a berth for the window around a high water.
- `list [<date>]` prints the bookings.
- `cancel <booking>` cancels one.

Every booking is checked against the berth register and the vessel register before it is written down. A
booking for a window the table does not have is refused.

## How it should feel

Tidewater should feel calm to use, even at two in the morning on a falling tide. Messages say what happened and
what to do next, in plain words. Nothing flashes, nothing shouts.

A skipper who has been turned away should know why in one line, and what they could book instead.

## Where things are written down

| Topic | Document |
| --- | --- |
| Berths and the berth register | 0020_Berths.md and 0020_Berths/ |
| Tide windows | 0020_Berths/tide-windows.md |
| Booking rules | 0030_Bookings.md |
| Texts to skippers | 0040_Notifications.md and 0040_Notifications/ |
| How the system is built | 0050_Architecture.md |
| Running it day to day | 0060_Operations.md |
| Decisions we made and why | 0070_ADRs/ |

## A short history

The first version was a spreadsheet the harbour master kept on the office machine. It worked for one season and
then the clashes started: the spreadsheet had no idea a berth could only take one boat per window. The second
version was the first cut of this command-line tool, written over the winter. Bookings by text and the port
authority export came after that.

We expect to keep this folder current as the system grows. If you change how Tidewater behaves, change the
document that describes it in the same go.
