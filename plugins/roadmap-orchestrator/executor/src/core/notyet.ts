// M4a rev 3 step N0 froze the records and the final module paths before their behaviour lands (H3). A path that would
// run behaviour a later step owns (a placeholder command or module, a stage no producer reaches yet) throws `NotYetError`
// naming the step: loud, never caught, and gone once that step lands. TEMPORARY: delete this module when the last caller
// is replaced (BACKLOG "Scaffolding to delete": before the PR).

export class NotYetError extends Error {
  readonly step: string;
  constructor(what: string, step: string) {
    super(`not-yet: ${what} lands in M4a rev 3 step ${step}`);
    this.name = 'NotYetError';
    this.step = step;
  }
}

export function notYet(what: string, step: string): never {
  throw new NotYetError(what, step);
}
