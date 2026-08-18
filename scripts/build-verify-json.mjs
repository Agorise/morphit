#!/usr/bin/env node
/**
 * Morphit — /verify.json builder (postbuild).
 *
 * Writes apps/web/build/verify.json after vite build has
 * finished. The file contains:
 *
 *   - schema_version  — integer, bumps on breaking shape changes
 *   - morphit_version — semver from package.json
 *   - git_commit      — full sha from `git rev-parse HEAD`; on a tarball
 *                       deployment (no .git) falls back to MORPHIT_GIT_COMMIT
 *                       then to the commit baked into the tarball's
 *                       release-info.json; null only if none is available
 *   - operator_tag    — MORPHIT_INSTANCE_OPERATOR_TAG (env, or read from
 *                       morphit.config.env at the install root), or the legacy
 *                       MORPHIT_OPERATOR_TAG; null for instances that declare
 *                       no operator tag
 *   - built_at        — ISO-8601 timestamp of this build
 *   - hash_manifest   — map of build-relative path → sha256 hex
 *                       for every file in build/ (excluding
 *                       verify.json itself). Purpose: a user or
 *                       watchdog compares this map to what the
 *                       @morphit release-op on chain publishes;
 *                       any mismatch means the instance is
 *                       serving a tampered bundle.
 *
 * Item 1 of docs/OPERATOR-TRUST-DESIGN.md.
 *
 * Design notes:
 *   - Relative paths, forward-slashes, no leading slash. Portable
 *     across whatever host serves the output.
 *   - Sorted map by path so two identical builds produce
 *     byte-identical verify.json (bit-for-bit reproducibility
 *     matters for the "compare to release-op" workflow).
 *   - We skip verify.json itself — you can't hash a file whose
 *     contents depend on the hash of other files, including
 *     itself. A separate manifest signature covers integrity of
 *     verify.json via the release-op's top-level signature.
 *   - No external dependencies. Standard Node only, so the
 *     script runs even if `npm install` partially failed on the
 *     CI runner.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const WEB_DIR = resolve(REPO_ROOT, 'apps/web');
const BUILD_DIR = resolve(WEB_DIR, 'build');
const OUT_PATH = resolve(BUILD_DIR, 'verify.json');

/** Current schema version. Bump on breaking shape changes to
 *  the verify.json structure. */
const SCHEMA_VERSION = 1;

/** Walk a directory recursively and return all file paths. */
function walkFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...walkFiles(full));
		} else if (st.isFile()) {
			out.push(full);
		}
	}
	return out;
}

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

function readMorphitVersion() {
	try {
		const pkg = JSON.parse(
			readFileSync(resolve(WEB_DIR, 'package.json'), 'utf8')
		);
		return typeof pkg.version === 'string' ? pkg.version : 'unknown';
	} catch {
		return 'unknown';
	}
}

/** The release pipeline bakes release-info.json (tag + full source commit +
 *  build time) into every release tarball, at the install root. On a tarball
 *  deployment there is no .git, so this is where the real source commit lives —
 *  read it as the authoritative fallback so verify.json's git_commit is
 *  populated on a normally-deployed instance instead of showing blank. */
function readReleaseInfoCommit() {
	try {
		const info = JSON.parse(readFileSync(resolve(REPO_ROOT, 'release-info.json'), 'utf8'));
		const c = typeof info.commit === 'string' ? info.commit.trim() : '';
		if (/^[0-9a-fA-F]{7,64}$/.test(c)) return c;
	} catch {
		// No release-info.json (dev checkout, or a non-release tarball).
	}
	return null;
}

function readGitCommit() {
	try {
		return execSync('git rev-parse HEAD', {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'pipe', 'ignore']
		})
			.toString()
			.trim();
	} catch {
		// Not a git checkout (e.g. running in a release tarball).
		// Prefer an explicitly-injected MORPHIT_GIT_COMMIT, else the
		// commit baked into the tarball's release-info.json, else null.
		const raw = process.env.MORPHIT_GIT_COMMIT;
		if (raw && /^[0-9a-fA-F]{7,64}$/.test(raw.trim())) {
			return raw.trim();
		}
		return readReleaseInfoCommit();
	}
}

/** Read a KEY=value from the SAME set of env files the running services source
 *  (see morphit-indexer.service ExecStart), in the same order, so verify.json's
 *  operator_tag matches what /v1/instance reports. Later files override earlier
 *  ones (shell `. file` semantics). All are present on a deployed instance and
 *  absent in a dev checkout; a manual /opt/morphit layout may keep the operator
 *  tag in any of them. Strips surrounding quotes. */
