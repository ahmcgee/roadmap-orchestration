import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowNote } from '../../src/note.js';

test('the window note names the high water and the window around it', () => {
  assert.equal(windowNote('2026-10-04', '20:31'), 'HW 20:31, window 19:01-22:01');
  assert.throws(() => windowNote('2026-10-04', '12:00'), /no 12:00 high water/);
});
