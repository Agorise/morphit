#!/usr/bin/env node
/*
 * scripts/verify-json-to-release-manifest.mjs
 *
 * Derive the on-chain `morphit_release_v1` hash_manifest DIRECTLY from a
 * served verify.json, instead of from a fresh local `npm run build`.
 *
 * WHY: the on-chain manifest must match the bytes the SITE SERVES. Building
 * the manifest from a laptop build assumes the laptop build is byte-identical
 * to the VPS build — cross-machine Vite/Rollup reproducibility that does NOT
 * always hold (different node version / OS / transitive dep => different chunk
 * hashes => "Build integrity check failed" banner even on a clean load). The
 * VPS already publishes the sha256 of every file it serves at
 * `/verify.json`; that IS ground truth. This converts its bootstrap subset to
 * the release-op SRI format so the manifest is match-by-construction.
 *
 * verify.json entry:  "_app/immutable/entry/app.X.js": "<64-hex sha256>"
 * release entry:      "/_app/immutable/entry/app.X.js": "sha256-<base64>"
 *
 * Scope = the tamper-critical BOOTSTRAP (shell + service worker + entry
 * loader), matching `build-manifest.mjs --release-json --prefix …` — small
 * enough to stay under the indexer's 4 KB JSONB cap.
 *
 * Usage:
 *   node scripts/verify-json-to-release-manifest.mjs <verify.json> > out.json
 *   curl -fsSL https://morphit.io/verify.json | node scripts/verify-json-to-release-manifest.mjs > out.json
 */
import { readFileSync } from 'node:fs';

const BOOTSTRAP_PREFIXES = ['index.html', 'service-worker', '_app/immutable/entry/'];

function fail(msg) {
	process.stderr.write(`verify-json-to-release-manifest: ${msg}\n`);
	process.exit(1);
}

const arg = process.argv[2];
let raw;
try {
	raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
} catch (e) {
	fail(`could not read input (${arg ?? 'stdin'}): ${e.message}`);
}

let doc;
try {
	doc = JSON.parse(raw);
} catch (e) {
	fail(`input is not valid JSON: ${e.message}`);
}

const hm = doc && typeof doc === 'object' ? doc.hash_manifest : undefined;
if (!hm || typeof hm !== 'object' || Array.isArray(hm)) {
	fail('input has no hash_manifest object (is this a verify.json?)');
}

const out = {};
for (const [key, hex] of Object.entries(hm)) {
	if (!BOOTSTRAP_PREFIXES.some((p) => key.startsWith(p))) continue;
	if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
		fail(`entry ${JSON.stringify(key)} is not a 64-char hex sha256`);
	}
	const b64 = Buffer.from(hex, 'hex').toString('base64');
	out[`/${key}`] = `sha256-${b64}`;
}

const count = Object.keys(out).length;
if (count === 0) fail('no bootstrap files matched — wrong verify.json or empty build');
process.stderr.write(`verify-json-to-release-manifest: ${count} bootstrap entries\n`);
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
