# W3 ride-along implementation report

Worktree: `wt/ridealong`. Binding brief: `certify-unit-loop.md`, W3.
No versions, README, SVG process diagrams, paid evals or other checkouts changed.
Each item has its own commit. Validation details are recorded below after the final checks.

## Item 18: ordering parks (OP-62)

The operator-log diagnosis cannot be established from the supplied aggregate report.
`src/schedule/ready.ts` admits active units only after their effective `after` prerequisites
merge. The scheduler re-evaluates those waits automatically. The real-process regression
`test/blocker-wake.test.ts` confirms no dependent stage dispatches while its prerequisite
build is held, then both merge without resume or a checkpoint, with the dependent's first
intent after its blocker's snapshot outcome.

An **operator park** is different persisted state: its park record has no blocker-unit field.
`src/holistic/checkpoint.ts: designParkRoute` routes a design park to a checkpoint, a
respecification or an owner item; none of its variants records an ordering wait. Arbitrary
prose from a model's explanation cannot safely identify a prerequisite or prove that a
merge fixes the park. Automatically reopening all design parks after any merge would
invent that relationship and bypass unrelated design failures.

No speculative production wake rule was added. The closest faithful result is the explicit
dependency regression and this diagnosis. OP-62's unit/blocker identities and recorded
park/checkpoint decision are needed to reproduce the reported operator-park case and decide
which producer should record a structured wait. This information was requested while the
other items proceeded. Item 18's operator-park behavior remains unimplemented.
