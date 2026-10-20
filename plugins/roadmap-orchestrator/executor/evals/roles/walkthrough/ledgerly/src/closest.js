// "Did you mean": the nearest known word to a mistyped one.

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** The option nearest to `word`, when it is at most two edits away; null otherwise. */
export function closest(word, options) {
  let best = null;
  let bestDistance = 3;
  for (const option of options) {
    const d = distance(word.length > 0 ? word : ' ', option);
    if (d < bestDistance) {
      best = option;
      bestDistance = d;
    }
  }
  return best;
}
