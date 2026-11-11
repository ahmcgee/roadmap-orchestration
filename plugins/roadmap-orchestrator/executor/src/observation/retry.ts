import { ConsoleError } from './protocol.ts';

/** A read that raced a writer: nothing is wrong with the arc, a file moved while it was read. */
export class ObservationRace extends ConsoleError {
  constructor(message: string) { super('unavailable', message); this.name = 'ObservationRace'; }
}
/** One immediate retry of a one-shot read (the CLI's) whose file disappeared under it; a second race yields to the writer. */
export function retryObservation<T>(capture: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try { return capture(); }
    catch (error) {
      // Preserve original read errors through Observer.capture; UI observe() reduces them to text.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (attempt === 0) continue;
      throw new ObservationRace('observation file disappeared during request admission');
    }
  }
}
