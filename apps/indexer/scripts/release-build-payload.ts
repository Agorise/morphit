/**
 * Morphit indexer — release-op payload builder.
 *
 * Operator-facing CLI that prompts for the values that go into
 * a `morphit_release_v1` op, validates them against the same
 * rules the on-chain handler enforces, and emits canonical JSON
 * ready to paste into a Blurt signing tool (Vessel, beempy,
 * blurt-cli, dblurt-script).
 *
 * Why a builder script:
 *   1. Validation parity — the on-chain handler is strict; the
 *      builder runs the SAME validators so a payload that the
 *      builder accepts is guaranteed to be accepted by every
 *      federated indexer.  Catches typos before the broadcast
 *      reaches the chain.
 *   2. Reads existing values (current /v1/release) so the
 *      operator can rotate one field at a time without
 *      reconstructing the whole payload.
 *
 * **Privacy note.**  This builder NEVER prompts for
 * the Monero view key, and its output payload NEVER contains a
 * view key.  No indexer uses one any more (XMR fees are checked
 * from per-payment proofs), no env file holds one, and it is
 * never broadcast on chain.  The design did embed the
 * view key in the payload under the rationale that "it's
 * publish-safe by Monero design"; that was a privacy mistake
 * (the key reveals every incoming payment forever).
 * removes the viewkey from the chain-pinned `treasury` block.
 * If you have a custom payload from previously with a
 * viewkey field, you should regenerate it WITHOUT the viewkey
 * before broadcasting.  (the previous
 * `verify-xmr-viewkey.ts` diagnostic helper has been retired —
 * no view-key sanity check is needed anymore; the new
 * verification path uses per-payment proofs that exercise the
 * exact production code path end-to-end.)
 *
 * Usage:
 *   tsx apps/indexer/scripts/release-build-payload.ts
 *
 *   # Or, in non-interactive mode, pass via env:
 *   #   MORPHIT_BUILD_VERSION=1.0.0
 *   #   MORPHIT_BUILD_BTC_ADDRESS=bc1q...
 *   #   MORPHIT_BUILD_BTC_SATOSHIS=416
 *   #   MORPHIT_BUILD_BTC_XPUB=zpub...   (v1.20.0 MK-H2; default: CANONICAL_TREASURY.btcXpub)
 *   #   MORPHIT_BUILD_XMR_ADDRESS=4...
 *   #   MORPHIT_BUILD_XMR_PICONERO=781250000
 *   #   MORPHIT_BUILD_XMR_PRIMARY=4...   (v1.20.0 MK-H2; default: CANONICAL_TREASURY.xmrPrimary)
 *   #   MORPHIT_BUILD_HASH_MANIFEST_FILE=/path/to/manifest.json
 *   #   MORPHIT_BUILD_ENDPOINTS_FILE=/path/to/endpoints.json
 *   #   tsx apps/indexer/scripts/release-build-payload.ts > /tmp/morphit-release.json
 *
 * Flags:
 *   --ipfs-cid <cid>       the release's IPFS CID, for an anchor
 *                          (MORPHIT_BUILD_ANCHOR_FILE) that carries none:
 *                          release.yml could not compute it, and the release
 *                          box printed it when Block 3 had it seed the
 *                          release ("hosted vX → bafy…").
 *                          Refused when the anchor has a CID, or without one.
 *   --allow-no-ipfs-cid    emit a distribution block with no ipfs_cid anyway.
 *                          Zero-clearnet nodes cannot fetch such a release
 *                          (v1.20.2), so without this flag it is refused.
 *
 * Output: a single JSON object on stdout, ready to broadcast
 * as the `json` field of a Blurt `custom_json` op.  Errors
 * print to stderr; the script exits non-zero if validation
 * fails so a CI pipeline can detect bad values.
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import {
	validateReleasePayload,
	validateTreasury,
	validateDistribution
} from '@morphit/release-schema';
import type {
	ReleasePayloadV1,
	ReleaseTreasuryBlock,
	ReleaseDistributionBlock
} from '@morphit/release-schema';
import { CANONICAL_TREASURY } from '../src/config/canonicalTreasury.ts';
import { RELEASE_SIGNER_FINGERPRINTS } from '@morphit/operator-config';
import { checkTreasuryXpubInput } from '../src/lib/treasuryXpubInput.ts';
import { checkTreasuryXmrPrimaryInput } from '../src/lib/treasuryXmrPrimaryInput.ts';

function fail(reason: string): never {
	process.stderr.write(`\n✗ ${reason}\n`);
	process.exit(1);
}

/** The keys release.yml writes into distribution-anchor.env, each with the one
 *  shape its value may have. */
const ANCHOR_KEYS: Readonly<Record<string, RegExp>> = {
	MORPHIT_BUILD_SOURCE_SHA256: /^[0-9a-f]{64}$/,
	MORPHIT_BUILD_OFFLINE_SHA256: /^[0-9a-f]{64}$/,
	MORPHIT_BUILD_GPG_FINGERPRINT: /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/,
	MORPHIT_BUILD_IPFS_CID: /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,110})$/,
	MORPHIT_BUILD_IPNS_NAME: /^k51[a-z0-9]{50,70}$/,
	MORPHIT_BUILD_IPNS_RECORD: /^[A-Za-z0-9+/]{64,1200}={0,2}$/,
	MORPHIT_BUILD_TAG_OBJECT: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
};

