#!/usr/bin/env node
/**
 * Morphit — verify-download.mjs  (cp556)
 *
 * Verify a downloaded `morphit-vX.Y.Z.tar.gz` against the
 * decentralized-distribution anchor that @morphit published on the
 * Blurt chain (`morphit_release_v1` → `distribution`).
 *
 *   node scripts/verify-download.mjs morphit-v1.8.15.tar.gz
 *   node scripts/verify-download.mjs <tarball> --version 1.8.15
 *   MORPHIT_RPC=https://rpc.beblurt.com node scripts/verify-download.mjs <tarball>
 *
 * What it does:
 *   1. Computes the SHA-256 of YOUR downloaded tarball.
 *   2. Fetches @morphit's latest morphit_release_v1 op straight from a
 *      Blurt RPC node (NOT from any Morphit server — a compromised
 *      download host therefore cannot fake a match).
 *   3. Compares your SHA-256 to the on-chain `source_sha256`.
 *   4. Prints the anchor's GPG fingerprint + IPFS CID + mirror list so
 *      you can `gpg --verify` the `.asc` and/or re-fetch from IPFS.
 *
 * This file is deliberately self-contained (only Node built-ins, no
 * Morphit imports) so you can read every line and run it anywhere,
 * even outside a repo checkout. The authoritative validator lives in
 * packages/release-schema/src/releaseValidate.ts; this is the minimal
 * verifier a downloader needs. See docs/VERIFY-YOUR-DOWNLOAD.md.
 *
 * Exit codes: 0 verified · 1 MISMATCH (do not trust the download) ·
 * 2 usage error · 3 chain unreachable · 4 no anchor on chain.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const SIGNER = 'morphit';
const OP_ID = 'morphit_release_v1';
// The 6-node canonical Blurt RPC pool — kept in lockstep with
// DEFAULT_BLURT_RPC_ENDPOINTS (@morphit/operator-config) by the
// rpc-endpoint-canon smoke. This is a Node script (no browser CORS), so
// it can use ALL of them, including the CORS-omitted node the browser
// build can't reach. Override with MORPHIT_RPC=<url> for a single node.
const DEFAULT_RPCS = [
	'https://rpc.drakernoise.com',
	'https://blurtrpc.dagobert.uk',
	'https://rpc.blurt.blog',
	'https://rpc.beblurt.com',
	'https://rpc.blurt.one',
	'https://blurt-rpc.saboin.com'
];
const HISTORY_WALK_LIMIT = 10_000;
const BATCH = 1000;

// ─── pure helpers (unit-tested by verify-download-smoke.ts) ──────────

/** SHA-256 of a file's bytes, lowercase hex — matches `sha256sum`. */
export function sha256File(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SOURCE_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Extract the distribution anchor from a parsed release-op payload.
 * Minimal shape check only (source_sha256 must be 64-hex) — the full
 * validator is in the repo. Returns the block or null.
 */
export function extractDistribution(payload) {
	if (!payload || typeof payload !== 'object') return null;
	const d = payload.distribution;
	if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
	if (typeof d.source_sha256 !== 'string' || !SOURCE_SHA256_RE.test(d.source_sha256)) return null;
	return d;
}

/**
 * Compare a computed tarball hash to an anchor. Pure. Returns:
 *   { status: 'match' | 'mismatch' | 'no_anchor', ... }
 * When a version is requested and the anchor's release version differs,
 * status is 'version_mismatch' (the chain's latest anchor is for a
 * different release than the file you're checking).
 */
export function compareRelease(sha, payload, wantVersion) {
	const dist = extractDistribution(payload);
	if (!dist) return { status: 'no_anchor' };
	const chainVersion = typeof payload.version === 'string' ? payload.version : null;
	if (wantVersion && chainVersion && chainVersion !== wantVersion) {
		return { status: 'version_mismatch', chainVersion, wantVersion, dist };
	}
	return {
		status: sha === dist.source_sha256 ? 'match' : 'mismatch',
		expected: dist.source_sha256,
		got: sha,
		chainVersion,
		dist
	};
}

// ─── chain I/O ───────────────────────────────────────────────────────

async function rpcCall(endpoint, method, params) {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const j = await res.json();
	if (j.error) throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
	return j.result;
}

/** Tolerant custom_json extraction across condenser history shapes. */
function opToReleaseJson(entry) {
	// entry: [seq, { op: [...] | { op: [...] }, ... }]
	const tx = entry?.[1];
	const op = Array.isArray(tx?.op) ? tx.op : Array.isArray(tx?.op?.op) ? tx.op.op : null;
	if (!op || op[0] !== 'custom_json') return null;
	const data = op[1];
	if (!data || data.id !== OP_ID) return null;
	try {
		return JSON.parse(data.json);
	} catch {
		return null;
	}
}

/**
 * Walk @morphit's account history newest→oldest (in batches, bounded
 * to HISTORY_WALK_LIMIT) and return the parsed payload of the most
 * recent morphit_release_v1 op, or null. Tries each RPC in turn.
 */
async function fetchLatestReleasePayload(rpcs) {
	let lastErr = null;
	for (const rpc of rpcs) {
		try {
			let from = -1;
			let walked = 0;
			while (walked < HISTORY_WALK_LIMIT) {
				const hist = await rpcCall(rpc, 'condenser_api.get_account_history', [SIGNER, from, BATCH]);
				if (!Array.isArray(hist) || hist.length === 0) break;
				// Newest last — scan descending for our op.
				for (let i = hist.length - 1; i >= 0; i--) {
					const payload = opToReleaseJson(hist[i]);
					if (payload) return { payload, rpc };
				}
				const lowestSeq = hist[0][0];
				if (lowestSeq <= 0) break;
				from = lowestSeq - 1;
				walked += hist.length;
			}
			return { payload: null, rpc }; // reachable, but no release op found
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr ?? new Error('all RPC endpoints failed');
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = argv.slice(2);
	const tarball = args.find((a) => !a.startsWith('--'));
	const vi = args.indexOf('--version');
	const wantVersion = vi >= 0 ? args[vi + 1] : null;
	return { tarball, wantVersion };
}

async function main() {
	const { tarball, wantVersion } = parseArgs(process.argv);
	if (!tarball) {
		process.stderr.write('usage: node scripts/verify-download.mjs <tarball.tar.gz> [--version X.Y.Z]\n');
		process.exit(2);
	}
	if (!existsSync(tarball)) {
		process.stderr.write(`file not found: ${tarball}\n`);
		process.exit(2);
	}

	const sha = sha256File(tarball);
	process.stdout.write(`\nYour download : ${tarball}\n`);
	process.stdout.write(`SHA-256       : ${sha}\n`);

	const rpcs = process.env.MORPHIT_RPC ? [process.env.MORPHIT_RPC] : DEFAULT_RPCS;
	process.stdout.write(`\nFetching @${SIGNER}'s on-chain release anchor…\n`);
	let result;
	try {
		result = await fetchLatestReleasePayload(rpcs);
	} catch (err) {
		process.stderr.write(`\n✗ could not reach the Blurt chain: ${err instanceof Error ? err.message : err}\n`);
		process.stderr.write('  Try another node: MORPHIT_RPC=https://rpc.beblurt.com node scripts/verify-download.mjs <tarball>\n');
		process.exit(3);
	}

	if (!result.payload) {
		process.stderr.write(`\n✗ no ${OP_ID} op found in @${SIGNER}'s recent history.\n`);
		process.stderr.write('  The release may not be anchored yet, or history was pruned.\n');
		process.exit(4);
	}

	const cmp = compareRelease(sha, result.payload, wantVersion);

	if (cmp.status === 'no_anchor') {
		process.stderr.write('\n✗ the latest release op carries NO distribution anchor to check against.\n');
		process.stderr.write('  This release predates decentralized-distribution anchoring.\n');
		process.exit(4);
	}
	if (cmp.status === 'version_mismatch') {
		process.stderr.write(`\n✗ the chain's latest anchor is for v${cmp.chainVersion}, but you asked to verify v${cmp.wantVersion}.\n`);
		process.stderr.write('  Download the matching version, or drop --version to check against the latest.\n');
		process.exit(1);
	}

	const d = cmp.dist;
	process.stdout.write(`On-chain (v${cmp.chainVersion}) via ${result.rpc}\n`);
	process.stdout.write(`Anchor SHA-256: ${cmp.expected}\n\n`);

	if (cmp.status === 'match') {
		process.stdout.write('✓ SHA-256 MATCHES the on-chain anchor. Your bytes are the published release.\n\n');
		process.stdout.write('Next, confirm the GPG signature came from the right key:\n');
		process.stdout.write(`  gpg --verify ${tarball}.asc ${tarball}\n`);
		process.stdout.write(`  → the signature's key fingerprint MUST equal:\n`);
		process.stdout.write(`      ${d.gpg_fingerprint}\n`);
		if (d.ipfs_cid) process.stdout.write(`\nIPFS (content-addressed, tamper-proof by CID): ${d.ipfs_cid}\n  ipfs get ${d.ipfs_cid}\n`);
		if (Array.isArray(d.mirrors) && d.mirrors.length) {
			process.stdout.write('\nMirror repos carrying the same code (clone one and `git verify-tag`):\n');
			for (const m of d.mirrors) process.stdout.write(`  ${m}\n`);
		}
		process.stdout.write('\n');
		process.exit(0);
	}

	process.stderr.write('✗ SHA-256 DOES NOT MATCH the on-chain anchor. DO NOT TRUST THIS DOWNLOAD.\n');
	process.stderr.write(`    expected ${cmp.expected}\n    got      ${cmp.got}\n`);
	process.stderr.write('  Get the canonical tarball from the Forgejo release page and re-check, or\n');
	process.stderr.write('  clone a mirror repo and verify the signed tag instead (git verify-tag):\n');
	if (Array.isArray(d.mirrors)) for (const m of d.mirrors) process.stderr.write(`    ${m}\n`);
	process.stderr.write('  See docs/VERIFY-YOUR-DOWNLOAD.md.\n');
	process.exit(1);
}

// Only run when invoked directly (so the smoke can import the helpers).
if (import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
