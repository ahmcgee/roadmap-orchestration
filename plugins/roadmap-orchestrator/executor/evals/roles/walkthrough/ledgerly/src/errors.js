// Errors a person can fix. bin/ledgerly.js turns them into a message on stderr and an exit code (design/cli.md).

/** Exit 2: the command line is wrong. */
export class UsageError extends Error {}

/** Exit 3: a file or a value the person gave is wrong. */
export class InputError extends Error {}