/**
 * Read the release job's distribution-anchor.env WITHOUT a shell. It used to be
 * `source`d on the laptop that then asks for the @morphit WIF, so anything
 * the release job wrote into it ran there. Each line must be a comment, blank,
 * or `export <one of ANCHOR_KEYS>=<value of that key's shape>`; anything else
 * refuses the whole file. Returns the values by key. PURE apart from the throw.
 */
export function parseAnchorEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [i, raw] of text.split('\n').entries()) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const m = /^export ([A-Z0-9_]+)=(.*)$/.exec(line);
		if (m === null) throw new Error(`line ${i + 1} is not "export KEY=value"`);
		const [, key, value] = m as unknown as [string, string, string];
		const shape = ANCHOR_KEYS[key];
		if (shape === undefined)
			throw new Error(`line ${i + 1} sets ${key}, which an anchor never carries`);
		if (!shape.test(value))
			throw new Error(`line ${i + 1}: ${key} does not have the expected shape`);
		if (key in out) throw new Error(`${key} is set twice`);
		out[key] = value;
	}
	if (out.MORPHIT_BUILD_SOURCE_SHA256 === undefined)
		throw new Error('it carries no MORPHIT_BUILD_SOURCE_SHA256');
	return out;
}

export interface BuilderFlags {
	/** --ipfs-cid: the CID for an anchor that carries none. */
	ipfsCid: string | null;
	/** --allow-no-ipfs-cid: emit a distribution block without a CID. */
	allowNoIpfsCid: boolean;
}

/** The command-line flags. Anything else refuses: a mistyped flag must not
 *  quietly leave the CID out. PURE apart from the throw. */
export function parseBuilderArgs(argv: readonly string[]): BuilderFlags {
	const flags: BuilderFlags = { ipfsCid: null, allowNoIpfsCid: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--allow-no-ipfs-cid') flags.allowNoIpfsCid = true;
		else if (a === '--ipfs-cid' || a.startsWith('--ipfs-cid=')) {
			if (flags.ipfsCid !== null) throw new Error('--ipfs-cid is given twice');
			const v = a === '--ipfs-cid' ? argv[++i] : a.slice('--ipfs-cid='.length);
			if (v === undefined) throw new Error('--ipfs-cid needs the CID after it');
			flags.ipfsCid = v.trim();
		} else throw new Error(`unknown argument ${JSON.stringify(a)}`);
	}
	if (flags.ipfsCid !== null && flags.allowNoIpfsCid)
		throw new Error('--ipfs-cid and --allow-no-ipfs-cid contradict each other');
	return flags;
}

/**
 * The CID a --ipfs-cid flag supplies for this anchor. Only for an anchor that
 * carries none (release.yml could not compute it); the value must have a CID's
 * shape. Returns the CID, or why it is refused. PURE.
 */
export function suppliedCidFor(
	anchor: Readonly<Record<string, string>>,
	flagCid: string
): { ok: true; cid: string } | { ok: false; why: string } {
	const anchored = anchor.MORPHIT_BUILD_IPFS_CID;
	if (anchored !== undefined)
		return {
			ok: false,
			why: `the anchor already carries IPFS CID ${anchored}; --ipfs-cid is only for an anchor that has none`
		};
	if (!ANCHOR_KEYS.MORPHIT_BUILD_IPFS_CID!.test(flagCid))
		return {
			ok: false,
			why: '--ipfs-cid is not an IPFS CID (copy the bafy… value from the release box’s "hosted" line)'
		};
	return { ok: true, cid: flagCid };
}

/** MORPHIT_BUILD_ANCHOR_FILE → the anchor's values in process.env. A value an
 *  earlier step left in the environment for one of those keys refuses, so a
 *  previous release's CID or record can never ride along. */
