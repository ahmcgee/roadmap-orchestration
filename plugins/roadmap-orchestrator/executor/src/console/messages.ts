/** Worker requests are either coalescible reads or ordered subscription mutations. */
export type ConsoleRequest =
  | Readonly<{ kind: 'read'; path: string[]; params: Record<string, string> }>
  | Readonly<{ kind: 'subscribe' | 'unsubscribe'; arc: string; params?: Record<string, string> }>
  | Readonly<{ kind: 'history-subscribe' | 'history-unsubscribe'; arc: string; invocation: string }>;
