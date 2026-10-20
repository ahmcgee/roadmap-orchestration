// The M5 check's reflow oracle (evals/m5/reflow.ts) against a real browser: the devcontainer's Playwright Chromium renders
// the seed product's shelf page at 320 CSS px. At the seed the plant overflows; after a stylesheet commit that wraps the
// condition line it does not, and the planted book is still on the page. Serial tier: it starts a real browser.
// Named test: evals-m5.reflow-real.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { plantRepairedVerdict } from '../../evals/m5/check.ts';
import { PLANT } from '../../evals/m5/layout.ts';
import { reflowAt } from '../../evals/m5/reflow.ts';
import { setup } from '../../evals/m5/setup.ts';
import { git, tmpDir } from '../helpers/repo.ts';

test('evals-m5.reflow-real: the seed scrolls sideways at 320 px; wrapping .book-meta repairs it with the planted book listed', { timeout: 180_000 }, async () => {
  const l = setup(join(tmpDir('m5-reflow'), 'fx'));
  const seed = await reflowAt(l.product, git(l.product, 'rev-parse', 'main'));
  assert.ok(seed.kind === 'measured' && seed.viewport === PLANT.viewport && seed.scrollWidth > PLANT.viewport, JSON.stringify(seed.kind === 'measured' ? { ...seed, html: undefined } : seed));
  assert.ok(seed.html.includes(PLANT.title) && seed.html.includes(PLANT.url));

  appendFileSync(join(l.product, 'public', 'style.css'), '\n.book-meta { overflow-wrap: anywhere; }\n');
  git(l.product, 'commit', '--quiet', '--all', '--message', 'wrap the condition line');
  const head = git(l.product, 'rev-parse', 'HEAD');
  const fixed = await reflowAt(l.product, head);
  assert.ok(fixed.kind === 'measured' && fixed.scrollWidth <= PLANT.viewport, JSON.stringify(fixed.kind === 'measured' ? { ...fixed, html: undefined } : fixed));
  const v = plantRepairedVerdict(head, fixed);
  assert.ok(v.pass, v.detail);
});
