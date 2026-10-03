# ADR 0005: Confirm bookings by text through an outbox file

- Status: accepted
- Date: 2026-02-21

## Context

Skippers asked to be told their booking went through. Email does not work for them at sea; texts do. The harbour
already pays for a text-message gateway for its tide alerts on the quay, and the gateway's agent can send whatever
appears in a folder on the office machine.

## Decision

We will confirm bookings by text. Tidewater writes each message to an outbox file; the gateway's agent picks it up
and sends it. Tidewater never talks to the gateway directly.

## Consequences

Tidewater stays offline and simple, and a gateway outage only delays texts. The texts' wording is ours to keep
consistent (0040_Notifications/message-templates.md). The vessel register must carry a phone number for each
vessel that wants texts.
