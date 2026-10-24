/**
 * scripts/canary/fetch-btc-head.ts
 *
 * CLI used by generate.sh to fetch the Bitcoin chain head for the warrant
 * canary, hopping across the canonical DEFAULT_CANARY_BTC_SOURCES list (five
 * independent providers, each with its own HTTP shape) until one answers.
 * Previously the canary hit blockstream.info alone and a single timeout
 * there stalled the whole refresh; a later change widened it to five providers so a
 * provider outage / region block / Cloudflare 403 no longer stalls it.
 *
 * v1.21.15: the onion Esplora explorers (DEFAULT_CANARY_BTC_HIDDEN_SOURCES)
 * are asked too, all at once, the fastest valid answer winning: FIRST on a
 * Tor-only node, and on a clearnet node only when every clearnet source above
 * failed. A hidden source is reached only through the local Tor SOCKS proxy
 * (MORPHIT_CANARY_TOR_SOCKS) or i2pd (MORPHIT_CANARY_I2P_HTTP_PROXY) — with no
 * proxy configured it is skipped, never dialled directly.
 *
 * The source list + shapes are imported from @morphit/operator-config (one
 * source of truth); the per-shape RESPONSE parsing lives in the pure,
 * unit-tested btcHeadFailover.ts.
 *
 * Contract:
 *   stdout — on success, exactly ONE tab-separated line: <height>\t<hash>
 *   stderr — progress + which provider answered (kept off stdout so the line
 *            stays clean and machine-parseable)
 *   exit   — 0 on success, 1 if EVERY source failed. generate.sh treats a
 *            non-zero exit as NON-fatal (the Bitcoin head is SECONDARY to the
 *            Blurt head) and degrades the canary's BTC line rather than
 *            aborting the whole refresh.
 */
import {
	DEFAULT_CANARY_BTC_HIDDEN_SOURCES,
	DEFAULT_CANARY_BTC_SOURCES,
	type CanaryBtcSource
} from '@morphit/operator-config';
import { hiddenNetworkOf } from '@morphit/hidden-transport';
import {
	canaryHiddenDispatcherFor,
	canaryHostLooksHidden,
	canaryIsTorOnly,
	installTorDispatcherIfTorOnly
} from './torSocksDispatcher.js';
import {
	type BtcHead,
	fetchBtcHeadPhased,
	parseBtcSourceBody,
	planCanaryBtcPhases
} from './btcHeadFailover.js';
import { readTextCapped } from './readCapped.js';

/** Per-source timeout. Matches the old `curl --max-time 15`. */
const TIMEOUT_MS = 15_000;
/** Per-source timeout for an onion / I2P explorer (a rendezvous alone can
 *  take tens of seconds; the indexer allows 60 s for the same sources). */
const HIDDEN_TIMEOUT_MS = 60_000;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Morphit-Canary';

/** An error and the reason under it: undici reports every connection failure
 *  as "fetch failed" and keeps the real one (refused, TLS, proxy) in `cause`. */
function errText(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	return cause instanceof Error && cause.message !== err.message
		? `${err.message} (${cause.message})`
		: err.message;
}

/** Live single-source fetch, dispatched by shape. Returns a BtcHead on success
 *  or null on ANY failure so the walk moves to the next provider. */
async function fetchOneLive(source: CanaryBtcSource): Promise<BtcHead | null> {
	const note = (msg: string): null => {
		process.stderr.write(`canary:   ${source.label} -> ${msg}\n`);
		return null;
	};
	const hiddenNet =
		hiddenNetworkOf(source.url) ?? (canaryHostLooksHidden(source.url) ? 'hidden' : null);
	const isHidden = hiddenNet !== null;
	const dispatcher = isHidden ? canaryHiddenDispatcherFor(source.url) : null;
	if (isHidden && dispatcher === null) return note(`no ${hiddenNet} proxy configured — skipped`);
	// lib.dom's RequestInit omits undici's `dispatcher`; Node's fetch honours it.
	const via = dispatcher === null ? {} : ({ dispatcher } as Record<string, unknown>);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), isHidden ? HIDDEN_TIMEOUT_MS : TIMEOUT_MS);
	try {
		if (source.kind === 'esplora') {
			const root = source.url.replace(/\/+$/, '');
			const [heightResp, hashResp] = await Promise.all([
				fetch(`${root}/blocks/tip/height`, {
					...via,
					signal: ctrl.signal,
					headers: { 'User-Agent': UA }
				}),
				fetch(`${root}/blocks/tip/hash`, {
					...via,
					signal: ctrl.signal,
					headers: { 'User-Agent': UA }
				})
			]);
			if (!heightResp.ok || !hashResp.ok) {
				return note(`HTTP ${heightResp.status}/${hashResp.status}`);
			}
			const [heightText, hashText] = await Promise.all([
				readTextCapped(heightResp),
				readTextCapped(hashResp)
			]);
			if (heightText === null || hashText === null)
				return note('answer larger than 64 KB — not used');
			const head = parseBtcSourceBody('esplora', heightText, hashText);
			return head ?? note('malformed tip height/hash');
		}
		const resp = await fetch(source.url, {
			...via,
			signal: ctrl.signal,
			headers: { 'User-Agent': UA, Accept: 'application/json' }
		});
		if (!resp.ok) return note(`HTTP ${resp.status}`);
		const text = await readTextCapped(resp);
		if (text === null) return note('answer larger than 64 KB — not used');
		const head = parseBtcSourceBody(source.kind, text);
		return head ?? note('malformed JSON tip');
	} catch (err) {
		return note(errText(err));
	} finally {
		clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	// route the BTC explorer fetch over Tor SOCKS on a tor-only node
	// (no-op on clearnet). The BTC head is a SECONDARY proof: if Tor is down the
	// fetch fails and the caller degrades it to "unavailable" — it never falls
	// back to a direct clearnet connection.
	const route = installTorDispatcherIfTorOnly();
	process.stderr.write(`canary: btc-head fetch route = ${route}\n`);
	// v1.21.15: hidden explorers too — first (all at once, the fastest valid
	// answer wins) on a Tor-only node; on a clearnet node only after every
	// clearnet source failed. They go through Tor / i2pd only.
	const phases = planCanaryBtcPhases({
		override: process.env.MORPHIT_CANARY_BTC_EXPLORER,
		torOnly: canaryIsTorOnly(),
		clearnet: DEFAULT_CANARY_BTC_SOURCES,
		hidden: DEFAULT_CANARY_BTC_HIDDEN_SOURCES
	});
	const total = phases.reduce((n, p) => n + p.sources.length, 0);
	process.stderr.write(
		`canary: fetching Bitcoin chain head (${phases
			.map((p) => `${p.sources.length} ${p.mode === 'race' ? 'hidden, fastest wins' : 'in order'}`)
			.join(', then ')})...\n`
	);
	const got = await fetchBtcHeadPhased(phases, fetchOneLive);
	if (!got) {
		process.stderr.write(
			`canary: all ${total} Bitcoin provider(s) failed — could not fetch chain head\n`
		);
		process.exit(1);
	}
	process.stderr.write(`canary: got BTC head ${got.head.height} from ${got.source.label}\n`);
	// Exit once the line is out: a connection still open (a Tor exit that
	// never finished a handshake for an earlier source) must not keep this
	// process — and generate.sh, which waits for it — alive.
	process.stdout.write(`${got.head.height}\t${got.head.hash}\n`, () => process.exit(0));
}

void main();