function loadAnchorFile(flags: BuilderFlags): void {
	const path = (process.env.MORPHIT_BUILD_ANCHOR_FILE ?? '').trim();
	if (path === '') {
		if (flags.ipfsCid !== null)
			fail(
				'--ipfs-cid supplies the CID for an anchor that has none; give the anchor too (MORPHIT_BUILD_ANCHOR_FILE)'
			);
		return;
	}
	for (const k of Object.keys(ANCHOR_KEYS)) {
		if ((process.env[k] ?? '') !== '') {
			fail(
				`${k} is already set in this terminal (left over from an earlier release?) — open a new terminal; the anchor file supplies it`
			);
		}
	}
	let values: Record<string, string>;
	try {
		values = parseAnchorEnv(fs.readFileSync(path, 'utf8'));
	} catch (e) {
		fail(`the anchor ${path} was refused: ${e instanceof Error ? e.message : String(e)}`);
	}
	const fpr = values.MORPHIT_BUILD_GPG_FINGERPRINT;
	if (fpr !== undefined && !RELEASE_SIGNER_FINGERPRINTS.includes(fpr)) {
		fail(`the anchor names signing key ${fpr}, which is not a pinned release signer`);
	}
	const why = tagObjectMismatch(
		values.MORPHIT_BUILD_TAG_OBJECT,
		(process.env.MORPHIT_BUILD_VERSION ?? '').trim(),
		(ref) => {
			const r = spawnSync('git', ['rev-parse', '--verify', '-q', ref], { encoding: 'utf8' });
			return r.status === 0 ? r.stdout.trim() : null;
		}
	);
	if (why !== null) fail(why);
	if (flags.ipfsCid !== null) {
		const supplied = suppliedCidFor(values, flags.ipfsCid);
		if (!supplied.ok) fail(supplied.why);
		values.MORPHIT_BUILD_IPFS_CID = supplied.cid;
	}
	for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

/**
 * The release job built the signed tag object the anchor names; this
 * repository made and pushed v<version> in Block 2. They must be the same
 * object: a tag moved after the push (pointed back at an older signed object
 * of the same name) would otherwise get its build anchored on chain. Returns
 * why not, or null when they match. `localTag` resolves a ref to an object id.
 */
export function tagObjectMismatch(
	anchored: string | undefined,
	version: string,
	localTag: (ref: string) => string | null
): string | null {
	if (anchored === undefined)
		return 'the anchor names no tag object (MORPHIT_BUILD_TAG_OBJECT): use the distribution-anchor.env attached to this release';
	if (version === '') return 'MORPHIT_BUILD_VERSION is not set, so the tag cannot be checked';
	const local = localTag(`refs/tags/v${version}`);
	if (local === null)
		return `this repository has no tag v${version}: run this in the repository where you made and pushed the tag`;
	if (local !== anchored)
		return `the release job built tag object ${anchored}, but the v${version} tag made here is ${local}: the tag was moved after it was pushed. Do not broadcast this release, and delete the release (its tarball, bundle and signatures are already published) on git.agorise.net, codeberg.org and gitea.com.`;
	return null;
}

function isInteractive(): boolean {
	return process.stdin.isTTY === true;
}

async function ask(prompt: string, fallback?: string): Promise<string> {
	if (!isInteractive()) {
		// Non-interactive — caller must populate env vars.
		return fallback ?? '';
	}
	const rl = readline.createInterface({ input, output });
	try {
		return await new Promise<string>((resolve) => {
			const display = fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `;
			rl.question(display, (ans) => {
				resolve(ans.trim() === '' && fallback !== undefined ? fallback : ans.trim());
			});
		});
	} finally {
		rl.close();
	}
}

/** Read a JSON file from disk, fail with a clear error if it
 *  can't be read or doesn't parse. */
function readJsonFile(path: string, label: string): Record<string, unknown> {
	if (!fs.existsSync(path)) {
		fail(`${label} file not found at ${path}`);
	}
	let raw: string;
	try {
		raw = fs.readFileSync(path, 'utf-8');
	} catch (err) {
		fail(`could not read ${label} file: ${err instanceof Error ? err.message : err}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		fail(`${label} file is not valid JSON: ${err instanceof Error ? err.message : err}`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		fail(`${label} file must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

interface Inputs {
	version: string;
	hashManifest: Record<string, unknown>;
	endpoints?: Record<string, unknown>;
	btcAddress: string;
	btcSatoshis: string;
	/** v1.20.0 (MK-H2) — treasury BTC account xpub/zpub (PUBLIC). Empty = omit. */
	btcXpub: string;
	xmrAddress: string;
	xmrPiconero: string;
	/** v1.20.0 (MK-H2) — treasury Monero PRIMARY address (`4…`). Empty = omit. */
	xmrPrimary?: string;
	/** chain-pinned BLURT fee base (tier-1).  Empty = omit. */
	blurtBase: string;
	/** decentralized-distribution anchor.  All empty = omit the
	 *  whole block.  source_sha256 + gpg_fingerprint are required TOGETHER
	 *  when either is set; a block that is emitted needs ipfs_cid too unless
	 *  --allow-no-ipfs-cid is given; mirrors default to the baked list. */
	sourceSha256: string;
	/** v1.16.9 — the `-offline` self-contained bundle's SHA-256 (optional). */
	offlineSha256: string;
	gpgFingerprint: string;
	ipfsCid: string;
	/** v1.9.x — stable IPNS name (`k51…`), the "always latest" pointer. Empty = omit. */
	ipnsName: string;
	/** v1.9.6 — base64 signed IPNS record for ipnsName → this release's CID, the
	 *  DHT-rebroadcast pointer every instance re-announces. Empty = omit. */
	ipnsRecord: string;
	/** Comma- or whitespace-separated list of https:// mirror URLs. */
	mirrors: string;
}

async function gatherInputs(): Promise<Inputs> {
	process.stderr.write('\n── Morphit release-op payload builder ────────────────────\n');
	process.stderr.write('Enter values for the morphit_release_v1 op.  Leave a\n');
	process.stderr.write('field empty to omit — endpoints and treasury are all\n');
	process.stderr.write('optional; only version + hash_manifest are required.\n\n');

	const version = await ask(
		'Release version (semver, e.g. 1.0.0)',
		process.env.MORPHIT_BUILD_VERSION
	);
	if (!version) fail('version is required');

	const manifestPath = await ask(
		'Path to hash_manifest JSON file',
		process.env.MORPHIT_BUILD_HASH_MANIFEST_FILE
	);
	if (!manifestPath) fail('hash_manifest file path is required');
	const hashManifest = readJsonFile(manifestPath, 'hash_manifest');

	// endpoints is OPTIONAL and normally OMITTED. The maintainer's rule: don't
	// pin the blurt_rpc list on-chain (redundant with the frontend's baked-in
	// DEFAULT_BLURT_RPC_ENDPOINTS; avoid chain-bloat). Set
	// MORPHIT_BUILD_ENDPOINTS_FILE only to deliberately announce a pool.
	const endpointsPath = await ask(
		'Path to endpoints JSON file (optional — leave empty to omit)',
		process.env.MORPHIT_BUILD_ENDPOINTS_FILE
	);
	const endpoints = endpointsPath ? readJsonFile(endpointsPath, 'endpoints') : undefined;

	process.stderr.write('\n── Treasury ─────────────────────────────────────────\n');
	process.stderr.write('Leave any treasury field empty to omit that chain.\n');
	process.stderr.write('Both BTC and XMR fields independently optional.\n');
	process.stderr.write('NOTE: this builder does NOT ask for the XMR view key.\n');
	process.stderr.write('No indexer needs one (XMR fees are checked from\n');
	process.stderr.write('per-payment proofs) and it is never broadcast on chain.\n\n');

	const btcAddress = await ask(
		'BTC fee address (mainnet bc1q.../1.../3...)',
		process.env.MORPHIT_BUILD_BTC_ADDRESS ?? CANONICAL_TREASURY.btc
	);
	const btcSatoshis = await ask(
		'BTC fee amount (satoshis)',
		process.env.MORPHIT_BUILD_BTC_SATOSHIS ?? '416'
	);
	// v1.20.0 (MK-H2) — the treasury wallet's ACCOUNT public key. Once pinned,
	// every BTC-fee order gets its own address of this key. Set once with
	// scripts/set-treasury-btc-xpub.ts (it lands in CANONICAL_TREASURY.btcXpub
	// and so rides along in every later release op); MORPHIT_BUILD_BTC_XPUB
	// overrides. Never a private key — buildTreasury() refuses one.
	const btcXpub = await ask(
		'BTC treasury account PUBLIC key, xpub/zpub (optional; empty to omit)',
		process.env.MORPHIT_BUILD_BTC_XPUB ?? CANONICAL_TREASURY.btcXpub
	);

	const xmrAddress = await ask(
		'XMR fee address (mainnet 4.../8...)',
		process.env.MORPHIT_BUILD_XMR_ADDRESS ?? CANONICAL_TREASURY.xmr
	);
	const xmrPiconero = await ask(
		'XMR fee amount (piconero)',
		process.env.MORPHIT_BUILD_XMR_PICONERO ?? '781250000'
	);
	// v1.20.0 (MK-H2) — the treasury wallet's MAIN address. Once pinned, every
	// XMR-fee order pays the integrated address carrying its own payment ID.
	// Set once with scripts/set-treasury-xmr-primary.ts (after the pre-pin
	// checklist, docs/OPERATIONS.md §40.13); MORPHIT_BUILD_XMR_PRIMARY overrides.
	const xmrPrimary = await ask(
		'XMR treasury MAIN address 4... (optional; empty to omit)',
		process.env.MORPHIT_BUILD_XMR_PRIMARY ?? CANONICAL_TREASURY.xmrPrimary
	);

	// chain-pinned BLURT fee base.  Empty omits it (older
	// shape); when set, makes the BLURT floor deterministic across
	// the federation like BTC/XMR.  The canonical floor is 125 BLURT
	// (~12.5¢ at the $0.001 reference price); the release ceremony passes it
	// explicitly via MORPHIT_BUILD_BLURT_BASE so a `< /dev/null` build pins the
	// floor rather than omitting it and falling back to each instance's env.
	const blurtBase = await ask(
		'BLURT fee base (whole BLURT, e.g. 125; empty to omit)',
		process.env.MORPHIT_BUILD_BLURT_BASE ?? ''
	);

	// decentralized-distribution anchor.  In the normal (CI) flow
	// these come from the `distribution-anchor.env` that release.yml wrote and
	// attached to the release: source_sha256 is the PUBLISHED tarball's hash and
	// gpg_fingerprint is the release-signer key.  The ELI5 ceremony fetches that
	// file and passes it as MORPHIT_BUILD_ANCHOR_FILE (loadAnchorFile, above —
	// parsed, never sourced); the mirror list is a fixed default baked into
	// buildDistribution().  Leave all empty to omit the block (a release cut
	// before the anchor was available).
	process.stderr.write('\n── Distribution anchor ─────────────────────────────────\n');
	process.stderr.write('Verifiable pointer to the published source tarball\n');
	process.stderr.write(
		'(auto-mirrored to Codeberg / GitHub / SourceForge / SourceHut).  Leave ALL empty to omit.\n'
	);
	process.stderr.write('source_sha256 + gpg_fingerprint go together; both come from\n');
	process.stderr.write('the release-attached distribution-anchor.env.\n\n');

	const sourceSha256 = await ask(
		'Source tarball SHA-256 (64 hex; empty to omit distribution)',
		process.env.MORPHIT_BUILD_SOURCE_SHA256 ?? ''
	);
	// v1.16.9 — the `-offline` bundle's SHA-256. Env-only (no prompt): it comes
	// from release.yml's offline-bundle build, and is optional (omitted if unset).
	const offlineSha256 = (process.env.MORPHIT_BUILD_OFFLINE_SHA256 ?? '').trim();
	const gpgFingerprint = await ask(
		'GPG signing-key fingerprint (40 or 64 hex, spaces ok)',
		process.env.MORPHIT_BUILD_GPG_FINGERPRINT ?? ''
	);
	const ipfsCid = await ask(
		'IPFS CID of the release directory (bafy…)',
		process.env.MORPHIT_BUILD_IPFS_CID ?? ''
	);
	const ipnsName = await ask(
		'Stable IPNS name k51… (optional; the "always latest" pointer)',
		process.env.MORPHIT_BUILD_IPNS_NAME ?? ''
	);
	const ipnsRecord = await ask(
		'Signed IPNS record base64 (optional; the DHT-rebroadcast pointer)',
		process.env.MORPHIT_BUILD_IPNS_RECORD ?? ''
	);
	const mirrors = await ask(
		'Mirror URLs (https://…, comma-separated; optional)',
		process.env.MORPHIT_BUILD_MIRRORS ?? ''
	);

	return {
		version,
		hashManifest,
		endpoints,
		btcAddress,
		btcSatoshis,
		btcXpub,
		xmrAddress,
		xmrPiconero,
		xmrPrimary,
		blurtBase,
		sourceSha256,
		offlineSha256,
		gpgFingerprint,
		ipfsCid,
		ipnsName,
		ipnsRecord,
		mirrors
	};
}

/** build the optional distribution anchor from the operator's
 *  inputs.  Returns null when the whole block is omitted.  GPG prints
 *  fingerprints with spaces; we strip them so the validator (which
 *  forbids spaces) accepts a copy-pasted fingerprint. */
/** Morphit's stable IPNS name — the same for every release (keep in step with
 *  apps/web/src/lib/ipns.ts MORPHIT_IPNS_NAME; a test compares them). Every
 *  zero-clearnet node up to v1.20.2 refuses a release without it. */
export const CANONICAL_IPNS_NAME = 'k51qzi5uqu5dgkxmhwchxq4f9yiggxqyine7ang3xdz1ohmwc8csya1sqtcicf';

/** The `/ipfs/<cid>` an IPNS record points at (its Value field), or null. The
 *  record is protobuf; the value is plain text inside it, so a byte scan finds
 *  it without a protobuf parser. */
export function ipnsRecordTarget(recordB64: string): string | null {
	let bytes: Buffer;
	try {
		bytes = Buffer.from(recordB64, 'base64');
	} catch {
		return null;
	}
	const m = /\/ipfs\/([a-z0-9]{46,})/.exec(bytes.toString('latin1'));
	return m ? m[1]! : null;
}

function buildDistribution(i: Inputs, flags: BuilderFlags): ReleaseDistributionBlock | null {
	const sha = i.sourceSha256.trim().toLowerCase();
	const offlineSha = (i.offlineSha256 ?? '').trim().toLowerCase();
	const fpr = i.gpgFingerprint.replace(/\s+/g, '').toUpperCase();
	const cid = i.ipfsCid.trim();
	const ipns = i.ipnsName.trim();
	const ipnsRec = i.ipnsRecord.trim();
	let mirrorList = i.mirrors
		.split(/[,\s]+/)
		.map((m) => m.trim())
		.filter((m) => m.length > 0);

	// The whole block is omitted only when NOTHING was supplied.
	if (
		sha === '' &&
		fpr === '' &&
		cid === '' &&
		ipns === '' &&
		ipnsRec === '' &&
		mirrorList.length === 0
	)
		return null;

	if (sha === '' || fpr === '') {
		fail(
			'distribution needs BOTH source_sha256 and gpg_fingerprint (or leave all fields empty to omit)'
		);
	}

	// The mirrors are a FIXED decentralization breadcrumb: Forgejo auto-pushes
	// commits + the signed tag to these hosts, so an operator never has to
	// supply them. Default to the canonical set when the block IS being
	// emitted (sha + fpr present) and no explicit list was given. NB: this
	// default is applied HERE, not at the prompt — applying it at the prompt
	// would make mirrorList always non-empty, so an anchor-less build could no
	// longer omit the whole block by leaving sha + fpr empty (it would trip the
	// "needs BOTH" failure above). Emitted only alongside a real anchor.
	// v1.8.16 — SourceForge + SourceHut added; both mirror the same signed
	// bytes and appear as live cards on the download page. GitLab, Bitbucket and
	// Launchpad added once their Forgejo push-mirrors were confirmed live.
	// v1.9.6 — gitea.com + framagit.org push-mirrors confirmed live; NINE total.
	// on-chain cap was bumped 8 -> 10 (handlers/release.ts + release-schema) to fit
	// them, so — exactly like Launchpad's `+` regex — a release carrying this list
	// only validates on a v1.9.6+ instance; the ceremony upgrades the canonical
	// instance before it broadcasts (older instances reject the op until they
	// upgrade, keeping the prior release until then). Launchpad's URL still carries
	// a `+` (`/+git/`) needing the relaxed mirror regex.
	// v1.11.1 — NINE new push-mirrors confirmed live (gitgud.io,
	// forge.chapril.org, git.disroot.org, git.kaki87.net, codefloe.com, git.gay,
	// bolha.dev, opencommit.eu, sij.ai) → EIGHTEEN total. The on-chain cap was
	// bumped 10 -> 32 (same forward-compat pattern: v1.11.1+ only; ceremony
	// upgrades the canonical instance first) with headroom for the pending
	// Savannah + 0xacab mirrors (→20, the goal) plus room beyond.
	if (mirrorList.length === 0) {
		mirrorList = [
			'https://codeberg.org/agorise/morphit',
			'https://github.com/agorise/morphit',
			'https://sourceforge.net/projects/agorise-morphit/',
			'https://git.sr.ht/~agorise/morphit',
			'https://gitlab.com/Agorise/morphit',
			'https://bitbucket.org/agorise/morphit',
			'https://git.launchpad.net/~agorise/+git/morphit',
			'https://gitea.com/agorise/morphit',
			'https://framagit.org/agorise/morphit',
			'https://gitgud.io/agorise/morphit',
			'https://forge.chapril.org/agorise/morphit',
			'https://git.disroot.org/agorise/morphit',
			'https://git.kaki87.net/agorise/morphit',
			'https://codefloe.com/agorise/morphit',
			'https://git.gay/agorise/morphit',
			'https://bolha.dev/agorise/morphit',
			'https://opencommit.eu/agorise/morphit',
			'https://sij.ai/agorise/morphit'
		];
	}

	const value: Record<string, unknown> = { source_sha256: sha, gpg_fingerprint: fpr };
	// v1.16.9 — the self-contained `-offline` bundle's SHA-256, so a hidden /
	// air-gapped node can verify an offline upgrade against the chain (via its own
	// indexer) with no hand-signed .asc. Optional; omitted if not provided.
	if (/^[0-9a-f]{64}$/.test(offlineSha)) value.offline_sha256 = offlineSha;
	if (cid !== '') value.ipfs_cid = cid;
	// v1.20.3: the name is fixed, so it is always included — v1.20.2 went out
	// without it (its anchor had none) and zero-clearnet nodes refused it.
	value.ipns_name = ipns !== '' ? ipns : CANONICAL_IPNS_NAME;
	if (ipnsRec !== '') {
		// v1.20.3: a record must point at THIS release. v1.20.2's first dry-run
		// carried v1.20.1's record (and CID), left in the laptop's terminal by
		// the previous ceremony's `source`.
		const target = ipnsRecordTarget(ipnsRec);
		if (cid === '') {
			fail(
				'an IPNS record was given but no ipfs_cid to check it against — unset MORPHIT_BUILD_IPNS_RECORD (it is probably left over from an earlier release)'
			);
		}
		if (target !== cid) {
			fail(
				`the IPNS record points at ${target ?? '(unreadable)'}, not this release's ipfs_cid ${cid} — it is left over from an earlier release; unset MORPHIT_BUILD_IPNS_RECORD (open a new terminal) and build again`
			);
		}
		value.ipns_record = ipnsRec;
	}
	// After the record check, whose message names a left-over record exactly.
	if (cid === '' && !flags.allowNoIpfsCid) {
		// v1.20.2: release.yml could not download Kubo, the anchor carried no CID,
		// the payload went out without one (it was only a warning), and every
		// zero-clearnet instance (Tor/I2P only) was left unable to fetch the release.
		fail(
			`this release has no IPFS CID, and zero-clearnet instances (Tor/I2P only) cannot fetch a release without one.\n` +
				`  release.yml could not compute it. Have morphit.io host the release and print it.\n` +
				`  1. On morphit.io, logged in as root (this installs nothing; it downloads the release, checks it against the\n` +
				`     anchored SHA-256, and seeds it with the release's own seed scripts):\n` +
				`      ${noCidSeedCommand(i.version)}\n` +
				`     It prints the line:  morphit-ipfs-seed: hosted v${i.version} → bafy…  (use that CID, even if lines after it warn)\n` +
				`  2. On the laptop, run this payload line again with  --ipfs-cid <that CID>  added right after release-build-payload.ts,\n` +
				`     then the dry-run line again.\n` +
				`  (Only if no box printed one: --allow-no-ipfs-cid publishes without it, and zero-clearnet nodes cannot upgrade.)`
		);
	} else if (cid === '') {
		process.stderr.write(
			'\n⚠ --allow-no-ipfs-cid: no ipfs_cid — zero-clearnet instances (Tor/I2P only) cannot fetch this release.\n\n'
		);
	}
	if (mirrorList.length > 0) value.mirrors = mirrorList;
	return value as unknown as ReleaseDistributionBlock;
}

/**
 * The no-CID fallback, run on morphit.io as root: the NEW release's own seed
 * and staging scripts, from the published tarball after checking it against
 * the anchored SHA-256. The installed copies are the previous release's, and a
 * change in how a release directory is staged would give a CID this release's
 * own upgrades never reproduce. Printed only when the anchor has no CID (the
 * line under Block 3 of scripts/eli5-release.sh says so); releaseCeremony.test.ts
 * runs it.
 */
export function noCidSeedCommand(version: string): string {
	const url = `https://git.agorise.net/agorise/morphit/releases/download/v${version}`;
	const tgz = `morphit-v${version}.tar.gz`;
	return (
		`D=$(mktemp -d) && chmod 755 "$D" && cd "$D" && curl -fsSLO ${url}/distribution-anchor.env && ` +
		`curl -fsSLO ${url}/${tgz} && ` +
		`echo "$(sed -n 's/^export MORPHIT_BUILD_SOURCE_SHA256=//p' distribution-anchor.env)  ${tgz}" | sha256sum -c && ` +
		`tar -xzf ${tgz} --no-same-owner --wildcards './ops/ipfs/*' && ` +
		`sudo -u ipfs env IPFS_PATH=/var/lib/ipfs/.ipfs MORPHIT_STAGE_TARBALL="$D/${tgz}" MORPHIT_SEED_ORIGIN=https://morphit.io ` +
		`sh "$D/ops/ipfs/morphit-ipfs-seed.sh" v${version}`
	);
}

function buildTreasury(i: Inputs): ReleaseTreasuryBlock | null {
	const hasBtc = i.btcAddress !== '';
	// XMR mode is gated on the ADDRESS field — the piconero
	// can have a non-empty default from env, but if the
	// operator left the address empty they don't want XMR pinned
	// at all this release.
	//
	// NO viewkey field built into the treasury block.
	// No indexer uses a view key; it is never part of a
	// chain-broadcast payload.
	const hasXmr = i.xmrAddress !== '';
	const hasBlurt = i.blurtBase.trim() !== '';
	if (!hasBtc && !hasXmr && !hasBlurt) return null;

	let btc: ReleaseTreasuryBlock['btc'] = hasBtc
		? {
				address: i.btcAddress,
				satoshis: Number.parseInt(i.btcSatoshis, 10)
			}
		: null;

	// v1.20.0 (MK-H2) — pin the treasury account xpub next to the address.
	// The address stays: pre-v1.20 validators require it, and txid-mode
	// orders from before the pin are still verified against it.
	const xpubInput = (i.btcXpub ?? '').trim();
	if (xpubInput !== '') {
		if (btc === null) fail('a BTC treasury xpub needs the BTC fee address and amount too');
		const check = checkTreasuryXpubInput(xpubInput);
		// Never echo the input: it could be a private key.
		if (!check.ok) fail(`BTC treasury key refused — ${check.message}`);
		btc = { ...btc!, xpub: check.xpub };
		process.stderr.write('\n── BTC treasury key (MK-H2) ──────────────────────────────\n');
		process.stderr.write(
			`key id ${check.keyId}. Receive addresses #0-#2 — these MUST be the first\n`
		);
		process.stderr.write(
			"three rows of the treasury wallet's Addresses tab (Receive Addresses):\n"
		);
		check.receive.forEach((a, n) => process.stderr.write(`  #${n}  ${a}\n`));
	}

	let xmr: ReleaseTreasuryBlock['xmr'] = null;
	if (hasXmr) {
		if (i.xmrPiconero === '') fail('XMR piconero amount required when XMR address supplied');
		xmr = {
			address: i.xmrAddress,
			piconero: i.xmrPiconero
		};
	}
	// v1.20.0 (MK-H2) — pin the treasury MAIN address next to the fee address.
	// The fee address stays: pre-v1.20 validators require it, and XMR orders
	// posted before the pin are still verified against it.
	const primaryInput = (i.xmrPrimary ?? '').trim();
	if (primaryInput !== '') {
		if (xmr === null) fail('an XMR treasury main address needs the XMR fee address and amount too');
		const check = checkTreasuryXmrPrimaryInput(primaryInput);
		if (!check.ok) fail(`XMR treasury main address refused — ${check.message}`);
		xmr = { ...xmr!, primary_address: check.address };
		process.stderr.write('\n── XMR treasury main address (MK-H2) ─────────────────────\n');
		process.stderr.write(
			'In the treasury wallet (monero-wallet-cli), `integrated_address ' +
				check.sample.paymentId +
				'`\n'
		);
		process.stderr.write('MUST print exactly:\n');
		process.stderr.write(`  ${check.sample.integrated}\n`);
	}

	// optional BLURT base.  Parsed as a float (BLURT has
	// 3-decimal precision).  Only attached when present so a release
	// without it serializes byte-identically to the legacy shape.
	if (hasBlurt) {
		const base = Number.parseFloat(i.blurtBase);
		if (!Number.isFinite(base) || base <= 0) fail('BLURT base must be a positive number');
		return { btc, xmr, blurt: { base } };
	}
	return { btc, xmr };
}

async function main(): Promise<void> {
	let flags: BuilderFlags;
	try {
		flags = parseBuilderArgs(process.argv.slice(2));
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	}
	loadAnchorFile(flags);
	const inputs = await gatherInputs();
	const treasury = buildTreasury(inputs);

	// Validate treasury independently first so the operator
	// gets a precise error before we bundle everything.
	if (treasury !== null) {
		const tResult = validateTreasury(treasury);
		if (!tResult.ok) {
			fail(`treasury validation failed: ${tResult.reason}`);
		}
	}

	// build + validate the distribution anchor independently too.
	const distribution = buildDistribution(inputs, flags);
	if (distribution !== null) {
		const dResult = validateDistribution(distribution);
		if (!dResult.ok) {
			fail(`distribution validation failed: ${dResult.reason}`);
		}
	}

	const payload: ReleasePayloadV1 = {
		version: inputs.version,
		hash_manifest: inputs.hashManifest as ReleasePayloadV1['hash_manifest'],
		// omit endpoints entirely unless one was explicitly provided.
		...(inputs.endpoints !== undefined
			? { endpoints: inputs.endpoints as ReleasePayloadV1['endpoints'] }
			: {}),
		...(treasury !== null ? { treasury } : {}),
		...(distribution !== null ? { distribution } : {})
	};

	// Final whole-payload validation — same checks the on-chain
	// handler runs.  Any error here means the chain would reject
	// this op too.
	const result = validateReleasePayload(payload);
	if (!result.ok) {
		fail(`payload validation failed: ${result.reason}`);
	}

	// Sanity gate — defense-in-depth: scan the serialized
	// payload for anything that looks like a 64-hex view key.  If
	// something looks like one, refuse to emit (the operator may have
	// hand-crafted a payload that re-introduces the viewkey field).
	//
	// the distribution anchor LEGITIMATELY contains 64-hex fields
	// (source_sha256 is always 64 lowercase hex; gpg_fingerprint may be
	// the 64-hex v5 form) — those are the tarball hash + signing key
	// fingerprint, NOT a view key, and are strictly validated by
	// validateDistribution above.  Exclude the distribution block from
	// this scan so it can't false-positive; a re-introduced view key
	// would live in the TREASURY block, which is still scanned.
	const { distribution: _dist, ...payloadWithoutDistribution } = payload;
	const serialized = JSON.stringify(payloadWithoutDistribution);
	const VIEWKEY_LOOKING_RE = /\b[0-9a-f]{64}\b/;
	if (VIEWKEY_LOOKING_RE.test(serialized)) {
		fail(
			'payload contains a 64-hex string that looks like an XMR view key — ' +
				'View keys must never be embedded in release ops.  Check your ' +
				'inputs and remove any viewkey field before retrying.'
		);
	}

	// Emit canonical JSON to stdout.  No trailing newline so
	// downstream pipelines (e.g. `| blurt broadcast`) don't have
	// to strip whitespace.
	process.stdout.write(JSON.stringify(payload, null, 2));

	process.stderr.write('\n\n── ✓ Payload validated ───────────────────────────────────\n');
	process.stderr.write('Payload printed to stdout.  Pipe it to your Blurt\n');
	process.stderr.write('signing tool to broadcast as a custom_json op:\n\n');
	process.stderr.write('    required_posting_auths: ["morphit"]\n');
	process.stderr.write('    id: "morphit_release_v1"\n\n');
	process.stderr.write('Sign with the @morphit PRIVATE posting key (the WIF —\n');
	process.stderr.write('starts "5...", NOT the public posting key).  See\n');
	process.stderr.write('docs/OPERATIONS.md §40.5 for the full ceremony.\n\n');
	// previous versions of this script printed a
	// reminder to run `verify-xmr-viewkey.ts` before broadcasting,
	// because the view key was operator-private and a typo would
	// silently break XMR verification.  Since later+ the view
	// key is no longer used by any indexer (per-payment proofs
	// replaced view-key-based decryption); a later change removed the
	// env var entirely; a later change retired the script.  No
	// pre-broadcast viewkey check is needed — the only thing
	// chain-pinned here is the public XMR address, which is
	// verified by-construction at payload-build time.
}

void main();
