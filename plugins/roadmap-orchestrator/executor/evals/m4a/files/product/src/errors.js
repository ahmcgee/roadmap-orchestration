// A refusal the command line reports as `tidewater: <message>` and exit 2.
export class TidewaterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TidewaterError';
  }
}
