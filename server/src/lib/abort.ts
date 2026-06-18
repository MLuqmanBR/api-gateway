// Client-disconnect abort plumbing shared by the /chat/completions and
// /v1/responses routes. When an agent presses Stop or closes the session, the
// underlying socket tears down and the response `close` event fires BEFORE the
// response has finished writing — that's the signal we use to abort the whole
// retry/recovery loop and any in-flight upstream call. (#292)
//
// The hard part is telling a real disconnect apart from a normal completion:
// the response `close` event ALSO fires after `res.end()` on a successful
// response. We therefore check `res.writableEnded` inside the handler before
// aborting — a close after the response is fully written is the normal
// teardown, not a client stop.

import { RequestAbortError } from '../providers/base.js';

/** Resolve the promise after `ms`, but reject early with `RequestAbortError`
 *  if `signal` aborts first. Returns immediately (resolved) when the signal is
 *  already aborted — the caller is expected to check `signal.aborted` at the
 *  loop top too, but resolving early keeps the await from throwing on the
 *  already-settled rejection. (#292) */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortError());
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RequestAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Attach a client-disconnect watcher to an Express response.
 *
 *  Returns an `AbortController` whose `signal` should be threaded into every
 *  provider call and `abortableSleep` in the retry loop. The controller is
 *  aborted when the response's underlying socket closes BEFORE the response has
 *  finished streaming/writing — i.e. a genuine client Stop/disconnect, not
 *  normal completion. The handler removes itself in `detach()` for the
 *  clean-completion path. (#292)
 *
 *  We listen on the RESPONSE's `close` event, NOT the request's. The request
 *  `close` fires as soon as the request BODY has been fully received — which
 *  is long before the response is sent — so it cannot distinguish a real
 *  disconnect from a normal in-progress request (it would abort every single
 *  POST the moment the body finished uploading). The response `close` fires
 *  when the socket tears down, and `res.writableEnded` tells us whether we
 *  finished writing (normal completion) or not (client gone). */
export function attachClientAbort(
  res: { on: (e: 'close', fn: () => void) => void; removeListener: (e: 'close', fn: () => void) => void; writableEnded: boolean },
): { controller: AbortController; detach: () => void } {
  const controller = new AbortController();
  const onClose = () => {
    // Normal completion: the response was fully written before the socket
    // closed. This is the `close` that always fires after `res.end()`; do NOT
    // abort — there's nothing left to cancel and aborting would throw spurious
    // errors into a response that's already gone out.
    if (res.writableEnded) return;
    controller.abort();
  };
  res.on('close', onClose);
  const detach = () => {
    try { res.removeListener('close', onClose); } catch { /* already gone */ }
  };
  return { controller, detach };
}

/** True if `err` is any shape of abort — our `RequestAbortError` or a native
 *  fetch `AbortError`. Re-exported here so routes can import everything
 *  abort-related from one place. (#292) */
export { isAbortError } from '../providers/base.js';
