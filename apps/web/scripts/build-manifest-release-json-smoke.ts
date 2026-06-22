/**
 * build-manifest-release-json-smoke (cp319)
 *
 * Guards the launch-critical release-op hash_manifest pipeline that
 * had silently diverged before cp319 (the release op has never been
 * broadcast, so nobody had run generator → builder → validator as a
 * pipeline).  The two artifacts build-manifest.mjs emits are DISTINCT:
 *
 *   • default            → reproducible-build fingerprint
 *                          (`<hex>  ./<rel>` per line, brag #222).
 *   • `--release-json`    → the on-chain morphit_release_v1 manifest
 *                          (JSON object `/<served-path>: sha256-<b64>`).
 *
 * This smoke asserts:
 *   1. computeManifest derives BOTH encodings from one digest, sorted.
 *   2. renderSha256sumText keeps the EXACT legacy reproducibility
 *      format (a regression here would break clone-vs-ship diffs).
 *   3. buildReleaseManifest emits SRI base64 under SERVED-PATH keys
 *      (`/<rel>`, never `./` — the frontend fetches each key as a
 *      same-origin URL), and --prefix scoping filters correctly.
 *   4. Every SRI value matches the schema's SHA256_RE, and a payload
 *      built from the manifest passes the REAL validateReleasePayload.
 *   5. No SRI value (and no serialized manifest) contains a bare
 *      64-hex run, so the broadcaster's assertNoSecretHex never
 *      false-positives on a legitimate release manifest.
 *   6. manifestSerializedBytes measures the compact serialization the
 *      schema's byteLengthOfJson measures, and an over-cap manifest is
 *      detectable (the CLI refuses it).
 *   7. Static wiring: build-manifest.mjs exposes the --release-json
 *      mode + size guard, and PRE-LAUNCH-CHECKLIST §B drives the
 *      builder via the MORPHIT_BUILD_HASH_MANIFEST_FILE env var (NOT a
 *      nonexistent --hash-manifest flag).
 */

import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleasePayload } from '@morphit/release-schema';
import {
	computeManifest,
	renderSha256sumText,
	buildReleaseManifest,
	manifestSerializedBytes
} from './build-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let failures = 0;
let scenarios = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	scenarios++;
};
const bad = (m: string, d: string) => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failures++;
	scenarios++;
};

const SRI_RE = /^sha256-[A-Za-z0-9+/]{43}=$/; // mirror of release-schema SHA256_RE
const SECRET_HEX_RE = /\b[0-9a-f]{64}\b/; // mirror of releaseBroadcastOp assertNoSecretHex
const SCHEMA_CAP = 64 * 1024; // mirror of MANIFEST_MAX_SERIALIZED_BYTES

