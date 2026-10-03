# Tide windows

A tide window is the period around a high water when there is enough depth over the sill to come in or go out.

## How a window is worked out

The harbour's sill dries at low water. For the boats that use the harbour, the depth over it is enough from about
an hour and a half before high water to an hour and a half after. So a window opens 90 minutes before high water
and closes 90 minutes after it. Most days have two high waters and so two windows; a few have only one inside the
calendar day.

Every tide window the system offers is derived from the local tide table in data/tides.json and from nothing else:
no external feed is consulted, ever.

The table is typed in each winter from the printed tables the harbour buys for the coming year, and checked by a
second person. It covers the dates the harbour takes bookings for.

## Why 90 minutes

The figure comes from the sill's height and the draught of the boats that use the harbour most. For a deep boat
the usable part of the window is shorter, and the harbour master says so on the radio. Tidewater does not adjust
windows for draught.

## Times

Times are local harbour time and are written as `HH:MM`. A window that starts before midnight and ends after it
belongs to the date of its high water.

## What happens when the table is wrong

It has happened once, when a date was typed in twice. The office noticed because the windows did not match the
printed sheet on the wall. The fix was to correct the table and tell the skippers who had booked the wrong window.
Since then the table is checked against the printed sheet when it is loaded each winter.

## Weather

Strong onshore winds and low pressure can raise the water above the tables; a big high pressure can hold it down.
Tidewater does not try to allow for weather. The harbour master can close a window on the day, over the radio, if
the sea is not safe; that does not change the bookings.
