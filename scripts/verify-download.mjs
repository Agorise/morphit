#!/usr/bin/env node
/**
 * Morphit — verify-download.mjs
 *
 * Verify a downloaded `morphit-vX.Y.Z.tar.gz` (or the offline bundle
 * `morphit-X.Y.Z-offline.tar.gz`) against the release anchor @morphit
 * published on the Blurt chain (`morphit_release_v1` → `distribution`).
 *
 *   node scripts/verify-download.mjs morphit-v1.8.15.tar.gz
 *   node scripts/verify-download.mjs <tarball> --version 1.8.15
 *   MORPHIT_RPC=https://rpc.beblurt.com,https://rpc.blurt.one node scripts/verify-download.mjs <tarball>
 *
 * What it does:
 *   1. Computes the SHA-256 of YOUR downloaded file.
 *   2. Reads @morphit's release op from the Blurt chain itself, without taking
 *      any one RPC node's word for it:
 *        a. two nodes run by different operators must agree on which
 *           transaction holds the newest release op (for --version: the
 *           newest op for that version);
 *        b. two such nodes must return the same block holding it, and the
 *           transaction id is recomputed from the block's content;
 *        c. the transaction's signature must recover to @morphit's posting
 *           key, pinned below. No node can fake that without the key.
 *      Only the payload read from that confirmed block is used. No Morphit
 *      server is asked, so a compromised download host cannot fake a match.
 *   3. Compares your SHA-256 to the anchored `source_sha256` (or
 *      `offline_sha256` for the offline bundle).
 *   4. Prints the release signing key's fingerprint, pinned below, so you can
 *      `git verify-tag` the signed tag, plus the IPFS CID and mirror list.
 *
 * This file is deliberately self-contained (only Node built-ins, no Morphit
 * imports or npm packages): you can read every line and run it anywhere, even
 * outside a repo checkout. The signature check (secp256k1 public-key recovery)
 * and the transaction encoding are written out below for that reason. See
 * docs/VERIFY-YOUR-DOWNLOAD.md.
 *
 * Exit codes: 0 verified · 1 MISMATCH or forged/unsigned anchor (do not trust
 * the download) · 2 usage error · 3 the chain could not be read from two
 * agreeing nodes · 4 no anchor on chain.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const SIGNER = 'morphit';
const OP_ID = 'morphit_release_v1';

// ─── pinned trust anchors ────────────────────────────────────────────
// Kept equal to packages/operator-config/src/trustAnchors.ts by
// scripts/verify-download-smoke.ts.

/** @morphit's posting public key: a release op counts only when signed by it. */
export const PINNED_POSTING_PUBKEY = 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9';
/** The GPG key that signs release tags and tarballs (fingerprint). */
export const PINNED_GPG_FINGERPRINT = '7B4C1D189DBB610C473B59ED53524E1F1017EB9C';
/** The Blurt mainnet chain id (part of every signed digest). */
export const BLURT_CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';

// The 6-node canonical Blurt RPC pool — kept in lockstep with
// DEFAULT_BLURT_RPC_ENDPOINTS (@morphit/operator-config) by the
// rpc-endpoint-canon smoke. This is a Node script (no browser CORS), so
// it can use ALL of them, including the CORS-omitted node the browser
// build can't reach. Override with MORPHIT_RPC=<url>,<url>,… (at least two
// nodes run by different operators).
const DEFAULT_RPCS = [
	'https://rpc.drakernoise.com',
	'https://blurtrpc.dagobert.uk',
	'https://rpc.blurt.blog',
	'https://rpc.beblurt.com',
	'https://rpc.blurt.one',
	'https://blurt-rpc.saboin.com'
];
/** History windows: the last 100 operations, then the last 10,000 only when
 *  two nodes agree the last 100 hold no matching release op. */
