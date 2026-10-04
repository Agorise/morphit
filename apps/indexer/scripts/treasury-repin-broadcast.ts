/**
 * Morphit — treasury auto-re-pin BROADCAST.
 *
 * The ACTING half of the auto-re-pin system: fetch the current
 * release + live prices, decide (the pure core), and — if a re-pin
 * is due AND auto-broadcast is explicitly enabled — build a fresh
 * `morphit_release_v1` op (same version / hash_manifest / endpoints,
 * only the treasury AMOUNTS updated) and broadcast it signed by the
 * @morphit posting key.
 *
 * ┌───────────────────────────────────────────────────────────────┐
 * │  SECURITY — READ THIS.  This is the ONE part of the auto-re-pin │
 * │  system that needs the @morphit POSTING KEY available           │
 * │  non-interactively.  The posting key can broadcast release ops, │
 * │  which set the treasury — i.e. a leaked key could re-pin fees   │
 * │  to a hostile address.  So:                                     │
 * │    • This script REFUSES to broadcast unless you pass           │
 * │      --enable-auto-broadcast (a deliberate opt-in).             │
 * │    • Run it ONLY on a trusted signing box / laptop — NEVER on   │
 * │      the public production server (same rule as                 │
 * │      release-broadcast.ts).                                     │
 * │    • The DEFAULT (no flag) is detect-only: it reports a due     │
 * │      re-pin and exits 3, so the maintainer broadcasts by hand   │
 * │      (release-build-payload.ts | release-broadcast.ts) — the    │
 * │      Plan-B path that always works without any key online.      │
 * └───────────────────────────────────────────────────────────────┘
 *
 * WHERE THE CURRENT OP COMES FROM (v1.20.0, V3-1). /v1/release only says
 * WHICH release op is current (block + trx id); the op itself is read from
 * that block on chain, from two RPC endpoints that must agree, and the node's
 * served treasury must equal it — otherwise the tool REFUSES (exit 1) and names
 * the fields the node is missing. A node that indexed the pin release while on
 * v1.19 serves the treasury without btc.xpub / xmr.primary_address; building
 * from that would have broadcast a release dropping them for everyone. The
 * next op keeps every field of the chain op (distribution, …) and
 * changes only the treasury amounts.
 *
 * FAILSAFES (belt + suspenders, mostly inherited from the pure core):
 *   • EITHER fetch (release / prices) fails → abort, exit 1, NOTHING
 *     broadcast.  A network blip can never trigger a re-pin.
 *   • Prices: CoinGecko, CoinPaprika and Kraken are each asked
 *     (treasury-repin-prices.ts); an asset is re-pinned only from a price
 *     at least two of them agree on (within 5%), else it is skipped.
 *   • The core refuses a computed amount above a realistic ceiling, and
 *     moves an existing pin by at most ×2 / ÷2 per re-pin; a larger move
 *     is left to the operator.  buildReleaseCustomJsonOp's
 *     validateTreasury re-checks the payload before signing.
 *   • The transaction is signed ONCE and the same signed transaction is
 *     offered to the ranked nodes (lib/signOnceBroadcast.ts), so a lost
 *     answer can never put two re-pins on chain.
 *   • buildReleaseCustomJsonOp validates the WHOLE payload (semver,
 *     hash_manifest, endpoints, treasury) + runs the no-secret-hex
 *     guard — an invalid payload is never broadcast.
 *   • --dry-run shows the exact op + exits without requesting the key.
 *
 * Usage:
 *   # detect-only (safe, no key; for a timer that alerts):
 *   tsx treasury-repin-broadcast.ts --node https://indexer.example.com
 *
 *   # opt-in unattended auto-broadcast (trusted signing box ONLY):
 *   MORPHIT_REPIN_POSTING_KEY_FILE=/etc/morphit/repin.key \
 *   tsx treasury-repin-broadcast.ts --node <url> \
 *     --enable-auto-broadcast --unattended
 *
 * Exit codes: 0 = no re-pin due (or broadcast OK), 3 = re-pin due but
 * not auto-broadcast (detect-only / no key), 1 = error.
 */

import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PrivateKey } from '@beblurt/dblurt';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import {
	buildReleaseCustomJsonOp,
	RELEASE_SIGNER_DEFAULT,
	RELEASE_OP_ID
} from '../src/blurt/releaseBroadcastOp.ts';
import {
	decideRepin,
	buildRepinnedTreasury,
	parseReleaseTreasury,
	DEFAULT_REPIN_DRIFT_THRESHOLD,
	type RepinPrices
} from '../src/lib/treasuryRepin.ts';
import { checkServedAgainstChain, fetchReleasePayloadFromChain } from '../src/lib/repinSource.ts';
import { describeQuotes, fetchAgreedPrices } from './treasury-repin-prices.ts';
import { broadcastCustomJsonOnce } from './lib/signOnceBroadcast.ts';

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
function out(s: string): void {
	process.stderr.write(s + '\n');
}