function readConfigEnvValue(key) {
	const files = [
		resolve(REPO_ROOT, 'morphit.env'),
		resolve(REPO_ROOT, 'morphit.config.env'),
		'/etc/morphit/indexer.env'
	];
	let found = null;
	for (const file of files) {
		let txt;
		try {
			txt = readFileSync(file, 'utf8');
		} catch {
			continue; // file absent (dev checkout, or this layout doesn't use it)
		}
		for (const line of txt.split('\n')) {
			const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
			if (m && m[1] === key) {
				let v = m[2].trim();
				if (
					(v.startsWith('"') && v.endsWith('"')) ||
					(v.startsWith("'") && v.endsWith("'"))
				) {
					v = v.slice(1, -1);
				}
				if (v.length > 0) found = v; // last non-empty wins (override order)
			}
		}
	}
	return found;
}

function readOperatorTag() {
	// The canonical config variable is MORPHIT_INSTANCE_OPERATOR_TAG (set in
	// morphit.config.env / indexer.env). The frontend build run by
	// `morphit-ops upgrade` does not source that env, so also read it straight
	// from morphit.config.env at the install root. MORPHIT_OPERATOR_TAG is
	// accepted as a legacy/explicit override. null → an instance that hasn't
	// declared an operator tag.
	const raw =
		process.env.MORPHIT_INSTANCE_OPERATOR_TAG ??
		process.env.MORPHIT_OPERATOR_TAG ??
		readConfigEnvValue('MORPHIT_INSTANCE_OPERATOR_TAG');
	if (!raw) return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	// Same validation as the frontend's nostrUrl policy — max
	// 64 chars, alphanumeric + dash + dot. Reject anything
	// weirder; we don't want operator_tag becoming an injection
	// vector into the JSON.
	if (!/^[a-zA-Z0-9.\-_]{1,64}$/.test(trimmed)) {
		console.warn(
			`[verify-json] operator tag '${trimmed}' fails shape check; emitting null`
		);
		return null;
	}
	return trimmed;
}

/** Compute hash_manifest: sorted map of relative path → sha256. */
function buildHashManifest() {
	if (!existsSync(BUILD_DIR)) {
		throw new Error(
			`build directory not found at ${BUILD_DIR} — did vite build run? ` +
				`This script is a postbuild step; run \`npm run build\` instead of ` +
				`invoking it directly.`
		);
	}
	if (!statSync(BUILD_DIR).isDirectory()) {
		throw new Error(`${BUILD_DIR} exists but is not a directory`);
	}
	const manifest = {};
	for (const abs of walkFiles(BUILD_DIR)) {
		const rel = relative(BUILD_DIR, abs).split('\\').join('/');
		// Skip verify.json itself (it can't hash its own content) and the .shipped
		// build marker — the marker is a build-system signal, not a served asset, and
		// hashing it would make an instance's manifest differ by deploy path (a box
		// that re-ran the manifest step would list it; one that kept the shipped
		// manifest wouldn't). Excluding it keeps every instance's manifest identical.
		if (rel === 'verify.json' || rel === '.shipped') continue;
		const buf = readFileSync(abs);
		manifest[rel] = sha256Hex(buf);
	}
	// Sorted output for bit-reproducibility.
	const sorted = {};
	for (const k of Object.keys(manifest).sort()) {
		sorted[k] = manifest[k];
	}
	return sorted;
}

function main() {
	// Honor SOURCE_DATE_EPOCH for reproducible-build workflows.
	// When set, verify.json is bit-for-bit identical across
	// rebuilds of the same source, which is what a watchdog
	// reproducing a pinned release wants. Unset in normal dev,
	// we use wall-clock time.
	// https://reproducible-builds.org/docs/source-date-epoch/
	const sde = process.env.SOURCE_DATE_EPOCH;
	let builtAt;
	if (sde && /^\d+$/.test(sde)) {
		builtAt = new Date(parseInt(sde, 10) * 1000).toISOString();
	} else {
		builtAt = new Date().toISOString();
	}

	const payload = {
		schema_version: SCHEMA_VERSION,
		morphit_version: readMorphitVersion(),
		git_commit: readGitCommit(),
		operator_tag: readOperatorTag(),
		built_at: builtAt,
		hash_manifest: buildHashManifest()
	};
	writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
	const count = Object.keys(payload.hash_manifest).length;
	console.log(
		`[verify-json] wrote ${OUT_PATH} ` +
			`(version=${payload.morphit_version}, ` +
			`commit=${payload.git_commit ? payload.git_commit.slice(0, 7) : 'none'}, ` +
			`operator=${payload.operator_tag ?? 'null'}, ` +
			`${count} files hashed)`
	);
}

main();
