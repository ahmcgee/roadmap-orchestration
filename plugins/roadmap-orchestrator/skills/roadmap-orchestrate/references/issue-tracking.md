# GitHub projection

Issue mode is optional and requires authorization to publish tracking. Set `tracking:"issues"`,
`repoSlug:"owner/repo"`, `milestone` and the arc's `trackingIssue` in the shared plan. Use `gh` directly;
no model courier is needed. All failures record a `gh-sync` degradation and leave local progress
usable. Read open bugs/proposals as candidate scope at Phase 0, and bugs at wave boundaries.

Maintain one `roadmap:arc` issue and one `roadmap:unit` issue per unit. Use the existing
`status:pending`, `status:running`, `status:merge-ready`, `status:merged`, `status:blocked`,
`status:quarantined`, `status:backlog`, `status:proposed`, `status:deferred` labels. Unit issue bodies
begin with `<!-- roadmap:unit id=<id> -->`. Issue numbers in plan/state are caches only.

Find-or-create by **exact first-line body marker**, not by a search hit or cached number. Fetch
candidates and compare their first line in code; GitHub search tokenizes punctuation and can return
unrelated issues. Refuse ambiguous multiple exact matches. Never overwrite closed issue bodies,
labels or milestones, and never remove `status:merged`. Pass multiline bodies via a file or a
structured API argument. Do not interpolate arbitrary prose into shell code.

Reconcile projection at boundaries and close-out, so retries do not duplicate issues. Bank residue as
one `roadmap:debt` issue per arc/wave/unit, with first-line marker
`<!-- roadmap:debt arc=<trackingIssue-or-milestone> wave=<N> unit=<id> -->`; cross-arc matches are invalid.
If publication fails, keep the item in local `debt.json` and state until acknowledged. Fix units can
carry `closes:[issueNumbers]` for specific debt/bug issues they resolve. Never erase unconfirmed debt.

Promote a one-to-one proposal/bug in place; for a split, create child units and close the parent with
links and disposition. Fold, defer or decline explicitly. Move/close consumed feedback only after
checkpointing its disposition. A user bug does not interrupt an in-flight unit.

Deliver one integration PR when authorized. Include `Closes #<unit issue>` for merged units. Keep
quarantined-unit and unresolved-debt issues open; close the arc and milestone only after final merge.
The issue templates shipped in the sibling Claude skill are optional installation assets; publishing
them requires a separate authorized change to the target repository's default branch.
