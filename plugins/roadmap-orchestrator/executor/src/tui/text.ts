import { stripVTControlCharacters } from 'node:util';

/** Captured output is never terminal protocol, including OSC, C1, bidi and cursor controls. */
export function safe(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\t/g, '    ');
}
