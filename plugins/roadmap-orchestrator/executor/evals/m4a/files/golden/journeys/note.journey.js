import assert from 'node:assert/strict';
import { test } from 'node:test';

// The module is imported inside the test: before the unit builds it, this test fails (the file still reports it).
test('a window note names the high water and the window around it', async () => {
  const { windowNote } = await import('../src/note.js');
  assert.equal(windowNote('2026-10-04', '20:31'), 'HW 20:31, window 19:01-22:01');
});
