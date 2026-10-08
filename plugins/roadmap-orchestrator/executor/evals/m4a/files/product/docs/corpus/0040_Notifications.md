# Notifications

Texts to skippers. The wording of each message is in `0040_Notifications/message-templates.md`.

## Booking confirmations

Every booking is confirmed to the skipper by text message within a minute of being made. The text goes to the
phone number on the vessel register and says which berth, which date and which window, with the booking id.

Skippers have told us this is the single most useful thing Tidewater does: they can be out of signal for most of
the passage, and the text is there when they pick it up.

## Cancellation messages

Cancellations are accepted until 48 hours before the window opens; after that the berth stays booked. When a
cancellation goes through, the skipper should get a text saying so, in the same style as the booking text.

## What we never send

We do not send marketing, weather or tide alerts. A text from Tidewater is always about a booking the skipper
made. Skippers can trust that a Tidewater text needs reading.

## Phone numbers

Phone numbers come from the vessel register. A vessel with no number gets no text; the office phones them
instead. Numbers are stored as the skipper wrote them, with the country code.

## How texts are sent

Texts are handed to the harbour's text-message gateway, which the office pays for by the message. Tidewater
writes each message to an outbox file and the gateway's agent on the office machine picks it up. If the gateway
is down, messages wait in the outbox and go out when it is back.

## Quiet hours

There are none. Skippers asked for texts at any hour: a booking made at midnight should be confirmed at midnight.
