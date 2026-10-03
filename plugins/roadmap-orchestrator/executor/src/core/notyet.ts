// M4a step 0a froze the records and the final command paths before their behaviour lands (H3). A path that would run
// behaviour a later step owns (a corpus arc's judgment input, a placeholder command) throws `NotYetError` naming the
// step: loud, never caught, and gone once that step lands. Delete this module when the last caller is replaced.

export class NotYetError extends Error {
  readonly step: string;
  constructor(what: string, step: string) {
    super(`not-yet: ${what} lands in M4a step ${step}`);
    this.name = 'NotYetError';
    this.step = step;
  }
}

export function notYet(what: string, step: string): never {
  throw new NotYetError(what, step);
}
