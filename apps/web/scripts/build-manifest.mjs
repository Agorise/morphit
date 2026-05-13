#!/usr/bin/env node
/**
 * apps/web/scripts/build-manifest.mjs
 *
 * Walk apps/web/build/ recursively and emit a sorted SHA-256
 * manifest of every emitted file.  The manifest is the
 * deterministic fingerprint of "what bytes did we just ship":
 * an operator running `morphit_release_v1` can broadcast it
 * on-chain so users with a local clone can verify they're
 * loading the same bytes the operator built.
 *
 * Output format (one line per file, sorted by path):
 *   <hex sha-256>  ./<relative-path-from-build-dir>
 *
 * Same shape as `find . -type f | sort | xargs sha256sum`,
 * which is exactly what the CI workflow does inline (see
 * .forgejo/workflows/ci.yml).  This standalone script gives
 * operators the same output without needing the CI environment.
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
 *
 * Output:
 *   apps/web/build-manifest.sha256
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '..');
const BUILD_DIR = join(WEB_ROOT, 'build');
const OUT_FILE = join(WEB_ROOT, 'build-manifest.sha256');

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

async function sha256(path) {
	const buf = await readFile(path);
	return createHash('sha256').update(buf).digest('hex');
}

async function main() {
	let buildExists;
	try {
		buildExists = (await stat(BUILD_DIR)).isDirectory();
	} catch {
		buildExists = false;
	}
	if (!buildExists) {
		console.error(
			`build-manifest: ${BUILD_DIR} does not exist — run \`npm run build -w apps/web\` first.`
		);
		process.exit(1);
	}

	const entries = [];
	for await (const path of walk(BUILD_DIR)) {
		const rel = relative(BUILD_DIR, path).split('\\').join('/');
		const hash = await sha256(path);
		entries.push({ rel, hash });
	}
	// Stable sort by path — locale-independent (codepoint compare).
	entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

	const lines = entries.map((e) => `${e.hash}  ./${e.rel}`);
	const out = lines.join('\n') + '\n';
	await writeFile(OUT_FILE, out, 'utf8');
	console.log(`build-manifest: wrote ${entries.length} entries to ${OUT_FILE}`);
}

main().catch((err) => {
	console.error('build-manifest: failed:', err);
	process.exit(1);
});
