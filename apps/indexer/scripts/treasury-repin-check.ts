/**
 * Morphit — treasury auto-re-pin DRIFT CHECK (cp372).
 *
 * The automatable, READ-ONLY half of the auto-re-pin system: it
 * fetches the current chain-pinned treasury + live USD prices,
 * runs the pure decision core (decideRepin), and reports whether a
 * re-pin is due — and, with --emit, prints the exact treasury block
 * a re-pin would broadcast.  It NEVER signs or broadcasts anything
 * and needs no key, so it is safe to run unattended on a timer.
 *
 * Intended use (the "set once, never touch" automation):
 *
 *   # systemd timer, daily — detect + alert (no key, no broadcast):
 *   tsx treasury-repin-check.ts --node https://indexer.morphit.io
 *
 *   # when it reports a re-pin is due, emit the fresh treasury and
 *   # fold it into a release payload, then broadcast (Plan-B manual,
 *   # key-gated — the deliberate safety boundary):
 *   tsx treasury-repin-check.ts --node <url> --emit > treasury.json
 *   MORPHIT_BUILD_BLURT_BASE=$(jq -r .blurt.base treasury.json) \
 *     ... tsx release-build-payload.ts > release.json
 *   tsx release-broadcast.ts release.json     # laptop, key-gated
 *
 * Exit codes: 0 = no re-pin due (or --emit succeeded), 3 = re-pin
 * due (so a timer/cron can branch on it), 1 = error.  Choosing a
 * non-zero "due" code lets a wrapper alert without treating it as a
 * failure.
 *
 * Failsafes live in the pure core (treasuryRepin.ts): a down/zero
 * price skips that asset (never re-pinned from a bad feed); a
 * computed amount over the validator's sanity ceiling is rejected;
 * one bad feed never blocks a healthy asset.  This wrapper adds:
 * if EITHER fetch fails, it exits 1 WITHOUT recommending anything —
 * a network blip can never trigger a spurious re-pin.
 */

import {
	decideRepin,
	buildRepinnedTreasury,
	parseReleaseTreasury,
	DEFAULT_REPIN_DRIFT_THRESHOLD,
	type RepinPrices
} from '../src/lib/treasuryRepin.ts';

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
function out(s: string): void {
	process.stderr.write(s + '\n');
}

// ── argv ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let node: string | null = null;
let emit = false;
let threshold = DEFAULT_REPIN_DRIFT_THRESHOLD;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--node') node = argv[++i] ?? null;
	else if (a === '--emit') emit = true;
	else if (a === '--threshold') threshold = Number.parseFloat(argv[++i] ?? '');
}
if (node === null) {
	out('usage: tsx treasury-repin-check.ts --node <indexer-url> [--emit] [--threshold 0.1]');
	process.exit(1);
}
if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 0.15) {
	// Must stay inside the verifier's FEE_PRICE_TOLERANCE (0.15) band.
	out(`invalid --threshold ${threshold} (must be >0 and <0.15)`);
	process.exit(1);
}

async function fetchJson(url: string): Promise<unknown> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 10_000);
	try {
		const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** Live BTC/XMR/BLURT USD prices from Coingecko.  A failed or
 *  malformed fetch yields nulls for the affected assets — the pure
 *  core then skips them (never re-pins from a bad price). */
async function fetchPrices(): Promise<RepinPrices> {
	const url =
		'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,monero,blurt&vs_currencies=usd';
	const body = (await fetchJson(url)) as Record<string, { usd?: unknown }>;
	const num = (v: unknown): number | null =>
		typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
	return {
		btcUsd: num(body.bitcoin?.usd),
		xmrUsd: num(body.monero?.usd),
		blurtUsd: num(body.blurt?.usd)
	};
}

async function main(): Promise<void> {
	// Fetch the current release + prices.  If EITHER fails we abort
	// without recommending anything — a network blip must never move
	// the pin.
	let releaseBody: unknown;
	let prices: RepinPrices;
	try {
		releaseBody = await fetchJson(`${node!.replace(/\/$/, '')}/v1/release`);
	} catch (e) {
		out(`✗ could not fetch ${node}/v1/release: ${errMsg(e)} — aborting (no recommendation).`);
		process.exit(1);
	}
	try {
		prices = await fetchPrices();
	} catch (e) {
		out(`✗ could not fetch prices: ${errMsg(e)} — aborting (no recommendation).`);
		process.exit(1);
	}

	const treasury = (releaseBody as { treasury?: unknown } | null)?.treasury ?? null;
	const parsed = parseReleaseTreasury(treasury);
	const decision = decideRepin(parsed.pinned, prices, threshold);

	out('Treasury re-pin drift check');
	out(`  prices  : BTC=${prices.btcUsd ?? 'n/a'}  XMR=${prices.xmrUsd ?? 'n/a'}  BLURT=${prices.blurtUsd ?? 'n/a'}`);
	out(`  threshold: ${(threshold * 100).toFixed(0)}%  (verifier band is 15%)`);
	out(`  ${decision.btc.note}`);
	out(`  ${decision.xmr.note}`);
	out(`  ${decision.blurt.note}`);

	if (!decision.shouldRepin) {
		out('\n✓ No re-pin due — pinned amounts are within tolerance of the canonical USD targets.');
		process.exit(0);
	}

	out('\n⚠ Re-pin DUE — at least one asset has drifted past the threshold.');
	if (emit) {
		const next = buildRepinnedTreasury(decision, parsed.addresses, parsed.pinned);
		// stdout carries ONLY the machine-readable treasury block, so
		// `--emit > treasury.json` is clean for downstream tooling.
		process.stdout.write(JSON.stringify(next, null, 2) + '\n');
	} else {
		out('  Re-run with --emit to print the fresh treasury block to broadcast.');
	}
	// Exit 3 = "due" so a timer wrapper can branch (alert / auto-broadcast).
	process.exit(3);
}

void main();
