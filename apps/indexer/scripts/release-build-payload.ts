/**
 * Morphit indexer — release-op payload builder (Part 106; Part 107).
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
 * **Privacy note (Part 107).**  This builder NEVER prompts for
 * the Monero view key, and its output payload NEVER contains a
 * view key.  The view key stays in the operator's
 * `/etc/morphit/indexer.env` file on the canonical box; it is
 * never broadcast on chain.  The Part 106 design did embed the
 * view key in the payload under the rationale that "it's
 * publish-safe by Monero design"; that was a privacy mistake
 * (the key reveals every incoming payment forever).  Part 107
 * removes the viewkey from the chain-pinned `treasury` block.
 * If you have a custom payload from before Part 107 with a
 * viewkey field, you should regenerate it WITHOUT the viewkey
 * before broadcasting.  (Part 110: the previous
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
 *   #   MORPHIT_BUILD_XMR_ADDRESS=4...
 *   #   MORPHIT_BUILD_XMR_PICONERO=781250000
 *   #   MORPHIT_BUILD_HASH_MANIFEST_FILE=/path/to/manifest.json
 *   #   MORPHIT_BUILD_ENDPOINTS_FILE=/path/to/endpoints.json
 *   #   tsx apps/indexer/scripts/release-build-payload.ts > release.json
 *
 * Output: a single JSON object on stdout, ready to broadcast
 * as the `json` field of a Blurt `custom_json` op.  Errors
 * print to stderr; the script exits non-zero if validation
 * fails so a CI pipeline can detect bad values.
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import { validateReleasePayload, validateTreasury } from '@morphit/release-schema';
import type { ReleasePayloadV1, ReleaseTreasuryBlock } from '@morphit/release-schema';
import { CANONICAL_TREASURY } from '../src/config/canonicalTreasury.ts';

function fail(reason: string): never {
	process.stderr.write(`\n✗ ${reason}\n`);
	process.exit(1);
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
	endpoints: Record<string, unknown>;
	btcAddress: string;
	btcSatoshis: string;
	xmrAddress: string;
	xmrPiconero: string;
}

async function gatherInputs(): Promise<Inputs> {
	process.stderr.write('\n── Morphit release-op payload builder ────────────────────\n');
	process.stderr.write('Enter values for the morphit_release_v1 op.  Leave a\n');
	process.stderr.write('field empty to omit (treasury fields only — version,\n');
	process.stderr.write('hash_manifest, endpoints are required).\n\n');

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

	const endpointsPath = await ask(
		'Path to endpoints JSON file',
		process.env.MORPHIT_BUILD_ENDPOINTS_FILE
	);
	if (!endpointsPath) fail('endpoints file path is required');
	const endpoints = readJsonFile(endpointsPath, 'endpoints');

	process.stderr.write('\n── Treasury (Part 106; Part 107) ─────────────────────────\n');
	process.stderr.write('Leave any treasury field empty to omit that chain.\n');
	process.stderr.write('Both BTC and XMR fields independently optional.\n');
	process.stderr.write('NOTE: this builder does NOT prompt for the XMR view\n');
	process.stderr.write('key — it stays env-only on the indexer machine and\n');
	process.stderr.write('is never broadcast on chain (Part 107 privacy\n');
	process.stderr.write('invariant).  See ops/env/indexer.env.example.\n\n');

	const btcAddress = await ask(
		'BTC fee address (mainnet bc1q.../1.../3...)',
		process.env.MORPHIT_BUILD_BTC_ADDRESS ?? CANONICAL_TREASURY.btc
	);
	const btcSatoshis = await ask(
		'BTC fee amount (satoshis)',
		process.env.MORPHIT_BUILD_BTC_SATOSHIS ?? '416'
	);

	const xmrAddress = await ask(
		'XMR fee address (mainnet 4.../8...)',
		process.env.MORPHIT_BUILD_XMR_ADDRESS ?? CANONICAL_TREASURY.xmr
	);
	const xmrPiconero = await ask(
		'XMR fee amount (piconero)',
		process.env.MORPHIT_BUILD_XMR_PICONERO ?? '781250000'
	);

	return {
		version,
		hashManifest,
		endpoints,
		btcAddress,
		btcSatoshis,
		xmrAddress,
		xmrPiconero
	};
}

function buildTreasury(i: Inputs): ReleaseTreasuryBlock | null {
	const hasBtc = i.btcAddress !== '';
	// XMR mode is gated on the ADDRESS field — the piconero
	// can have a non-empty default from env, but if the
	// operator left the address empty they don't want XMR pinned
	// at all this release.
	//
	// Part 107: NO viewkey field built into the treasury block.
	// View key stays in the operator's env on the indexer
	// machine and is never part of a chain-broadcast payload.
	const hasXmr = i.xmrAddress !== '';
	if (!hasBtc && !hasXmr) return null;

	const btc = hasBtc
		? {
				address: i.btcAddress,
				satoshis: Number.parseInt(i.btcSatoshis, 10)
			}
		: null;

	let xmr: ReleaseTreasuryBlock['xmr'] = null;
	if (hasXmr) {
		if (i.xmrPiconero === '') fail('XMR piconero amount required when XMR address supplied');
		xmr = {
			address: i.xmrAddress,
			piconero: i.xmrPiconero
		};
	}

	return { btc, xmr };
}

async function main(): Promise<void> {
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

	const payload: ReleasePayloadV1 = {
		version: inputs.version,
		hash_manifest: inputs.hashManifest as ReleasePayloadV1['hash_manifest'],
		endpoints: inputs.endpoints as ReleasePayloadV1['endpoints'],
		...(treasury !== null ? { treasury } : {})
	};

	// Final whole-payload validation — same checks the on-chain
	// handler runs.  Any error here means the chain would reject
	// this op too.
	const result = validateReleasePayload(payload);
	if (!result.ok) {
		fail(`payload validation failed: ${result.reason}`);
	}

	// Sanity gate (Part 107) — defense-in-depth: scan the
	// serialized payload for anything that looks like a 64-hex
	// view key.  If something looks like one, refuse to emit
	// (the operator may have hand-crafted a payload that re-
	// introduces the viewkey field).
	const serialized = JSON.stringify(payload);
	const VIEWKEY_LOOKING_RE = /\b[0-9a-f]{64}\b/;
	if (VIEWKEY_LOOKING_RE.test(serialized)) {
		fail(
			'payload contains a 64-hex string that looks like an XMR view key — ' +
				'Part 107 forbids embedding view keys in release ops.  Check your ' +
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
	process.stderr.write('Sign with the @morphit posting key.  See\n');
	process.stderr.write('docs/OPERATIONS.md §40.5 for the full ceremony.\n\n');
	// Part 110 note: previous versions of this script printed a
	// reminder to run `verify-xmr-viewkey.ts` before broadcasting,
	// because the view key was operator-private and a typo would
	// silently break XMR verification.  Since Part 108++ the view
	// key is no longer used by any indexer (per-payment proofs
	// replaced view-key-based decryption); Part 109 removed the
	// env var entirely; Part 110 retired the script.  No
	// pre-broadcast viewkey check is needed — the only thing
	// chain-pinned here is the public XMR address, which is
	// verified by-construction at payload-build time.
}

void main();
