/**
 * Centralized fetch-with-timeout helper.
 *
 * cp70 found two un-timeouted fetch() call sites that could hang the
 * UI indefinitely behind a slow Tor circuit or unresponsive server
 * (chainFee.ts and ops-cli/upgrade.ts).  cp71's
 * fetch-must-have-timeout-smoke (cp71-O21) caught 13 more sites
 * across the web app that needed the same treatment.
 *
 * Rather than each call site re-implementing the AbortController +
 * setTimeout + try/finally clearTimeout pattern (and risking drift
 * again), this helper centralizes the contract:
 *
 *   - On timeout, the underlying fetch aborts AND the caller's
 *     awaited fetch() throws a DOMException with name 'AbortError'.
 *   - The setTimeout is always cleared in finally, so callers don't
 *     have to remember.
 *   - Pass any normal RequestInit; the helper merges the signal.
 *
 * Usage:
 *
 *   const res = await fetchWithTimeout(url, { method: 'POST' }, 10_000);
 *
 * Default timeout: 30s.  Use shorter timeouts for UI-blocking calls
 * (e.g. price feeds, availability checks) and longer for downloads.
 *
 * If the caller supplies their own signal (e.g. an outer cancellation
 * source), the helper composes it with the timeout signal via
 * AbortSignal.any() where available; otherwise the timeout wins.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init?: RequestInit,
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	// If the caller passed a signal, compose with our timeout signal.
	// AbortSignal.any is available in evergreen browsers / Node 20+;
	// when it's not, we let the timeout win (the caller's outer
	// cancel still works if they fire their signal before timeout
	// because both signals' aborts are racy).
	let signal: AbortSignal = ac.signal;
	const callerSignal = init?.signal;
	if (callerSignal) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const anyFn = (AbortSignal as any).any;
		if (typeof anyFn === 'function') {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			signal = (anyFn as (s: AbortSignal[]) => AbortSignal)([ac.signal, callerSignal]);
		} else {
			// Fallback: listen for caller abort and forward to ours.
			callerSignal.addEventListener('abort', () => ac.abort(), { once: true });
		}
	}
	try {
		return await fetch(input, { ...init, signal });
	} finally {
		clearTimeout(timer);
	}
}
