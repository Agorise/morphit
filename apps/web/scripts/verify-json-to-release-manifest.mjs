#!/usr/bin/env node
/*
 * scripts/verify-json-to-release-manifest.mjs
 *
 * Build the on-chain `morphit_release_v1` hash_manifest (the tamper-critical
 * BOOTSTRAP: shell + service worker + entry loader, in the release-op SRI
 * format) for a release.
 *
 * RELEASE MODE (the ceremony, ELI5 Block 4):
 *   node apps/web/scripts/verify-json-to-release-manifest.mjs \
 *     --anchor distribution-anchor.env --tarball morphit-vX.Y.Z.tar.gz \
 *     --served verify.json > build-manifest.release.json
 *
 *   1. The tarball's SHA-256 must equal the `MORPHIT_BUILD_SOURCE_SHA256` the
 *      release job anchored (the anchor file is PARSED, never sourced).
 *   2. The manifest is computed from the files of that tarball's prebuilt
 *      `apps/web/build` — the exact bytes every instance serves.
 *   3. The canonical instance's SERVED `/verify.json` must name the same hash
 *      for every one of those files. It is a must-match check, not the source:
 *      a served copy that differs (a rebuilt or altered site) stops the
 *      ceremony instead of being anchored on chain for every instance.
 *
 * LEGACY MODE (no flags): convert a verify.json's bootstrap subset as before.
 * Kept for inspection only; the ceremony does not use it.
 *   node scripts/verify-json-to-release-manifest.mjs <verify.json> > out.json
 *
 * verify.json entry:  "_app/immutable/entry/app.X.js": "<64-hex sha256>"
 * release entry:      "/_app/immutable/entry/app.X.js": "sha256-<base64>"
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeManifest } from './build-manifest.mjs';

const BOOTSTRAP_PREFIXES = ['index.html', 'service-worker', '_app/immutable/entry/'];

function fail(msg) {
	process.stderr.write(`verify-json-to-release-manifest: ${msg}\n`);
	process.exit(1);
}

const isBootstrap = (key) => BOOTSTRAP_PREFIXES.some((p) => key.startsWith(p));

/** verify.json → { "<rel>": "<hex>" } for the bootstrap files. */
function servedBootstrap(raw, label) {
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		fail(`${label} is not valid JSON: ${e.message}`);
	}
	const hm = doc && typeof doc === 'object' ? doc.hash_manifest : undefined;
	if (!hm || typeof hm !== 'object' || Array.isArray(hm)) {
		fail(`${label} has no hash_manifest object (is this a verify.json?)`);
	}
	const out = {};
	for (const [key, hex] of Object.entries(hm)) {
		if (!isBootstrap(key)) continue;
		if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
			fail(`${label} entry ${JSON.stringify(key)} is not a 64-char hex sha256`);
		}
		out[key] = hex;
	}
	return out;
}

const toRelease = (hexByRel) =>
	Object.fromEntries(
		Object.keys(hexByRel)
			.sort()
			.map((k) => [`/${k}`, `sha256-${Buffer.from(hexByRel[k], 'hex').toString('base64')}`])
	);

/** The anchored source SHA-256, read from the anchor file by key and shape. */
function anchoredSha(path) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (e) {
		fail(`could not read the anchor ${path}: ${e.message}`);
	}
	const hits = text
		.split('\n')
		.map((l) => /^export MORPHIT_BUILD_SOURCE_SHA256=([0-9a-f]{64})$/.exec(l.trim()))
		.filter(Boolean);
	if (hits.length !== 1)
		fail(`the anchor ${path} does not carry exactly one MORPHIT_BUILD_SOURCE_SHA256`);
	return hits[0][1];
}

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i === -1 ? null : (args[i + 1] ?? fail(`${name} needs a value`));
};

const tarball = flag('--tarball');
if (tarball !== null) {
	const anchor = flag('--anchor') ?? fail('--tarball needs --anchor <distribution-anchor.env>');
	const served =
		flag('--served') ?? fail('--tarball needs --served <the canonical instance’s verify.json>');
	const want = anchoredSha(anchor);
	let bytes;
	try {
		bytes = readFileSync(tarball);
	} catch (e) {
		fail(`could not read ${tarball}: ${e.message}`);
	}
	const got = createHash('sha256').update(bytes).digest('hex');
	if (got !== want)
		fail(
			`${tarball} has SHA-256 ${got}; the release anchored ${want}. Not this release's tarball.`
		);

	const dir = mkdtempSync(join(tmpdir(), 'morphit-release-manifest-'));
	try {
		const x = spawnSync(
			'tar',
			['-xzf', tarball, '-C', dir, '--no-same-owner', '--wildcards', '*apps/web/build/*'],
			{
				encoding: 'utf8'
			}
		);
		const build = [join(dir, 'apps', 'web', 'build'), join(dir, '.', 'apps', 'web', 'build')].find(
			(p) => existsSync(join(p, 'index.html'))
		);
		if (x.status !== 0 || build === undefined)
			fail(`${tarball} carries no prebuilt apps/web/build`);
		const entries = await computeManifest(build);
		const fromTarball = {};
		for (const e of entries) if (isBootstrap(e.rel)) fromTarball[e.rel] = e.hex;
		if (Object.keys(fromTarball).length === 0) fail('the tarball build has no bootstrap files');

		const fromServed = servedBootstrap(readFileSync(served, 'utf8'), served);
		const differ = [];
		for (const k of new Set([...Object.keys(fromTarball), ...Object.keys(fromServed)])) {
			if (fromTarball[k] !== fromServed[k]) differ.push(k);
		}
		if (differ.length > 0) {
			fail(
				`the served verify.json does not match the release tarball for ${differ.length} bootstrap file(s): ` +
					`${differ.slice(0, 5).join(', ')}${differ.length > 5 ? ', …' : ''}. ` +
					'Upgrade the canonical instance to this release (Block 3) and fetch verify.json again; do not anchor this.'
			);
		}
		const out = toRelease(fromTarball);
		process.stderr.write(
			`verify-json-to-release-manifest: ${Object.keys(out).length} bootstrap entries from the anchored tarball; the served verify.json matches\n`
		);
		process.stdout.write(JSON.stringify(out, null, 2) + '\n');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
} else {
	const arg = args[0];
	let raw;
	try {
		raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
	} catch (e) {
		fail(`could not read input (${arg ?? 'stdin'}): ${e.message}`);
	}
	const out = toRelease(servedBootstrap(raw, arg ?? 'stdin'));
	const count = Object.keys(out).length;
	if (count === 0) fail('no bootstrap files matched — wrong verify.json or empty build');
	process.stderr.write(`verify-json-to-release-manifest: ${count} bootstrap entries\n`);
	process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
