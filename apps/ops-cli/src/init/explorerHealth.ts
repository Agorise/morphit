/**
 * Morphit ops CLI — block-explorer URL health probes.
 *
 * Used by the wizard during the fee-verifier explorer setup
 * screen.  Hits each configured URL with a tiny harmless
 * request and reports back: reachable + correct API shape /
 * reachable but wrong shape / unreachable.
 *
 * The wizard renders each URL with a status indicator on
 * screen so operators see immediately which explorer they
 * mistyped or which one is currently down.
 *
 * Probing is best-effort and non-blocking — the wizard
 * accepts URLs that fail the probe (the operator might be
 * configuring an explorer that's not online yet, or running
 * the wizard offline).
 *
 * The probes do NOT send any real txids, addresses, proofs,
 * or other user data.  They send well-formed harmless
 * requests using deliberately-incorrect test inputs and
 * accept any structured response (even an "error") as
 * "API-shape ok."  This is intentional: we want to know
 * "does this URL speak the expected API surface" not "is
 * any specific transaction valid."
 */

export type ProbeStatus =
	| { kind: 'ok'; latencyMs: number }
	| { kind: 'wrong_shape'; latencyMs: number; reason: string }
	| { kind: 'unreachable'; reason: string };

import { sanitizeForTerm } from '../render/term.ts';

const PROBE_TIMEOUT_MS = 5_000;

/** Probe a BTC explorer URL.  Expects the Esplora-style API
 *  surface used by blockstream.info / mempool.space (`/api`).
 *  We hit `/blocks/tip/height` which returns a plain number
 *  on healthy explorers and exists on every Esplora-compatible
 *  instance.  No txid, no address sent.
 *
 *  baseUrl: e.g. `https://blockstream.info/api` or
 *  `https://mempool.space/api`.  Trailing `/api` is preserved. */
export async function probeBitcoinExplorer(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<ProbeStatus> {
	const url = `${baseUrl.replace(/\/+$/, '')}/blocks/tip/height`;
	const started = Date.now();
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, {
			method: 'GET',
			headers: { accept: 'text/plain, application/json' },
			signal: ac.signal
		});
		const latencyMs = Date.now() - started;
		if (!res.ok) {
			return {
				kind: 'wrong_shape',
				latencyMs,
				reason: `HTTP ${res.status}`
			};
		}
		const text = (await res.text()).trim();
		// Esplora returns a single integer.  Anything else means
		// this URL isn't an Esplora endpoint.
		if (!/^\d{1,12}$/.test(text)) {
			return {
				kind: 'wrong_shape',
				latencyMs,
				reason: 'response is not a numeric block height (not Esplora API?)'
			};
		}
		return { kind: 'ok', latencyMs };
	} catch (err) {
		const reason =
			err instanceof Error
				? err.name === 'AbortError'
					? `timeout after ${PROBE_TIMEOUT_MS}ms`
					: err.message
				: String(err);
		return { kind: 'unreachable', reason };
	} finally {
		clearTimeout(timer);
	}
}

/** Probe a Monero explorer URL.  Expects the
 *  `moneroexamples/onion-monero-blockchain-explorer` API
 *  surface — same one xmrchain.net, localmonero.co/blocks,
 *  etc. use.  We hit `/api/networkinfo` which returns a
 *  small JSON object and exists on every compatible
 *  instance.  No txid, no address, no proof sent.
 *
 *  baseUrl: e.g. `https://xmrchain.net`. */
export async function probeMoneroExplorer(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<ProbeStatus> {
	const url = `${baseUrl.replace(/\/+$/, '')}/api/networkinfo`;
	const started = Date.now();
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: ac.signal
		});
		const latencyMs = Date.now() - started;
		if (!res.ok) {
			return {
				kind: 'wrong_shape',
				latencyMs,
				reason: `HTTP ${res.status}`
			};
		}
		const body = (await res.json()) as unknown;
		// Expected shape:
		//   { status: "success", data: { height: <number>, ... } }
		if (
			typeof body !== 'object' ||
			body === null ||
			!('status' in body) ||
			!('data' in body)
		) {
			return {
				kind: 'wrong_shape',
				latencyMs,
				reason:
					'response missing status/data keys (not onion-monero-blockchain-explorer API?)'
			};
		}
		const data = (body as { data: unknown }).data;
		if (typeof data !== 'object' || data === null || !('height' in data)) {
			return {
				kind: 'wrong_shape',
				latencyMs,
				reason: 'response.data missing height (not the expected explorer codebase?)'
			};
		}
		return { kind: 'ok', latencyMs };
	} catch (err) {
		const reason =
			err instanceof Error
				? err.name === 'AbortError'
					? `timeout after ${PROBE_TIMEOUT_MS}ms`
					: err.message
				: String(err);
		return { kind: 'unreachable', reason };
	} finally {
		clearTimeout(timer);
	}
}

/** Probe a chat-link explorer URL (the kind the frontend
 *  uses to route txid clicks to a third-party tx-detail
 *  page).  These are human-facing HTML pages, not APIs —
 *  the only check we can do is "does the host respond at
 *  all to a HEAD."  The expected URL template contains
 *  `{txid}` somewhere; we strip the template and probe
 *  the root.
 *
 *  urlTemplate: e.g. `https://xmrchain.net/tx/{txid}` */
export async function probeChatLinkExplorer(
	urlTemplate: string,
	fetchImpl: typeof fetch = fetch
): Promise<ProbeStatus> {
	let probeUrl: string;
	try {
		const tplWithSample = urlTemplate.replace(
			/\{txid\}/g,
			'0000000000000000000000000000000000000000000000000000000000000000'
		);
		const parsed = new URL(tplWithSample);
		probeUrl = `${parsed.protocol}//${parsed.host}/`;
	} catch {
		return { kind: 'unreachable', reason: 'could not parse template as URL' };
	}
	const started = Date.now();
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(probeUrl, {
			method: 'HEAD',
			signal: ac.signal
		});
		const latencyMs = Date.now() - started;
		// Anything in the 200-399 range (incl. redirects) → reachable.
		// Many explorers respond 405 to HEAD or block it entirely; we
		// can't distinguish "broken" from "deliberate-no-HEAD" without
		// a GET, so for HEAD we accept anything < 500 as reachable.
		if (res.status >= 500) {
			return {
				kind: 'wrong_shape',
				latencyMs,
				reason: `HTTP ${res.status}`
			};
		}
		return { kind: 'ok', latencyMs };
	} catch (err) {
		const reason =
			err instanceof Error
				? err.name === 'AbortError'
					? `timeout after ${PROBE_TIMEOUT_MS}ms`
					: err.message
				: String(err);
		return { kind: 'unreachable', reason };
	} finally {
		clearTimeout(timer);
	}
}

/** Render a ProbeStatus as a one-line summary with an
 *  emoji prefix suitable for the wizard screen.  Used by
 *  the explorer-URL editor as it polls each URL on the
 *  list and prints results inline.
 *
 *  cp139-C-9: s.reason can include HTTP server response text
 *  or fetch-library error messages.  These have flowed from
 *  attacker-controllable network responses, so strip terminal
 *  escapes before returning the string for display. */
export function renderProbeStatus(s: ProbeStatus): string {
	switch (s.kind) {
		case 'ok':
			return `✓ ok (${s.latencyMs}ms)`;
		case 'wrong_shape':
			return `⚠ unexpected response (${s.latencyMs}ms): ${sanitizeForTerm(s.reason)}`;
		case 'unreachable':
			return `✗ unreachable: ${sanitizeForTerm(s.reason)}`;
	}
}
