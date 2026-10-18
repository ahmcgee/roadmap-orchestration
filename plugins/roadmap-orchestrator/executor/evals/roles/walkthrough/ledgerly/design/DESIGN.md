# ledgerly design

The reference every ledgerly surface is built to. The dashboard follows this file and `tokens.css`; the API, the CLI, the
configuration file and CI follow `api.md`, `cli.md`, `config.md` and `ci.md`. A change that departs from these files
changes them first.

## Subject, audience, job

- **Subject.** A spend ledger for platform teams: what each team pays its vendors (cloud, tooling, support contracts),
  month by month, against a monthly limit.
- **Audience.** Engineering leads and platform engineers. They are not accountants. They open ledgerly a few times a
  month, usually to record a payment or to see whether a team is about to go over.
- **Primary job.** Know where your team stands against its limit, and record a payment in under a minute.

## Principles

1. **The figure first.** Every page is about one figure (a team's spend, a month's total). It sits in the page's card,
   in the display face, before any table.
2. **Words, not colour alone.** A state is always written ("Near the limit"); colour only repeats it.
3. **Plain ledger, no decoration.** Paper ground, ink text, rules between rows. No gradients, shadows or illustrations.
4. **Nothing silent.** Every action confirms what it did with the same verb as its button; every refusal says what to fix.
5. **Keyboard first-class.** Every task can be done with the keyboard alone, with the focus always visible.

## Anti-patterns (never)

- A grid of identical cards for everything. ledgerly has one card per page.
- Gradient washes, drop shadows, glassy surfaces.
- ALL-CAPS labels or eyebrow text above headings.
- "Submit", "OK" or "Done" as a button label: say what happens ("Record entry", "Save limit").
- Confirmation that only flashes and disappears.
- Colour as the only signal of a state.
- Modal dialogs for forms.
- Placeholder text standing in for a label.

## The one memorable thing: the burn bar

Each team's month is drawn as a ruled bar: a thick stroke (`--ll-stroke`) for what was spent, a tick at the team's alert
share, ruled ends for the limit, and the amount left printed after it in tabular figures. The stroke is ledger green,
amber from the alert share, red past the limit, and over the limit it runs past the right end. The state is written next
to it. The burn bar appears on the overview, the budgets list, a team's budget page and an entry's page, and nowhere else.

## Tokens

`tokens.css` holds every colour, size, space and radius; components use only these. Measured contrast, on `--ll-paper`:

| Token | Use | Contrast |
|---|---|---|
| `--ll-ink` #17212B | all body text, headings, table text | 14.9:1 |
| `--ll-ink-muted` #66716C | captions, hints and metadata only, never body text | 4.6:1 (5.1:1 on `--ll-surface`) |
| `--ll-ledger` #1B5E4A | primary buttons (white text 7.7:1), links, the burn stroke | 7.0:1 |
| `--ll-amber` #8A5A00 | "Near the limit" | 5.4:1 |
| `--ll-over` #A1332B | "Over the limit", errors | 6.3:1 |
| `--ll-rule` #CBD5D1 | rules and borders, never text | n/a |
| `--ll-highlight` #E3EFE9 | the highlight card's ground (ink on it 13.8:1) | n/a |
| `--ll-focus` #1D5FD1 | the focus ring | 5.3:1 |

Type: headings and the card figure in the display face (`--ll-face-display`, a book serif), everything else in the text
face. Scale 14 / 16 / 20 / 25 / 31 px (`--ll-size-*`). Body 16 px, lead paragraphs 20 px, line length at most 66
characters. Figures use tabular numerals and sit right-aligned in tables.

Space: a 4 px grid, `--space-1` to `--space-7` (4, 8, 12, 16, 24, 32, 48). Every margin, padding and gap is one of them.
Radius: 6 px on cards, 4 px on controls. No shadows.

## Quality floor

What every dashboard page keeps, whatever else changes (WCAG 2.2 AA). Falling short of any of it is never a style choice:

- **Contrast.** Body text at least 4.5:1 against its ground; large text (24 px, or 19 px bold) and interface parts
  (control borders, the focus ring, the burn stroke) at least 3:1. The table above gives each token's measured ratio.
- **Visible keyboard focus.** Every interactive element shows the focus ring when it is focused from the keyboard
  (Components, "Focus": an outline, or a box-shadow ring).
- **A full keyboard path.** Every flow in "Flows and their budgets" can be completed with the keyboard alone.
- **Reflow at 390 px.** At 390 px wide, text and controls fit the column and are read without scrolling sideways;
  only a data table may need horizontal scrolling.