// ── argv ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let node: string | null = null;
let signer = RELEASE_SIGNER_DEFAULT;
let keyFile: string | null = process.env.MORPHIT_REPIN_POSTING_KEY_FILE ?? null;
let threshold = DEFAULT_REPIN_DRIFT_THRESHOLD;
let enableAutoBroadcast = false;
let unattended = false;
let dryRun = false;
let broadcastNode: string | null = null;
const rpcNodes: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--node') node = argv[++i] ?? null;
	else if (a === '--signer') signer = argv[++i] ?? signer;
	else if (a === '--key-file') keyFile = argv[++i] ?? keyFile;
	else if (a === '--threshold') threshold = Number.parseFloat(argv[++i] ?? '');
	else if (a === '--enable-auto-broadcast') enableAutoBroadcast = true;
	else if (a === '--unattended') unattended = true;
	else if (a === '--dry-run') dryRun = true;
	else if (a === '--broadcast-node') broadcastNode = argv[++i] ?? null;
	else if (a === '--rpc') rpcNodes.push(argv[++i] ?? '');
}
if (node === null) {
	out(
		'usage: tsx treasury-repin-broadcast.ts --node <indexer-url> [--threshold 0.1]\n' +
			'         [--enable-auto-broadcast --unattended] [--key-file <path>]\n' +
			'         [--signer morphit] [--broadcast-node <rpc>] [--rpc <rpc> …] [--dry-run]\n' +
			'  default (no --enable-auto-broadcast) = DETECT-ONLY, no key, exit 3 if due.'
	);
	process.exit(1);
}
if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 0.15) {
	out(`invalid --threshold ${threshold} (must be >0 and <0.15, inside the verifier band)`);
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

function ask(query: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(query, (ans) => {
			rl.close();
			resolve(ans.trim());
		});
	});
}

/** Load the posting WIF from a key file.  Refuses a world-/group-
 *  readable file (defense against an over-permissive key on a shared
 *  box) and a string that doesn't look like a Blurt WIF. */
function loadKey(path: string): PrivateKey {
	let raw: string;
	try {
		const st = statSync(path);
		// Reject group/other read or write bits (anything but 0600/0400).
		if ((st.mode & 0o077) !== 0) {
			throw new Error(
				`key file ${path} is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}); ` +
					'chmod 600 it before using auto-broadcast.'
			);
		}
		raw = readFileSync(path, 'utf-8').trim();
	} catch (e) {
		throw new Error(`cannot read key file: ${errMsg(e)}`);
	}
	if (!raw.startsWith('5') || raw.length < 50) {
		throw new Error('key file does not contain a Blurt posting WIF (expected a "5..." string).');
	}
	return PrivateKey.fromString(raw);
}