const HISTORY_WINDOWS = [100, 10_000];
/** Nodes of different operators that must agree at each chain read. */
const MIN_AGREE = 2;
const RPC_TIMEOUT_MS = 15_000;

// ─── pure helpers ────────────────────────────────────────────────────

/** SHA-256 of a file's bytes, lowercase hex — matches `sha256sum`. */
export function sha256File(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Extract the distribution anchor from a parsed release-op payload.
 * Minimal shape check only (source_sha256 must be 64-hex). Returns the block
 * or null.
 */
export function extractDistribution(payload) {
	if (!payload || typeof payload !== 'object') return null;
	const d = payload.distribution;
	if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
	if (typeof d.source_sha256 !== 'string' || !SHA256_RE.test(d.source_sha256)) return null;
	return d;
}

const normFpr = (f) => (typeof f === 'string' ? f.replace(/\s+/g, '').toUpperCase() : '');
const normVersion = (v) => (typeof v === 'string' ? v.trim().replace(/^v/, '') : null);

/**
 * Decide whether a file's SHA-256 is the release @morphit anchored. Pure.
 * `verified` is what readSignedRelease returned; anything but a proved op
 * refuses. Returns { status, … } where status is one of:
 *   'unverified'       — the op could not be proved (reason: no_quorum | none | bad_signature)
 *   'no_anchor'        — the proved op carries no distribution block
 *   'version_mismatch' — the proved op is for another version than asked
 *   'signer_changed'   — the anchor names a GPG key other than the pinned one
 *   'match' | 'mismatch'
 */
export function compareRelease(sha, verified, wantVersion) {
	if (!verified || verified.ok !== true) {
		return { status: 'unverified', reason: verified?.reason ?? 'none', keys: verified?.keys ?? [] };
	}
	const payload = verified.payload;
	const dist = extractDistribution(payload);
	if (!dist) return { status: 'no_anchor' };
	const chainVersion = typeof payload.version === 'string' ? payload.version : null;
	const want = normVersion(wantVersion);
	if (want && normVersion(chainVersion) !== want) {
		return { status: 'version_mismatch', chainVersion, wantVersion: want, dist };
	}
	if (normFpr(dist.gpg_fingerprint) !== PINNED_GPG_FINGERPRINT) {
		return {
			status: 'signer_changed',
			chainVersion,
			dist,
			anchored: normFpr(dist.gpg_fingerprint)
		};
	}
	const offline =
		typeof dist.offline_sha256 === 'string' && SHA256_RE.test(dist.offline_sha256)
			? dist.offline_sha256
			: null;
	const which =
		sha === dist.source_sha256 ? 'source' : offline !== null && sha === offline ? 'offline' : null;
	return {
		status: which ? 'match' : 'mismatch',
		which,
		expected: dist.source_sha256,
		expectedOffline: offline,
		got: sha,
		chainVersion,
		dist,
		blockNum: verified.blockNum,
		trxId: verified.trxId
	};
}

// ─── Blurt transaction encoding (custom_json transactions only) ──────

function varint32(n) {
	const out = [];
	let v = n >>> 0;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	out.push(v);
	return Buffer.from(out);
}
const vstring = (s) => {
	const b = Buffer.from(s, 'utf8');
	return Buffer.concat([varint32(b.length), b]);
};
const stringArray = (a) => {
	if (!Array.isArray(a) || a.some((x) => typeof x !== 'string'))
		throw new Error('not a string array');
	return Buffer.concat([varint32(a.length), ...a.map(vstring)]);
};
/** custom_json is operation 12 on Blurt. */
const CUSTOM_JSON = 12;

/** The chain's binary form of a transaction (without signatures). Throws for
 *  anything but custom_json operations — a release op transaction has none. */
export function serializeTransaction(tx) {
	const u16 = Buffer.alloc(2);
	const u32a = Buffer.alloc(4);
	const u32b = Buffer.alloc(4);
	if (!Number.isInteger(tx.ref_block_num) || tx.ref_block_num < 0 || tx.ref_block_num > 0xffff)
		throw new Error('ref_block_num');
	if (
		!Number.isInteger(tx.ref_block_prefix) ||
		tx.ref_block_prefix < 0 ||
		tx.ref_block_prefix > 0xffffffff
	)
		throw new Error('ref_block_prefix');
	if (typeof tx.expiration !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(tx.expiration))
		throw new Error('expiration');
	u16.writeUInt16LE(tx.ref_block_num);
	u32a.writeUInt32LE(tx.ref_block_prefix);
	u32b.writeUInt32LE(Math.floor(Date.parse(`${tx.expiration}Z`) / 1000));
	if (!Array.isArray(tx.operations)) throw new Error('operations');
	const ops = tx.operations.map((op) => {
		if (!Array.isArray(op) || op[0] !== 'custom_json' || !op[1] || typeof op[1] !== 'object')
			throw new Error('unsupported operation');
		const c = op[1];
		if (typeof c.id !== 'string' || typeof c.json !== 'string') throw new Error('custom_json');
		return Buffer.concat([
			varint32(CUSTOM_JSON),
			stringArray(c.required_auths),
			stringArray(c.required_posting_auths),
			vstring(c.id),
			vstring(c.json)
		]);
	});
	return Buffer.concat([
		u16,
		u32a,
		u32b,
		varint32(ops.length),
		...ops,
		stringArray(tx.extensions ?? [])
	]);
}

/** The id the chain gives a transaction, recomputed from its content; null
 *  when it cannot be encoded. */
export function transactionIdOf(tx) {
	try {
		return sha256(serializeTransaction(tx)).toString('hex').slice(0, 40);
	} catch {
		return null;
	}
}

// ─── secp256k1 public-key recovery ───────────────────────────────────

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
	0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
	0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n
];
const mod = (a, m) => ((a % m) + m) % m;
function inv(a, m) {
	let [x0, x1, r0, r1] = [0n, 1n, m, mod(a, m)];
	while (r1 !== 0n) {
		const q = r0 / r1;
		[x0, x1] = [x1, x0 - q * x1];
		[r0, r1] = [r1, r0 - q * r1];
	}
	if (r0 !== 1n) throw new Error('not invertible');
	return mod(x0, m);
}
function powmod(b, e, m) {
	let r = 1n;
	b = mod(b, m);
	while (e > 0n) {
		if (e & 1n) r = (r * b) % m;
		b = (b * b) % m;
		e >>= 1n;
	}
	return r;
}
function add(a, b) {
	if (a === null) return b;
	if (b === null) return a;
	if (a[0] === b[0]) {
		if (mod(a[1] + b[1], P) === 0n) return null;
		const l = mod(3n * a[0] * a[0] * inv(2n * a[1], P), P);
		const x = mod(l * l - 2n * a[0], P);
		return [x, mod(l * (a[0] - x) - a[1], P)];
	}
	const l = mod((b[1] - a[1]) * inv(b[0] - a[0], P), P);
	const x = mod(l * l - a[0] - b[0], P);
	return [x, mod(l * (a[0] - x) - a[1], P)];
}
function mul(pt, k) {
	let r = null;
	let q = pt;
	k = mod(k, N);
	while (k > 0n) {
		if (k & 1n) r = add(r, q);
		q = add(q, q);
		k >>= 1n;
	}
	return r;
}
const toBig = (buf) => BigInt(`0x${buf.toString('hex') || '0'}`);
const to32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

