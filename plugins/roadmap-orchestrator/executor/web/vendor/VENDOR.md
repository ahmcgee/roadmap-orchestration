# Vendored console assets

Static files only: no runtime packages, install, build or network download.
React and ReactDOM production UMD files were obtained using `npm pack react@18.3.1 react-dom@18.3.1` in a temporary directory. npm verifies the registry SRI during pack; before extraction we also compared each tarball's SHA-512 with both `npm view <package>@18.3.1 dist --json` and pack's integrity.

- react **18.3.1**, MIT (see `react.LICENSE`), source https://registry.npmjs.org/react/-/react-18.3.1.tgz
  - Registry tarball integrity: `sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==`
- react-dom **18.3.1**, MIT (see `react-dom.LICENSE`), source https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz
  - Registry tarball integrity: `sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==`

The owner-supplied design-system snapshot is copied byte-for-byte from `scratchpad/webui/ds/project/` (snapshot lastChange 2026-11-07T20:05:00Z, namespace `AtlasDesignSystem_ee04f2`). Its bundle, tokens and fonts are supplied project assets; the supplied snapshot contains **no license declaration**. No third-party license is inferred for those bytes. Font families supplied: Space Grotesk, Spectral and IBM Plex Mono. Internal identifiers remain as supplied; the product renders only Roadmap text and the audited neutral components (UnitGraph, MetricTile, StatusIndicator, TimeBreakdown/BreakdownBar, ResourceSchedule, BudgetMeter, ActivityTimeline/HoldNotice, DataTable and StepLog). Brand components/marks are never instantiated.

SHA-256 of every vendored file (this manifest excluded):

| File | SHA-256 |
|---|---|
| `bundle.css` | `19a41a97db3f68f009efe7ff590899a0d4c7adb407809d6590b226b5a9b0746a` |
| `bundle.js` | `4cca9e85b4a9757e2c6d7cc8319f0f75f84012b82aa1babe41e32467bb07feec` |
| `fonts/ibm-plex-mono-400.woff2` | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| `fonts/space-grotesk.woff2` | `0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d` |
| `fonts/spectral-400.woff2` | `cf8daee3b83c1e662196c6e34e444bc41344d54bfeb4fb5351e197de6ce94539` |
| `fonts/spectral-500.woff2` | `2b70215ed40f2c73bbc7bb53cff9c8975a244c8462569e60989c77b8c5a87a00` |
| `fonts/spectral-italic-400.woff2` | `db397149a9f73fd6a41dd2fdf3314cf8a9daf0485134465cc268cac578766b71` |
| `react-dom.LICENSE` | `52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85` |
| `react-dom.production.min.js` | `35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d` |
| `react.LICENSE` | `52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85` |
| `react.production.min.js` | `d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd` |
| `tokens.css` | `da467c22a6a5807cf3d3d9a29c069e39399976a13ba749ddfdf98fc9dd80af19` |
