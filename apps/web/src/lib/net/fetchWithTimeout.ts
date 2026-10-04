/**
 * Centralized fetch-with-timeout helper.
 *
 * A later change found two un-timeouted fetch() call sites that could hang the
 * UI indefinitely behind a slow Tor circuit or unresponsive server
 * (chainFee.ts and ops-cli/upgrade.ts).  The
 * fetch-must-have-timeout-smoke caught 13 more sites
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
 *   - Whatever budget is given is a CLEARNET budget. When the request
 *     crosses a Tor or I2P transport the helper raises it to the hidden
 *     floor (see $net/transportBudget); it never shortens one.
 *   - The budget covers the BODY as well as the connection, so callers
 *     must consume the body within it.
 *
 * If the caller supplies their own signal (e.g. an outer cancellation
 * source), the helper composes it with the timeout signal via
 * AbortSignal.any() where available; otherwise the timeout wins.
 */

import { withHiddenFloor } from '$net/transportBudget';

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** The target of a fetch, as a string, for transport classification. A
 *  `Request` carries its own url; a relative string or URL is same-origin,
 *  which `withHiddenFloor` resolves against the current page. */
function urlOf(input: RequestInfo | URL): string | null {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	const r = input as { url?: unknown };
	return typeof r.url === 'string' ? r.url : null;
}

export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init?: RequestInit,
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
	const ac = new AbortController();
	// EVERY budget gets the hidden-transport floor, not just the ones whose
	// authors remembered.
	//
	// The numbers callers pass are clearnet numbers — 8s, 10s, 15s, the 30s
	// default — chosen when the request was a TCP connection to a host with an
	// A record. None of them survive a cold Tor circuit or I2P tunnel, which
	// routinely takes 30-60 seconds before a byte moves. Fixing the sites that
	// had been noticed one at a time left the rest of them broken and silently
	// waiting for the next person to trip over: the chat-identity read was
	// found first, and behind it were the chain head every send depends on, the
	// key-reference lookup, the profile batch, the fee store, account creation,
	// the direct RPC rotator and a static poll — each failing in its own
	// unrelated-looking way.
	//
	// So the floor is applied HERE, where no call site can miss it. It only
	// ever RAISES, and only when the request actually crosses a hidden
	// transport, so clearnet behaviour is untouched. A call that needs longer
	// still than the floor — anything the indexer answers with a real chain RPC
	// — passes its own larger number through `chainCallTimeoutMs`.
	const effectiveMs = withHiddenFloor(timeoutMs, urlOf(input));
	const timer = setTimeout(() => ac.abort(), effectiveMs);
	// If the caller passed a signal, compose with our timeout signal.
	// AbortSignal.any is available in evergreen browsers / Node 20+;
	// when it's not, we let the timeout win (the caller's outer
	// cancel still works if they fire their signal before timeout
	// because both signals' aborts are racy).
	let signal: AbortSignal = ac.signal;
	const callerSignal = init?.signal;
	if (callerSignal) {
		// Typed as optional rather than cast through `any`: the eslint-disable
		// comments this used named a rule the web config does not load, which
		// eslint reports as an ERROR — the only errors in the web lint.
		const anyFn = (AbortSignal as unknown as { any?: unknown }).any;
		if (typeof anyFn === 'function') {
			signal = (anyFn as (s: AbortSignal[]) => AbortSignal)([ac.signal, callerSignal]);
		} else {
			// Fallback: listen for caller abort and forward to ours.
			callerSignal.addEventListener('abort', () => ac.abort(), { once: true });
		}
	}
	try {
		const res = await fetch(input, { ...init, signal });
		// DELIBERATELY NOT cleared here.
		//
		// `fetch()` resolves as soon as the RESPONSE HEADERS arrive; the body is
		// still streaming. Clearing the timer at that moment meant the budget
		// covered connect-and-headers only, and the body read that follows had
		// NO timeout at all. A connection that dies or stalls after headers —
		// the most ordinary failure on a Tor circuit or an I2P tunnel — left the
		// caller's `await res.json()` hanging forever. Not slow: never. The
		// symptom is a spinner that never resolves and a message stuck pending
		// with no error and no retry, which is worse than a clean timeout.
		//
		// Measured against a server that sends headers then stalls: with a 2s
		// budget, fetch() resolved in 66ms and the body read was still hanging
		// 8s later.
		//
		// Leaving the timer armed keeps the abort signal live for the whole
		// exchange. Once the body has been consumed the abort is a no-op, so
		// this costs nothing on the happy path; while the body is still
		// streaming past the budget it does exactly what the caller asked for
		// and aborts. Callers must therefore consume the body within the budget,
		// which every caller in this app already does.
		//
		// unref() where available (Node, and so the smoke battery) so a pending
		// timer cannot hold the process open after the work is done. It does not
		// exist in browsers, where a pending timer is harmless.
		(timer as unknown as { unref?: () => void }).unref?.();
		return res;
	} catch (err) {
		clearTimeout(timer);
		throw err;
	}
}
