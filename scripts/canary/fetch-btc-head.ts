/**
 * scripts/canary/fetch-btc-head.ts
 *
 * CLI used by generate.sh to fetch the Bitcoin chain head for the warrant
 * canary, hopping across the canonical DEFAULT_CANARY_BTC_SOURCES list (five
 * independent providers, each with its own HTTP shape) until one answers.
 * Before cp613 the canary hit blockstream.info alone and a single timeout
 * there stalled the whole refresh; cp614 widened it to five providers so a
 * provider outage / region block / Cloudflare 403 no longer stalls it.
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
import { DEFAULT_CANARY_BTC_SOURCES, type CanaryBtcSource } from '@morphit/operator-config';
import { installTorDispatcherIfTorOnly } from './torSocksDispatcher.js';
import {
	type BtcHead,
	fetchBtcHeadWithFailover,
	parseBtcSourceBody,
	resolveCanaryBtcSources
} from './btcHeadFailover.js';

/** Per-source timeout. Matches the old `curl --max-time 15`. */
const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) Morphit-Canary';

/** Live single-source fetch, dispatched by shape. Returns a BtcHead on success
 *  or null on ANY failure so the walk moves to the next provider. */
async function fetchOneLive(source: CanaryBtcSource): Promise<BtcHead | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	const note = (msg: string): null => {
		process.stderr.write(`canary:   ${source.label} -> ${msg}\n`);
		return null;
	};
	try {
		if (source.kind === 'esplora') {
			const root = source.url.replace(/\/+$/, '');
			const [heightResp, hashResp] = await Promise.all([
				fetch(`${root}/blocks/tip/height`, { signal: ctrl.signal, headers: { 'User-Agent': UA } }),
				fetch(`${root}/blocks/tip/hash`, { signal: ctrl.signal, headers: { 'User-Agent': UA } })
			]);
			if (!heightResp.ok || !hashResp.ok) {
				return note(`HTTP ${heightResp.status}/${hashResp.status}`);
			}
			const head = parseBtcSourceBody('esplora', await heightResp.text(), await hashResp.text());
			return head ?? note('malformed tip height/hash');
		}
		const resp = await fetch(source.url, {
			signal: ctrl.signal,
			headers: { 'User-Agent': UA, Accept: 'application/json' }
		});
		if (!resp.ok) return note(`HTTP ${resp.status}`);
		const head = parseBtcSourceBody(source.kind, await resp.text());
		return head ?? note('malformed JSON tip');
	} catch (err) {
		return note(err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	// cp761 — route the BTC explorer fetch over Tor SOCKS on a tor-only node
	// (no-op on clearnet). The BTC head is a SECONDARY proof: if Tor is down the
	// fetch fails and the caller degrades it to "unavailable" — it never falls
	// back to a direct clearnet connection.
	const route = installTorDispatcherIfTorOnly();
	process.stderr.write(`canary: btc-head fetch route = ${route}\n`);
	const sources = resolveCanaryBtcSources(
		process.env.MORPHIT_CANARY_BTC_EXPLORER,
		DEFAULT_CANARY_BTC_SOURCES
	);
	process.stderr.write(
		`canary: fetching Bitcoin chain head (failover across ${sources.length} provider(s))...\n`
	);
	const got = await fetchBtcHeadWithFailover(sources, fetchOneLive);
	if (!got) {
		process.stderr.write(
			`canary: all ${sources.length} Bitcoin provider(s) failed — could not fetch chain head\n`
		);
		process.exit(1);
	}
	process.stderr.write(`canary: got BTC head ${got.head.height} from ${got.source.label}\n`);
	process.stdout.write(`${got.head.height}\t${got.head.hash}\n`);
}

void main();
