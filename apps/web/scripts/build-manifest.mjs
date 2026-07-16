#!/usr/bin/env node
/**
 * apps/web/scripts/build-manifest.mjs
 *
 * Walk apps/web/build/ recursively and emit a SHA-256 manifest of
 * every emitted file.  TWO output formats, for two DISTINCT purposes
 * — do not confuse them (cp319 fixed a launch-path mix-up where the
 * release op was fed the wrong one):
 *
 *   1. DEFAULT (no flag) — reproducible-build fingerprint.
 *      Output format (one line per file, sorted by path):
 *        <hex sha-256>  ./<relative-path-from-build-dir>
 *      Same shape as `find . -type f | sort | xargs sha256sum`.
 *      Written to `apps/web/build-manifest.sha256`.  This is the
 *      "did we ship the same bytes?" artifact a user with a local
 *      clone diffs against (brag #222 reproducibility; STRIDE audit).
 *      It is NOT the on-chain release manifest.
 *
 *   2. `--release-json [outfile]` — the on-chain `morphit_release_v1`
 *      hash_manifest.  Output is a JSON OBJECT mapping each asset's
 *      SERVED URL path → Subresource-Integrity hash:
 *        { "/_app/immutable/…": "sha256-<base64>", "/index.html": … }
 *      This is the EXACT shape @morphit/release-schema
 *      `validateReleasePayload` requires (SHA256_RE =
 *      /^sha256-[A-Za-z0-9+/]{43}=$/) and the frontend tamper-check
 *      (apps/web/src/lib/net/releaseHashCheck.ts) compares the running
 *      bundle against.  Feed it to the release-op builder:
 *        MORPHIT_BUILD_HASH_MANIFEST_FILE=<outfile> \
 *          tsx apps/indexer/scripts/release-build-payload.ts > release.json
 *      Written to `apps/web/build-manifest.release.json` by default.
 *
 * Keys vs. the default format: the release JSON uses `/<rel>` (a
 * leading slash, no `./`) because the frontend fetches each key as a
 * same-origin URL path; the reproducibility text uses `./<rel>` to
 * match `sha256sum`.  Both come from the same single file walk + a
 * single digest per file (hex and base64 are two encodings of it).
 *
 * SIZE: the schema caps the serialized hash_manifest at 64 KB
 * (~500 entries).  A full SvelteKit build (hundreds of prerendered
 * per-locale pages) can exceed that, so `--release-json` supports
 * `--prefix <p>` (repeatable) to scope to the tamper-critical
 * executable surface, e.g. `--prefix _app/ --prefix index.html
 * --prefix service-worker.js`.  If the manifest still exceeds the
 * cap the script exits non-zero with guidance — it never emits an
 * over-cap manifest the release op would reject.
 *
 * Why a script and not just `find | sha256sum`?
 *   - Cross-platform: works on macOS where `find -print0` and
 *     `xargs -0` need GNU coreutils.
 *   - Stable sort key: locale-independent path sort.
 *   - Single-file output (sha256sum on macOS spits multiple
 *     tools that disagree on output format).
 *
 * Usage:
 *   npm run build -w apps/web && npm run build:manifest -w apps/web
 *   node scripts/build-manifest.mjs --release-json --prefix _app/ --prefix index.html
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);
const WEB_ROOT = join(HERE, '..');
const DEFAULT_BUILD_DIR = join(WEB_ROOT, 'build');
const DEFAULT_TEXT_OUT = join(WEB_ROOT, 'build-manifest.sha256');
const DEFAULT_RELEASE_OUT = join(WEB_ROOT, 'build-manifest.release.json');

/** Mirror of @morphit/release-schema MANIFEST_MAX_SERIALIZED_BYTES.
 *  Kept in sync by build-manifest-release-json-smoke (which also runs
 *  the real validateReleasePayload, so a drift here is caught).
 *  cp430: aligned to the indexer's real per-field JSONB cap (4096) —
 *  the on-chain manifest is a tamper-critical SUBSET (shell + entry +
 *  service worker); full per-file coverage is the served /verify.json. */
const MANIFEST_MAX_SERIALIZED_BYTES = 4096;

async function* walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile()) {
			yield full;
		}
		// Skip symlinks, sockets, etc.  Build output shouldn't
		// contain these; if it does, it's a sign the build is
		// non-deterministic and should be investigated.
	}
}

/**
 * Walk `buildDir` and return sorted entries, each carrying BOTH hash
 * encodings derived from a single digest:
 *   { rel: '<forward-slash path>', hex: '<64 hex>', sri: 'sha256-<base64>' }
 * Pure apart from reading the build files; no writes, no process exit.
 */
export async function computeManifest(buildDir) {
	const entries = [];
	for await (const path of walk(buildDir)) {
		const rel = relative(buildDir, path).split('\\').join('/');
		const buf = await readFile(path);
		const digest = createHash('sha256').update(buf).digest();
		entries.push({
			rel,
			hex: digest.toString('hex'),
			sri: `sha256-${digest.toString('base64')}`
		});
	}
	// Stable sort by path — locale-independent (codepoint compare).
	entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	return entries;
}

/** Reproducible-build fingerprint: `<hex>  ./<rel>` per line, sorted.
 *  Byte-identical to the pre-cp319 default output. */
export function renderSha256sumText(entries) {
	return entries.map((e) => `${e.hex}  ./${e.rel}`).join('\n') + '\n';
}