/** The 33-byte compressed public key a 65-byte Blurt signature (hex) over a
 *  32-byte digest recovers to, or null. */
export function recoverCompressed(sigHex, digest) {
	if (typeof sigHex !== 'string' || !/^[0-9a-f]{130}$/i.test(sigHex)) return null;
	const sig = Buffer.from(sigHex, 'hex');
	const recid = sig[0] - 31;
	if (recid < 0 || recid > 3) return null;
	const r = toBig(sig.subarray(1, 33));
	const s = toBig(sig.subarray(33, 65));
	if (r <= 0n || r >= N || s <= 0n || s >= N) return null;
	const x = r + (recid >= 2 ? N : 0n);
	if (x >= P) return null;
	const alpha = mod(x * x * x + 7n, P);
	let y = powmod(alpha, (P + 1n) / 4n, P);
	if ((y * y) % P !== alpha) return null;
	if ((y & 1n) !== BigInt(recid & 1)) y = P - y;
	const e = mod(toBig(digest), N);
	const rInv = inv(r, N);
	const q = add(mul([x, y], s * rInv), mul(G, mod(-e * rInv, N)));
	if (q === null) return null;
	return Buffer.concat([Buffer.from([q[1] & 1n ? 3 : 2]), to32(q[0])]);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
	let n = 0n;
	for (const ch of s) {
		const i = B58.indexOf(ch);
		if (i < 0) throw new Error('base58');
		n = n * 58n + BigInt(i);
	}
	let hex = n.toString(16);
	if (hex.length % 2) hex = `0${hex}`;
	const lead = s.length - s.replace(/^1+/, '').length;
	return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}
