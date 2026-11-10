export class ApiError extends Error { code?: string; }
/** Retry the identical query with its delivery token. Preparation is never a dataset.
 * The server holds a poll that carries the token for up to retryAfterMs and answers as soon
 * as the read completes, so the browser polls again at once instead of sleeping. */
export async function preparedRead(api: string, protocol: string, path: string, signal?: AbortSignal): Promise<any> {
  const original = new URL(`${api}${path}`, (globalThis as {location?: {href: string}}).location?.href ?? 'http://console');
  const url = new URL(original);
  let token: string | null = null;
  const deadline = Date.now() + 30_000;
  const cancel = () => {
    if (!token) return;
    const cleanup = new URL(url); cleanup.searchParams.set('cancel', '1');
    void fetch(cleanup, {cache: 'no-store', headers: {Prefer: 'respond-async'}, keepalive: true}).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    for (;;) {
      const response = await fetch(url, {...(signal ? {signal} : {}), cache: 'no-store', headers: {Prefer: 'respond-async'}});
      let value: any; try { value = await response.json(); } catch { throw new ApiError('Malformed console response'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('Malformed console response');
      if (!response.ok) { const error = new ApiError(value.error?.message || `Console response ${response.status}`); error.code = value.error?.code; throw error; }
      if (value.protocol !== protocol) { const error = new ApiError('Reload required: executor version changed'); error.code = 'protocol'; throw error; }
      if (response.status !== 202) { token = null; return value; }
      const arc = original.pathname.split('/arcs/')[1]?.split('/')[0];
      const expectedArc = arc ? decodeURIComponent(arc) : original.pathname.endsWith('/arcs') ? null : undefined;
      if (value.state !== 'preparing' || expectedArc === undefined || value.arc !== expectedArc || !/^[0-9a-f-]{36}$/.test(value.pending)
        || value.retryAfterMs !== 1000 || (token && token !== value.pending)) throw new ApiError('Malformed preparation response');
      token = value.pending; url.searchParams.set('pending', token!);
      if (Date.now() + value.retryAfterMs >= deadline) throw new ApiError('Browser preparation expired; retry this view');
    }
  } finally { cancel(); signal?.removeEventListener('abort', cancel); }
}
