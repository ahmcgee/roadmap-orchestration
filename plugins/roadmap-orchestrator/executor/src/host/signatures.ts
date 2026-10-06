// Host signatures (M2, A10): output a red lane prints when the host, not the tree, failed it. The table is
// code, not configuration. A signature alone proves nothing: the red-lane protocol (src/pipeline/redlane.ts)
// reruns only when the lane's host samples also show a busy host, and calls a signature without that
// evidence `blocked`.
//
// Every pattern is hand-written from the tools' documented messages, never captured from an arc: re-derive
// them once arcs have recorded real host-caused reds.
//
// The table is revisioned (M4a rev 3, F3, Q20): every lane and journey spawn is stamped with `HOST_SIGNATURES_REV`
// (`redRev`) before it runs, and a red run's class is persisted in its `red.json`, so growing the table never changes
// how an earlier run reads back. An unstamped run (1.0.0-dev.6) classifies with the frozen `HOST_SIGNATURES_DEV6`
// (src/core/upgrade.ts).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The revision of `HOST_SIGNATURES` a spawn is stamped with. Revision 1 was the 1.0.0-dev.6 table
 * (`HOST_SIGNATURES_DEV6`), which no spawn carries; bump it with every change to the table.
 */
export const HOST_SIGNATURES_REV = 2;

export const HOST_SIGNATURES = [
  // golangci-lint refuses to run beside another instance holding its lock.
  { id: 'golangci-lint-lock', pattern: /parallel golangci-lint is running/i },
  // kind gave up waiting for its node containers to boot.
  { id: 'kind-boot-timeout', pattern: /failed to create cluster:.*(timed out waiting for the condition|failed to init node with kubeadm)/i },
  // A process or thread limit, or a busy lock: fork, clone and non-blocking I/O report EAGAIN.
  { id: 'eagain', pattern: /\bEAGAIN\b|Resource temporarily unavailable/ },
  // The disk (or an inode table) is full.
  { id: 'enospc', pattern: /\bENOSPC\b|No space left on device/ },
  // Revision 2 (dx2 5): a Kubernetes control plane too loaded to answer its store.
  { id: 'etcd-request-timeout', pattern: /etcdserver: request timed out/ },
  // The container runtime could not stop a container (a wedged or overloaded daemon).
  { id: 'container-kill', pattern: /could not kill (the )?container/i },
  // The kernel's (or a container's) out-of-memory killer ended a process.
  { id: 'oom-kill', pattern: /\bOOMKilled\b|Out of memory: Killed process/ },
] as const satisfies readonly Readonly<{ id: string; pattern: RegExp }>[];

export type HostSignatureId = (typeof HOST_SIGNATURES)[number]['id'];

/** A signature table: the current one, or a frozen earlier revision whose ids are among the current ones. */
export type SignatureTable = readonly Readonly<{ id: HostSignatureId; pattern: RegExp }>[];

/** How much of each output file's tail is searched: a signature is near where the lane died. */
export const SIGNATURE_TAIL_BYTES = 1 << 20;

/** The signatures `text` matches, in table order. */
export function matchSignatures(text: string, table: SignatureTable = HOST_SIGNATURES): readonly HostSignatureId[] {
  return table.filter((s) => s.pattern.test(text)).map((s) => s.id);
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

/** The signatures of `table` in the tails of a lane's output files (its stdout and stderr), in table order. */
export function outputSignatures(paths: readonly string[], table: SignatureTable = HOST_SIGNATURES): readonly HostSignatureId[] {
  const found = new Set(paths.flatMap((p) => matchSignatures(tail(p), table)));
  return table.map((s) => s.id).filter((id) => found.has(id));
}

/** The last `SIGNATURE_TAIL_BYTES` of a lane's output file, as text (what the failure signature reads). */
export const outputTail = (path: string): string => tail(path);