async function main(): Promise<void> {
	// ── fixture build dir ──────────────────────────────────────────
	const dir = await mkdtemp(join(tmpdir(), 'bm-smoke-'));
	try {
		await writeFile(join(dir, 'index.html'), '<html>shell</html>');
		await mkdir(join(dir, '_app', 'immutable'), { recursive: true });
		await writeFile(join(dir, '_app', 'immutable', 'app.js'), 'console.log("morphit")');
		await writeFile(join(dir, 'service-worker.js'), '// sw');
		await mkdir(join(dir, 'en'), { recursive: true });
		await writeFile(join(dir, 'en', 'faq.html'), '<html>faq</html>');

		// 1. computeManifest — both encodings, sorted
		const entries = await computeManifest(dir);
		const sorted = entries.every(
			(e, i) => i === 0 || entries[i - 1]!.rel <= e.rel
		);
		const everyHasBoth = entries.every(
			(e) => /^[0-9a-f]{64}$/.test(e.hex) && SRI_RE.test(e.sri)
		);
		if (entries.length === 4 && sorted && everyHasBoth)
			ok('computeManifest: 4 entries, codepoint-sorted, each carries hex + SRI');
		else
			bad('computeManifest shape wrong', `n=${entries.length} sorted=${sorted} both=${everyHasBoth}`);

		// digest parity: hex and sri are two encodings of the SAME digest
		const sameDigest = entries.every((e) => {
			const fromHex = Buffer.from(e.hex, 'hex').toString('base64');
			return `sha256-${fromHex}` === e.sri;
		});
		if (sameDigest) ok('computeManifest: hex and SRI are the same digest in two encodings');
		else bad('hex/SRI digest mismatch', 'a file would hash differently in the two outputs');

		// 2. reproducibility text format unchanged
		const text = renderSha256sumText(entries);
		const lines = text.replace(/\n$/, '').split('\n');
		const textOk =
			text.endsWith('\n') &&
			lines.length === 4 &&
			lines.every((l) => /^[0-9a-f]{64} {2}\.\/.+$/.test(l));
		if (textOk) ok("renderSha256sumText: legacy '<hex>  ./<rel>' reproducibility format intact");
		else bad('reproducibility text format changed', `would break clone-vs-ship diffs:\n${lines[0]}`);

		// 3. release JSON — served-path keys + SRI values + scoping
		const all = buildReleaseManifest(entries);
		const keysServed = Object.keys(all).every((k) => k.startsWith('/') && !k.startsWith('/./'));
		const valuesSri = Object.values(all).every((v) => SRI_RE.test(v as string));
		if (Object.keys(all).length === 4 && keysServed && valuesSri)
			ok('buildReleaseManifest: served-path keys (/<rel>) + SRI base64 values, all 4 files');
		else
			bad('release manifest shape wrong', `keys=${keysServed} values=${valuesSri}`);

		const scoped = buildReleaseManifest(entries, { prefixes: ['_app/', 'index.html'] });
		const scopedKeys = Object.keys(scoped).sort();
		if (
			scopedKeys.length === 2 &&
			scopedKeys[0] === '/_app/immutable/app.js' &&
			scopedKeys[1] === '/index.html'
		)
			ok('buildReleaseManifest --prefix scopes to the requested subtree(s)');
		else bad('--prefix scoping wrong', `got ${JSON.stringify(scopedKeys)}`);

		// normalized prefix: '/_app/', '_app/', '_app' all match
		const p1 = Object.keys(buildReleaseManifest(entries, { prefixes: ['/_app/'] }));
		const p2 = Object.keys(buildReleaseManifest(entries, { prefixes: ['_app'] }));
		if (p1.length === 1 && p1[0] === '/_app/immutable/app.js' && p2.length === 1)
			ok('--prefix normalizes leading/trailing slashes');
		else bad('--prefix normalization wrong', `p1=${JSON.stringify(p1)} p2=${JSON.stringify(p2)}`);

		// 4. REAL schema validation of a payload built from the manifest
		const payload = {
			version: '1.0.0',
			hash_manifest: all,
			endpoints: { rpc: ['https://rpc.blurt.world'] }
		};
		const res = validateReleasePayload(payload);
		if (res.ok) ok('validateReleasePayload accepts a payload built from --release-json output');
		else bad('release payload rejected by the real validator', `reason=${res.reason}`);

		// 5. assertNoSecretHex never false-positives on a real manifest
		const serialized = JSON.stringify(all);
		if (!SECRET_HEX_RE.test(serialized) && Object.values(all).every((v) => !SECRET_HEX_RE.test(v as string)))
			ok('no SRI value (or the serialized manifest) is a bare 64-hex run → broadcaster will not refuse it');
		else bad('manifest contains a 64-hex run', 'assertNoSecretHex would block the launch broadcast');

		// 6. size measurement matches the schema, and over-cap is detectable
		const measured = manifestSerializedBytes(all);
		const schemaMeasure = new TextEncoder().encode(JSON.stringify(all)).length;
		if (measured === schemaMeasure)
			ok('manifestSerializedBytes matches the schema byteLengthOfJson (compact UTF-8)');
		else bad('size measurement diverged from the schema', `${measured} vs ${schemaMeasure}`);

		const big: Record<string, string> = {};
		for (let i = 0; i < 1000; i++) big[`/_app/immutable/chunk-${i}.js`] = 'sha256-' + 'A'.repeat(43) + '=';
		const bigBytes = manifestSerializedBytes(big);
		const bigValid = validateReleasePayload({
			version: '1.0.0',
			hash_manifest: big,
			endpoints: { rpc: ['https://x.example'] }
		});
		if (bigBytes > SCHEMA_CAP && !bigValid.ok && bigValid.reason === 'hash_manifest_too_large')
			ok(`over-cap manifest (${bigBytes} B) exceeds the ${SCHEMA_CAP}-byte cap and the schema rejects it`);
		else bad('over-cap manifest not flagged', `bytes=${bigBytes} valid=${JSON.stringify(bigValid)}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}

	// 7. static wiring guards
	const genSrc = await readFile(join(REPO, 'apps/web/scripts/build-manifest.mjs'), 'utf-8');
	if (
		genSrc.includes('--release-json') &&
		genSrc.includes('export function buildReleaseManifest') &&
		genSrc.includes('MANIFEST_MAX_SERIALIZED_BYTES') &&
		genSrc.includes('over the')
	)
		ok('build-manifest.mjs exposes --release-json mode + the 64 KB size guard');
	else bad('build-manifest.mjs lost the release-json mode/guard', 'launch generator regressed');

	const checklist = await readFile(join(REPO, 'docs/PRE-LAUNCH-CHECKLIST.md'), 'utf-8');
	if (
		checklist.includes('--release-json') &&
		checklist.includes('MORPHIT_BUILD_HASH_MANIFEST_FILE') &&
		!checklist.includes('--hash-manifest')
	)
		ok('PRE-LAUNCH-CHECKLIST §B drives the builder via the real env var (no dead --hash-manifest flag)');
	else
		bad(
			'PRE-LAUNCH-CHECKLIST release-manifest instructions stale',
			'must use --release-json + MORPHIT_BUILD_HASH_MANIFEST_FILE, not --hash-manifest'
		);

	console.log(`\n${'─'.repeat(54)}`);
	if (failures === 0) {
		console.log(`✓ all ${scenarios} build-manifest-release-json scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${failures}/${scenarios} scenarios failed`);
		process.exit(1);
	}
}

void main();