async function main(): Promise<void> {
	// Fetch release + prices.  Either failure → abort, no recommendation.
	let releaseBody: unknown;
	let prices: RepinPrices;
	try {
		releaseBody = await fetchJson(`${node!.replace(/\/$/, '')}/v1/release`);
	} catch (e) {
		out(`✗ could not fetch ${node}/v1/release: ${errMsg(e)} — aborting (no recommendation).`);
		process.exit(1);
	}
	const fetched = await fetchAgreedPrices();
	prices = fetched.prices;
	if (prices.btcUsd === null && prices.xmrUsd === null && prices.blurtUsd === null) {
		out('✗ no asset has a price two sources agree on — aborting (no recommendation).');
		for (const l of describeQuotes(fetched.quotes, prices)) out(`  ${l}`);
		process.exit(1);
	}

	const rel = releaseBody as {
		version?: unknown;
		hash_manifest?: unknown;
		endpoints?: unknown;
		treasury?: unknown;
		source_block_num?: unknown;
		source_trx_id?: unknown;
	} | null;
	// (V3-1) The op itself, from chain, from two agreeing RPC endpoints.
	if (typeof rel?.source_block_num !== 'number' || typeof rel?.source_trx_id !== 'string') {
		out(
			'✗ /v1/release did not say which op is current (source_block_num / source_trx_id) — aborting.'
		);
		process.exit(1);
	}
	const chain = await fetchReleasePayloadFromChain(
		rel.source_block_num,
		rel.source_trx_id,
		signer,
		rpcNodes.length > 0 ? rpcNodes : [...DEFAULT_BLURT_RPC_ENDPOINTS],
		async (url, body) => {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 15_000);
			try {
				const res = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify(body),
					signal: ac.signal
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return (await res.json()) as { result?: unknown };
			} finally {
				clearTimeout(t);
			}
		}
	);
	if (!chain.ok) {
		out(
			`✗ could not read the current release op from chain: ${chain.reason} — aborting (no recommendation).`
		);
		process.exit(1);
	}
	const served = checkServedAgainstChain(rel, chain.payload);
	if (!served.ok) {
		out(`✗ refusing: ${served.reason}.`);
		if (served.missing.length > 0)
			out(`  missing or different on ${node}: ${served.missing.join(', ')}`);
		out(
			'  Point --node at an indexer running the current version (it re-reads stored releases at boot).'
		);
		process.exit(1);
	}
	const parsed = parseReleaseTreasury(served.chainTreasury);
	const decision = decideRepin(parsed.pinned, prices, threshold);

	out('Treasury auto-re-pin');
	for (const l of describeQuotes(fetched.quotes, prices)) out(`  ${l}`);
	out(`  ${decision.btc.note}`);
	out(`  ${decision.xmr.note}`);
	out(`  ${decision.blurt.note}`);

	if (!decision.shouldRepin) {
		out('\n✓ No re-pin due — pinned amounts within tolerance of the canonical USD targets.');
		process.exit(0);
	}

	out('\n⚠ Re-pin DUE.');

	// Build the fresh full payload: keep version / hash_manifest /
	// endpoints, swap only the treasury amounts.
	const next = buildRepinnedTreasury(decision, parsed.addresses, parsed.pinned);
	const payload = { ...served.base, treasury: next };
	const payloadJson = JSON.stringify(payload);

	// Validate the WHOLE payload (incl. the new treasury) BEFORE we
	// ever touch a key.  Throws → abort, never broadcast invalid.
	let op;
	try {
		op = buildReleaseCustomJsonOp(payloadJson, signer);
	} catch (e) {
		out(`✗ refusing to broadcast — payload failed validation: ${errMsg(e)}`);
		process.exit(1);
	}

	if (!enableAutoBroadcast) {
		// DETECT-ONLY (default + Plan B).  Print the op the maintainer
		// would broadcast, then exit 3 so a timer can alert.
		out('\nAuto-broadcast NOT enabled (default).  The op a re-pin would broadcast:');
		process.stdout.write(op.json + '\n');
		out(
			'\nTo broadcast: either (Plan B) feed this treasury into release-build-payload.ts ' +
				'| release-broadcast.ts on your signing box, or re-run with ' +
				'--enable-auto-broadcast (trusted signing box ONLY).'
		);
		process.exit(3);
	}

	// ── opt-in auto-broadcast path ──────────────────────────────────
	out('\nExact json to sign + broadcast:');
	out(op.json);

	if (dryRun) {
		out('\n--dry-run: NOTHING broadcast, NO key requested.');
		process.exit(0);
	}
	if (keyFile === null) {
		out(
			'✗ --enable-auto-broadcast set but no key file ' +
				'(--key-file <path> or MORPHIT_REPIN_POSTING_KEY_FILE). Aborting.'
		);
		process.exit(1);
	}

	let priv: PrivateKey;
	try {
		priv = loadKey(keyFile);
	} catch (e) {
		out(`✗ ${errMsg(e)}`);
		process.exit(1);
	}

	if (!unattended) {
		const go = await ask(`\nBroadcast this re-pin signed by @${signer} now? (type "yes"): `);
		if (go !== 'yes') {
			out('aborted.');
			process.exit(1);
		}
	}

	const opData = {
		required_auths: [...op.required_auths],
		required_posting_auths: [...op.required_posting_auths],
		id: op.id,
		json: op.json
	};
	try {
		const r = await broadcastCustomJsonOnce(opData, priv, {
			nodeOverride: broadcastNode,
			includeHidden: false
		});
		process.stdout.write(
			`✓ Re-pin broadcast ${r.duplicate ? 'already on chain' : 'accepted'}.\n  trx_id    : ${r.trxId}\n` +
				`  block_num : ${r.blockNum ?? '(pending)'}\n  op id     : ${RELEASE_OP_ID}\n` +
				'Every Morphit instance picks up the re-pinned treasury within a block.\n'
		);
		process.exit(0);
	} catch (e) {
		out(`✗ ${errMsg(e)}`);
		process.exit(1);
	}
}

void main();
