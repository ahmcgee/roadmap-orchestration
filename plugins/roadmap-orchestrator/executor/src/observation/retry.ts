import { ConsoleError } from './protocol.ts';

const dependenciesChanged = Symbol('observation dependencies changed');
/** One immediate retry within the admission budget; persistent churn yields to the writer. */
export function retryObservation<T>(capture: (changed: () => never) => T, retry = true): T {
  const deadline = Date.now() + 2_000;
  for (let attempt = 0; ; attempt++) {
    try { return capture(() => { throw dependenciesChanged; }); }
    catch (error) {
      // Preserve original read errors through Observer.capture; UI observe() reduces them to text.
      if (error !== dependenciesChanged && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (retry && attempt === 0 && Date.now() < deadline) continue;
      throw new ConsoleError('unavailable', error === dependenciesChanged
        ? 'observation dependencies changed at request admission'
        : 'observation file disappeared during request admission');
    }
  }
}
