import { StringDecoder } from 'node:string_decoder';
import { safe } from './transcript.ts';
import { pretty, type Entry } from './types.ts';

/** Worker output is technical context, not a run-state announcement. Retained only in viewer memory. */
export class ViewerDiagnostics {
  #decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  #tails = { stdout: '', stderr: '' };
  #messages: string[] = [];
  #truncated = false;

  accept(bytes: Buffer, stream: 'stdout' | 'stderr'): void {
    const lines = (this.#tails[stream] + this.#decoders[stream].write(bytes)).split('\n');
    this.#tails[stream] = lines.pop()!;
    for (const line of lines) this.#keep(line);
    if (this.#tails[stream].length > 4096) {
      this.#keep(this.#tails[stream]); this.#tails[stream] = ''; this.#truncated = true;
    }
  }
  #keep(line: string): void {
    const text = safe(line).trim();
    if (!text) return;
    const bounded = text.slice(0, 4096);
    if (text.length > bounded.length) this.#truncated = true;
    if (this.#messages.includes(bounded)) return;
    this.#messages.push(bounded);
    if (this.#messages.length > 32) { this.#messages.shift(); this.#truncated = true; }
  }
  entries(): Entry[] {
    const messages = [...this.#messages, ...Object.values(this.#tails).map((tail) => safe(tail).trim()).filter(Boolean)];
    if (!messages.length) return [];
    const compatibility = messages.every((text) => text.startsWith('roadmap: upgrade default ('));
    const summary = compatibility
      ? 'This run contains records from an older executor. The viewer reads them using supported compatibility rules. No action is needed for these messages.'
      : 'Technical messages from the viewer’s data reader. These are separate from the run’s recorded outcomes; observation failures are listed separately.';
    return [{ id: 'viewer-diagnostics', label: compatibility ? 'Viewer note: older run format' : 'Viewer diagnostics', state: 'information',
      description: summary, body: pretty({ summary, technicalDetails: messages, ...(this.#truncated ? { retention: 'Only the latest 32 distinct messages are retained; long messages are shortened.' } : {}) }),
      links: [], provenance: 'Current viewer session · not written to the run' }];
  }
}