/** Normalize a `--prefix` value to a forward-slash, no-leading-slash
 *  comparison key (so `/_app/`, `_app/`, and `_app` all match files
 *  under `_app/…`). */
function normalizePrefix(p) {
	return p.replace(/^\/+/, '');
}

/**
 * On-chain release hash_manifest: a JSON object mapping each asset's
 * SERVED URL path (`/<rel>`) → its `sha256-<base64>` SRI hash, sorted
 * by key.  Optionally scoped to entries whose path starts with one of
 * `prefixes`.  Returns the manifest OBJECT (caller serializes).
 *
 * cp474 — the JSDoc types below are load-bearing, not decoration: with
 * `prefixes = []` and no annotation, TypeScript infers the default as
 * `never[]`, so every typed caller passing real prefixes was an error the
 * moment `scripts/**` started being typechecked.
 *
 * @param {ReadonlyArray<{ rel: string, sri: string }>} entries
 * @param {{ prefixes?: readonly string[] }} [options]
 * @returns {Record<string, string>}
 */
export function buildReleaseManifest(entries, { prefixes = [] } = {}) {
	const norm = prefixes.map(normalizePrefix).filter((p) => p.length > 0);
	const obj = {};
	for (const e of entries) {
		if (norm.length > 0 && !norm.some((p) => e.rel.startsWith(p))) continue;
		obj[`/${e.rel}`] = e.sri;
	}
	return obj;
}

/** UTF-8 byte length of the COMPACT JSON serialization — matches the
 *  schema validator's `byteLengthOfJson`, so this guard agrees with
 *  what `validateReleasePayload` will measure. */
export function manifestSerializedBytes(manifestObj) {
	return new TextEncoder().encode(JSON.stringify(manifestObj)).length;
}

// ── CLI (only when run directly) ───────────────────────────────────
async function main() {
	const argv = process.argv.slice(2);
	let releaseJson = false;
	let outOverride = null;
	const prefixes = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--release-json') releaseJson = true;
		else if (a === '--prefix') {
			const v = argv[++i];
			if (v) prefixes.push(v);
		} else if (!a.startsWith('--') && outOverride === null) outOverride = a;
	}

	let buildExists;
	try {
		buildExists = (await stat(DEFAULT_BUILD_DIR)).isDirectory();
	} catch {
		buildExists = false;
	}
	if (!buildExists) {
		console.error(
			`build-manifest: ${DEFAULT_BUILD_DIR} does not exist — run \`npm run build -w apps/web\` first.`
		);
		process.exit(1);
	}

	const entries = await computeManifest(DEFAULT_BUILD_DIR);

	if (releaseJson) {
		const obj = buildReleaseManifest(entries, { prefixes });
		const count = Object.keys(obj).length;
		if (count === 0) {
			console.error(
				`build-manifest: --release-json produced 0 entries` +
					(prefixes.length ? ` (no files matched --prefix ${prefixes.join(' / ')})` : '') +
					` — nothing to pin.`
			);
			process.exit(1);
		}
		const bytes = manifestSerializedBytes(obj);
		if (bytes > MANIFEST_MAX_SERIALIZED_BYTES) {
			console.error(
				`build-manifest: release manifest is ${bytes} bytes serialized, over the ` +
					`${MANIFEST_MAX_SERIALIZED_BYTES}-byte cap (${count} entries) — the indexer's ` +
					`per-field JSONB limit; anything larger is filed 'hash_manifest_too_large'.\n` +
					`Scope it to the tamper-critical BOOTSTRAP (shell + entry + service worker):\n` +
					`  node scripts/build-manifest.mjs --release-json OUT --prefix index.html --prefix service-worker --prefix _app/immutable/entry/\n` +
					`then drop the redundant .br/.gz duplicates (the browser fetches the plain\n` +
					`files and decompresses them). Full per-file coverage lives in /verify.json.`
			);
			process.exit(1);
		}
		const out = outOverride ?? DEFAULT_RELEASE_OUT;
		await writeFile(out, JSON.stringify(obj, null, 2) + '\n', 'utf8');
		const hasCompressed = Object.keys(obj).some((k) => k.endsWith('.br') || k.endsWith('.gz'));
		console.log(
			`build-manifest: wrote ${count} entries (${bytes} bytes) to ${out}\n` +
				`  feed it to the release op:\n` +
				`  MORPHIT_BUILD_HASH_MANIFEST_FILE=${out} \\\n` +
				`    tsx apps/indexer/scripts/release-build-payload.ts > release.json\n` +
				`  NOTE: the whole on-chain payload (manifest + endpoints + treasury)\n` +
				`  must be UNDER 8192 bytes — Blurt's custom_json limit.` +
				(hasCompressed
					? `\n  This manifest still lists .br/.gz duplicates; the browser fetches\n` +
						`  the plain files and decompresses them, so those are redundant — strip\n` +
						`  them to reclaim ~2/3 of the byte budget if you're near the limit.`
					: '')
		);
		return;
	}

	const out = outOverride ?? DEFAULT_TEXT_OUT;
	await writeFile(out, renderSha256sumText(entries), 'utf8');
	console.log(`build-manifest: wrote ${entries.length} entries to ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
	main().catch((err) => {
		console.error('build-manifest: failed:', err);
		process.exit(1);
	});
}