function base58Encode(buf) {
	let n = toBig(buf);
	let out = '';
	while (n > 0n) {
		out = B58[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (const b of buf) {
		if (b !== 0) break;
		out = `1${out}`;
	}
	return out;
}

/** The 33-byte key inside a `BLT…` public key string. */
export function publicKeyBytes(blt) {
	if (typeof blt !== 'string' || !blt.startsWith('BLT')) return null;
	try {
		const raw = base58Decode(blt.slice(3));
		return raw.length === 37 ? raw.subarray(0, 33) : null;
	} catch {
		return null;
	}
}
/** `BLT…` form of a 33-byte key (for messages). */
function publicKeyString(bytes) {
	let check;
	try {
		check = createHash('ripemd160').update(bytes).digest().subarray(0, 4);
	} catch {
		return `(key ${bytes.toString('hex')})`;
	}
	return `BLT${base58Encode(Buffer.concat([bytes, check]))}`;
}

function unsignedTx(t) {
	return {
		ref_block_num: t.ref_block_num,
		ref_block_prefix: t.ref_block_prefix,
		expiration: t.expiration,
		operations: t.operations,
		extensions: t.extensions ?? []
	};
}

/** Every distinct key (33-byte hex) the transaction's signatures recover to. */
export function recoverSigningKeys(tx) {
	if (!tx || !Array.isArray(tx.signatures)) return [];
	let digest;
	try {
		digest = sha256(
			Buffer.concat([Buffer.from(BLURT_CHAIN_ID, 'hex'), serializeTransaction(unsignedTx(tx))])
		);
	} catch {
		return [];
	}
	const out = new Set();
	for (const s of tx.signatures.slice(0, 8)) {
		const k = recoverCompressed(s, digest);
		if (k) out.add(k.toString('hex'));
	}
	return [...out];
}

// ─── reading the signed op ───────────────────────────────────────────

/** Parsed `json` of every custom_json OP_ID in `ops` with SIGNER as a
 *  posting auth, newest (last) first. */
function releasePayloads(ops) {
	const out = [];
	for (const op of [...(Array.isArray(ops) ? ops : [])].reverse()) {
		if (!Array.isArray(op) || op[0] !== 'custom_json' || !op[1] || typeof op[1] !== 'object')
			continue;
		const c = op[1];
		if (c.id !== OP_ID || typeof c.json !== 'string') continue;
		const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
		if (!auths.some((a) => typeof a === 'string' && a.toLowerCase() === SIGNER)) continue;
		try {
			out.push(JSON.parse(c.json));
		} catch {
			/* not this one */
		}
	}
	return out;
}

/** Newest history entry naming a matching release op: {blockNum, trxId},
 *  null when none, undefined when the answer is malformed. */
export function newestCandidate(history, match) {
	if (!Array.isArray(history)) return undefined;
	for (let i = history.length - 1; i >= 0; i--) {
		const h = Array.isArray(history[i]) ? history[i][1] : null;
		if (!h || !Array.isArray(h.op)) continue;
		if (!releasePayloads([h.op]).some(match)) continue;
		if (
			!Number.isSafeInteger(h.block) ||
			h.block <= 0 ||
			typeof h.trx_id !== 'string' ||
			!/^[0-9a-f]{40}$/.test(h.trx_id)
		)
			continue;
		return { blockNum: h.block, trxId: h.trx_id };
	}
	return null;
}

function findTransaction(block, trxId) {
	if (!block || typeof block !== 'object' || !Array.isArray(block.transactions)) return null;
	for (const tx of block.transactions) {
		if (tx && typeof tx === 'object' && transactionIdOf(tx) === trxId) return tx;
	}
	return null;
}

/** One operator per host name (an operator's several nodes count once). */
const operatorOf = (url) => {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return url;
	}
};

/**
 * Ask nodes of different operators until `MIN_AGREE` of them give answers
 * with the same non-null key. `call(url, method, params)` performs one RPC.
 * Returns { value, key, urls } or null.
 */
async function callAgreed(call, urls, method, params, keyOf, prefer = []) {
	const order = [...urls].sort(
		(a, b) => (prefer.includes(a) ? 0 : 1) - (prefer.includes(b) ? 0 : 1)
	);
	const asked = new Set();
	const groups = new Map();
	let next = 0;
	const best = () => Math.max(0, ...[...groups.values()].map((g) => g.ops.size));
	while (best() < MIN_AGREE) {
		const batch = [];
		while (batch.length < MIN_AGREE - best() && next < order.length) {
			const u = order[next++];
			const op = operatorOf(u);
			if (asked.has(op)) continue;
			asked.add(op);
			batch.push(u);
		}
		if (batch.length === 0) return null;
		await Promise.all(
			batch.map(async (u) => {
				let value;
				try {
					value = await call(u, method, params);
				} catch {
					return;
				}
				let key;
				try {
					key = keyOf(value);
				} catch {
					key = null;
				}
				if (key === null) return;
				const g = groups.get(key) ?? { value, urls: [], ops: new Set() };
				g.urls.push(u);
				g.ops.add(operatorOf(u));
				groups.set(key, g);
			})
		);
	}
	for (const [key, g] of groups)
		if (g.ops.size >= MIN_AGREE) return { value: g.value, key, urls: g.urls };
	return null;
}

/**
 * The newest `morphit_release_v1` op by @morphit (for `wantVersion`: the
 * newest for that version), proved as the header describes. Returns
 * { ok: true, payload, blockNum, trxId, urls } or { ok: false, reason, keys? }
 * with reason 'no_quorum' | 'none' | 'bad_signature'.
 */
export async function readSignedRelease(call, urls, opts = {}) {
	const want = normVersion(opts.wantVersion ?? null);
	const pinned = publicKeyBytes(opts.pinnedPubkey ?? PINNED_POSTING_PUBKEY);
	if (pinned === null) throw new Error('the pinned posting key is malformed');
	const match = (p) => !want || (p && typeof p === 'object' && normVersion(p.version) === want);

	let cand = null;
	let historyUrls = [];
	for (const window of HISTORY_WINDOWS) {
		const hist = await callAgreed(
			call,
			urls,
			'condenser_api.get_account_history',
			[SIGNER, -1, window],
			(h) => {
				const c = newestCandidate(h, match);
				if (c === undefined) return null;
				return c === null ? 'none' : `${c.blockNum}|${c.trxId}`;
			}
		);
		if (hist === null) return { ok: false, reason: 'no_quorum' };
		historyUrls = hist.urls;
		cand = newestCandidate(hist.value, match) ?? null;
		if (cand !== null) break;
	}
	if (cand === null) return { ok: false, reason: 'none' };

	const { blockNum, trxId } = cand;
	const block = await callAgreed(
		call,
		urls,
		'condenser_api.get_block',
		[blockNum],
		(b) => {
			const tx = findTransaction(b, trxId);
			return tx === null
				? null
				: `${typeof b.block_id === 'string' ? b.block_id : '?'}|${JSON.stringify(tx)}`;
		},
		historyUrls
	);
	if (block === null) return { ok: false, reason: 'no_quorum' };
	const tx = findTransaction(block.value, trxId);
	const payload = tx === null ? undefined : releasePayloads(tx.operations).find(match);
	if (payload === undefined) return { ok: false, reason: 'no_quorum' };
	const keys = recoverSigningKeys(tx);
	if (!keys.includes(pinned.toString('hex'))) {
		return {
			ok: false,
			reason: 'bad_signature',
			keys: keys.map((k) => publicKeyString(Buffer.from(k, 'hex')))
		};
	}
	return { ok: true, payload, blockNum, trxId, urls: block.urls };
}

// ─── chain I/O ───────────────────────────────────────────────────────

async function rpcCall(endpoint, method, params) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			signal: ctrl.signal
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = await res.json();
		if (j.error) throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
		return j.result;
	} finally {
		clearTimeout(t);
	}
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = argv.slice(2);
	const vi = args.indexOf('--version');
	const wantVersion = vi >= 0 ? args[vi + 1] : null;
	const tarball = args.find((a, i) => !a.startsWith('--') && !(vi >= 0 && i === vi + 1));
	return { tarball, wantVersion };
}

