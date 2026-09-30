// Host signatures (M2, A10): output a red lane prints when the host, not the tree, failed it. The table is
// code, not configuration. A signature alone proves nothing: the red-lane protocol (src/pipeline/redlane.ts)
// reruns only when the lane's host samples also show a busy host, and calls a signature without that
// evidence `blocked`.
//
// Every pattern is hand-written from the tools' documented messages, never captured from an arc: re-derive
// them once arcs have recorded real host-caused reds.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const HOST_SIGNATURES = [
  // golangci-lint refuses to run beside another instance holding its lock.
  { id: 'golangci-lint-lock', pattern: /parallel golangci-lint is running/i },
  // kind gave up waiting for its node containers to boot.
  { id: 'kind-boot-timeout', pattern: /failed to create cluster:.*(timed out waiting for the condition|failed to init node with kubeadm)/i },
  // A process or thread limit, or a busy lock: fork, clone and non-blocking I/O report EAGAIN.
  { id: 'eagain', pattern: /\bEAGAIN\b|Resource temporarily unavailable/ },
  // The disk (or an inode table) is full.
  { id: 'enospc', pattern: /\bENOSPC\b|No space left on device/ },
] as const satisfies readonly Readonly<{ id: string; pattern: RegExp }>[];

export type HostSignatureId = (typeof HOST_SIGNATURES)[number]['id'];

/** How much of each output file's tail is searched: a signature is near where the lane died. */
export const SIGNATURE_TAIL_BYTES = 1 << 20;

/** The signatures `text` matches, in table order. */
export function matchSignatures(text: string): readonly HostSignatureId[] {
  return HOST_SIGNATURES.filter((s) => s.pattern.test(text)).map((s) => s.id);
}

/** The last `SIGNATURE_TAIL_BYTES` of a file, as text. */
function tail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, SIGNATURE_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, size - length + read);
      if (n === 0) throw new Error(`${path}: read returned 0 bytes at ${size - length + read} of ${size}`);
      read += n;
    }
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The signatures in the tails of a lane's output files (its stdout and stderr), in table order. */
export function outputSignatures(paths: readonly string[]): readonly HostSignatureId[] {
  const found = new Set(paths.flatMap((p) => matchSignatures(tail(p))));
  return HOST_SIGNATURES.map((s) => s.id).filter((id) => found.has(id));
}
