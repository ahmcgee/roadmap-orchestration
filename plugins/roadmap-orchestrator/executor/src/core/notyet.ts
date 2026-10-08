// M4b step 0a froze the records and the final module and command paths before their behaviour lands. A path that would
// run behaviour a later step owns (a flow module, the flow commands, the flow prompt) throws `NotYetError` naming the
// step: loud, never caught, and gone once that step lands. Step C deletes this module when the last caller is replaced.

export class NotYetError extends Error {
  readonly step: string;
  constructor(what: string, step: string) {
    super(`not-yet: ${what} lands in M4b step ${step}`);
    this.name = 'NotYetError';
    this.step = step;
  }
}

export function notYet(what: string, step: string): never {
  throw new NotYetError(what, step);
}