## Layout

One left-aligned column, at most 72 rem wide, under a masthead with the wordmark and four sections: Overview, Entries,
Budgets, Statements. The current section is underlined in ledger green. At 390 px the column keeps a 16 px gutter and
tables scroll inside themselves; the page never scrolls sideways.

```
+--------------------------------------------------------------+
| ledgerly    Overview  Entries  Budgets  Statements            |
+--------------------------------------------------------------+
|  Page title (display face, 31)                                |
|  Lead paragraph, one or two lines (20)                        |
|  +--------------------------------------------------------+  |
|  | The page's figure (display face, 25)                   |  |
|  | [ Primary action ]                                     |  |
|  +--------------------------------------------------------+  |
|  Table or list, ruled rows                                    |
+--------------------------------------------------------------+
```

Pages: Overview `/`, Entries `/entries`, Record an entry `/entries/new`, an entry `/entries/<id>`, Budgets `/budgets`,
a team's budget `/budgets/<team>`, Change a limit `/budgets/<team>/edit`, Statements `/statements`, a statement
`/statements/<month>`, its print view `/statements/<month>/print`. Any other address shows "Page not found" with a way back.

### Print views

A statement's print view is deliberately plain: black on white, the system serif, no masthead, no navigation, no colour
and no card, and it loads `print.css` only, not the dashboard's stylesheet. It is a document to print or save as PDF,
not a dashboard page; the token rules above do not apply to it.

## Components

- **Card** (`.card`): one per page, holding the page's figure and its primary action. Surface ground, 1 px rule border,
  `--space-5` padding. Variant **highlight** (`.card--highlight`): `--ll-highlight` ground and `--space-4` padding, for a
  page whose figure is a single headline amount. Add a new variant here before using it.
- **Buttons**: `.button-primary` (ledger ground, white text), one per page; `.button-quiet` (ruled outline) for Cancel
  and Back. Labels are verbs naming the result.
- **Focus**: every interactive element shows the focus ring when focused from the keyboard: a 3 px `--ll-focus` outline
  2 px outside the element. A component may draw the ring as a box-shadow instead of an outline (then it sets
  `outline: none`), but never shows neither.
- **Fields**: label above, hint under the label in muted ink, the error under the hint in `--ll-over`, then the control.
  Inputs keep what was typed after an error.
- **Error summary**: at the top of a refused form, "One thing to fix before you record this entry" (or "N things"), each
  item linking to its field.
- **Notice** (`.notice`, `role="status"`): the confirmation after an action, using the action's verb ("Entry recorded",
  "Limit saved"), shown on the page the action lands on until the person moves on.
- **Burn bar**: above.
- **Tables** (`.ledger`): ruled rows, a 2 px ink rule under the header, figures right-aligned in tabular numerals.
- **State tag**: the state in words, coloured to match.
- **Caption** (`.caption`): small muted text under content, for metadata and footnotes.

## Copy

- Sentence case everywhere. Plain verbs. The vocabulary is fixed: entry, team, month, limit, statement; "record" an
  entry, "change" or "save" a limit, "import" a CSV.
- Errors name the field and how to fix it, in the product's voice, and never apologise: "Amount must be a number above
  zero, like 120 or 120.50, without a currency sign."
- Empty states invite the next action: "No entries yet. Record the first one, or import a CSV."

## Flows and their budgets

| Flow | Path | Steps | States |
|---|---|---|---|
| Record an entry | Entries, Record entry, fill four fields, Record entry, lands on the entry with "Entry recorded" | 6 | empty ledger, refused form (summary + fields), recorded |
| Change a team's limit | Budgets, the team, Change limit, type it, Save limit, lands on the team with "Limit saved" | 5 | refused value, saved |
| Print a month's statement | Statements, the month, Print view | 3 | no statements yet, statement, print view |

A step is a page load or a form submission. Each flow also works by keyboard alone in the same number of steps.

## Behaviour in the browser

- No console errors or warnings, and no failed requests. A page may log one `console.info` line naming the view, which
  support uses; nothing else is logged.
- No motion besides the browser's own; `prefers-reduced-motion` is respected.

## Walkthrough script seed

The journeys a walkthrough runs, at 1280x800 and again at 390x844: the three flows above, then the CLI, API,
configuration, CI and quickstart journeys in `cli.md`, `api.md`, `config.md`, `ci.md` and the README.
