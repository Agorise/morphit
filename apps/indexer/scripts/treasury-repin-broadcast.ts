/**
 * Morphit — treasury auto-re-pin BROADCAST (cp372).
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
 * FAILSAFES (belt + suspenders, mostly inherited from the pure core):
 *   • EITHER fetch (release / prices) fails → abort, exit 1, NOTHING
 *     broadcast.  A network blip can never trigger a re-pin.
 *   • A down/zero/negative feed → that asset is skipped by the core;
 *     a computed amount over the validator's sanity ceiling → rejected
 *     by the core AND re-checked by buildReleaseCustomJsonOp's
 *     validateTreasury before signing.  An absurd price can never pin
 *     an absurd amount.
 *   • buildReleaseCustomJsonOp validates the WHOLE payload (semver,
 *     hash_manifest, endpoints, treasury) + runs the no-secret-hex
 *     guard — an invalid payload is never broadcast.
 *   • --dry-run shows the exact op + exits without requesting the key.
 *
 * Usage:
 *   # detect-only (safe, no key; for a timer that alerts):
 *   tsx treasury-repin-broadcast.ts --node https://indexer.morphit.io
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
import { Client, PrivateKey } from '@beblurt/dblurt';
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
}
if (node === null) {
	out(
		'usage: tsx treasury-repin-broadcast.ts --node <indexer-url> [--threshold 0.1]\n' +
			'         [--enable-auto-broadcast --unattended] [--key-file <path>]\n' +
			'         [--signer morphit] [--broadcast-node <rpc>] [--dry-run]\n' +
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
	try {
		prices = await fetchPrices();
	} catch (e) {
		out(`✗ could not fetch prices: ${errMsg(e)} — aborting (no recommendation).`);
		process.exit(1);
	}

	const rel = releaseBody as {
		version?: unknown;
		hash_manifest?: unknown;
		endpoints?: unknown;
		treasury?: unknown;
	} | null;
	const parsed = parseReleaseTreasury(rel?.treasury ?? null);
	const decision = decideRepin(parsed.pinned, prices, threshold);

	out('Treasury auto-re-pin');
	out(`  prices : BTC=${prices.btcUsd ?? 'n/a'}  XMR=${prices.xmrUsd ?? 'n/a'}  BLURT=${prices.blurtUsd ?? 'n/a'}`);
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
	const payload = {
		version: rel?.version,
		hash_manifest: rel?.hash_manifest,
		endpoints: rel?.endpoints,
		treasury: next
	};
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

	const nodes = broadcastNode ? [broadcastNode] : [...DEFAULT_BLURT_RPC_ENDPOINTS];
	const opData = {
		required_auths: [...op.required_auths],
		required_posting_auths: [...op.required_posting_auths],
		id: op.id,
		json: op.json
	};
	let lastErr: unknown;
	for (const url of nodes) {
		try {
			out(`\nBroadcasting via ${url} …`);
			const client = new Client(url, { timeout: 20_000 });
			const conf = (await client.broadcast.customJson(opData, priv)) as {
				id?: string;
				block_num?: number;
			};
			process.stdout.write(
				`✓ Re-pin broadcast accepted.\n  trx_id    : ${conf.id ?? '(unknown)'}\n` +
					`  block_num : ${conf.block_num ?? '(pending)'}\n  op id     : ${RELEASE_OP_ID}\n` +
					'Every Morphit instance picks up the re-pinned treasury within a block.\n'
			);
			process.exit(0);
		} catch (e) {
			lastErr = e;
			out(`  ✗ ${url}: ${errMsg(e)}`);
		}
	}
	out(`✗ all RPC nodes failed. Last error: ${errMsg(lastErr)}`);
	process.exit(1);
}

void main();
