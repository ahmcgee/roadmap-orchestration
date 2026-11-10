/** Worker requests are either coalescible reads or ordered subscription mutations. */
export type ConsoleRequest =
  /** `patient`: a browser read, which waits out captures that race a writer (PREPARATION.racePatienceMs); the CLI stays strict. */
  | Readonly<{ kind: 'read'; path: string[]; params: Record<string, string>; patient?: true }>
  | Readonly<{ kind: 'subscribe' | 'unsubscribe'; arc: string; params?: Record<string, string> }>
  | Readonly<{ kind: 'history-subscribe' | 'history-unsubscribe'; arc: string; invocation: string }>;