async function main() {
	const { tarball, wantVersion } = parseArgs(process.argv);
	if (!tarball) {
		process.stderr.write(
			'usage: node scripts/verify-download.mjs <tarball.tar.gz> [--version X.Y.Z]\n'
		);
		process.exit(2);
	}
	if (!existsSync(tarball)) {
		process.stderr.write(`file not found: ${tarball}\n`);
		process.exit(2);
	}

	const sha = sha256File(tarball);
	process.stdout.write(`\nYour download : ${tarball}\n`);
	process.stdout.write(`SHA-256       : ${sha}\n`);

	const rpcs = process.env.MORPHIT_RPC
		? process.env.MORPHIT_RPC.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: DEFAULT_RPCS;
	process.stdout.write(`\nReading @${SIGNER}'s signed release op from the Blurt chain…\n`);
	const verified = await readSignedRelease(rpcCall, rpcs, { wantVersion });
	const cmp = compareRelease(sha, verified, wantVersion);

	if (cmp.status === 'unverified') {
		if (cmp.reason === 'no_quorum') {
			process.stderr.write(
				'\n✗ could not get the same answer from two Blurt nodes run by different operators.\n'
			);
			process.stderr.write('  Nothing is known yet. Try again, or name nodes yourself:\n');
			process.stderr.write(
				'  MORPHIT_RPC=https://rpc.beblurt.com,https://rpc.blurt.one node scripts/verify-download.mjs <tarball>\n'
			);
			process.exit(3);
		}
		if (cmp.reason === 'none') {
			process.stderr.write(
				`\n✗ no ${OP_ID} op${wantVersion ? ` for v${normVersion(wantVersion)}` : ''} in @${SIGNER}'s history.\n`
			);
			process.stderr.write('  The release may not be anchored yet.\n');
			process.exit(4);
		}
		process.stderr.write(
			`\n✗ the release op on chain is NOT signed by @${SIGNER}'s posting key. DO NOT TRUST IT.\n`
		);
		process.stderr.write(`    pinned key : ${PINNED_POSTING_PUBKEY}\n`);
		process.stderr.write(
			`    signed by  : ${cmp.keys.length ? cmp.keys.join(', ') : '(no valid signature)'}\n`
		);
		process.exit(1);
	}
	if (cmp.status === 'no_anchor') {
		process.stderr.write('\n✗ the release op carries NO distribution anchor to check against.\n');
		process.stderr.write('  This release predates decentralized-distribution anchoring.\n');
		process.exit(4);
	}
	if (cmp.status === 'version_mismatch') {
		process.stderr.write(
			`\n✗ the chain's anchor is for v${cmp.chainVersion}, but you asked to verify v${cmp.wantVersion}.\n`
		);
		process.exit(1);
	}
	if (cmp.status === 'signer_changed') {
		process.stderr.write(`\n✗ the anchor names release signing key ${cmp.anchored || '(none)'},\n`);
		process.stderr.write(`  but this script pins ${PINNED_GPG_FINGERPRINT}.\n`);
		process.stderr.write(
			'  Get the current verify-download.mjs from a mirror and read its pins before trusting either.\n'
		);
		process.exit(1);
	}

	const d = cmp.dist;
	process.stdout.write(
		`On-chain (v${cmp.chainVersion}), block ${cmp.blockNum}, transaction ${cmp.trxId}\n`
	);
	process.stdout.write(`  signed by @${SIGNER}'s posting key ${PINNED_POSTING_PUBKEY}\n`);
	process.stdout.write(
		`Anchor SHA-256: ${cmp.expected}${cmp.expectedOffline ? `\n  offline bundle: ${cmp.expectedOffline}` : ''}\n\n`
	);

	if (cmp.status === 'match') {
		process.stdout.write(
			`✓ SHA-256 MATCHES the on-chain anchor${cmp.which === 'offline' ? ' (offline bundle)' : ''}. Your bytes are the published release.\n\n`
		);
		process.stdout.write(
			'Next, confirm the GPG signature on the signed git TAG (clone any mirror\n'
		);
		process.stdout.write('below, then run this inside the clone):\n');
		process.stdout.write(`  git verify-tag v${cmp.chainVersion}\n`);
		process.stdout.write(
			"  → the tag's signing-key fingerprint MUST equal (pinned in this script):\n"
		);
		process.stdout.write(`      ${PINNED_GPG_FINGERPRINT}\n`);
		process.stdout.write(
			`  (If the release attached a detached signature: gpg --verify ${tarball}.asc ${tarball})\n`
		);
		if (d.ipfs_cid)
			process.stdout.write(
				`\nIPFS (content-addressed, tamper-proof by CID): ${d.ipfs_cid}\n  ipfs get ${d.ipfs_cid}\n`
			);
		if (Array.isArray(d.mirrors) && d.mirrors.length) {
			process.stdout.write(
				'\nMirror repos carrying the same code (clone one and `git verify-tag`):\n'
			);
			for (const m of d.mirrors) process.stdout.write(`  ${m}\n`);
		}
		process.stdout.write('\n');
		process.exit(0);
	}

	process.stderr.write(
		'✗ SHA-256 DOES NOT MATCH the on-chain anchor. DO NOT TRUST THIS DOWNLOAD.\n'
	);
	process.stderr.write(
		`    expected ${cmp.expected}${cmp.expectedOffline ? ` (or ${cmp.expectedOffline} for the offline bundle)` : ''}\n    got      ${cmp.got}\n`
	);
	process.stderr.write(
		'  Get the canonical tarball from the Forgejo release page and re-check, or\n'
	);
	process.stderr.write(
		'  clone a mirror repo and verify the signed tag instead (git verify-tag):\n'
	);
	if (Array.isArray(d.mirrors)) for (const m of d.mirrors) process.stderr.write(`    ${m}\n`);
	process.stderr.write('  See docs/VERIFY-YOUR-DOWNLOAD.md.\n');
	process.exit(1);
}

// Only run when invoked directly (so the smoke can import the helpers).
if (import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
