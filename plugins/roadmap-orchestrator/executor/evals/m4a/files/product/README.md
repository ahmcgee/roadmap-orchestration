# tidewater

Berth booking for a small working harbour. Skippers book a berth for a tide window: the period around a high
water when there is enough water over the sill to come in.

```sh
node src/cli.js windows 2026-10-04
node src/cli.js book Kittiwake B3 2026-10-04 20:31
node src/cli.js list
npm test
```

The design notes live in `docs/corpus/`.
