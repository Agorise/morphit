/**
 * Keep npm's "New major version of npm available! … To update run: npm install
 * -g npm@…" notice off an operator's screen — for good.
 *
 * npm prints it when the npm/npx process that STARTED a command exits: for the
 * `morphit-ops` launcher (`npm exec … morphit-ops`) or `npx morphit-ops`, that is
 * after the whole install or upgrade, where nothing morphit-ops sets in its own
 * environment can reach it. Following the advice is harmful (the install pins
 * its own Node and npm). Three layers keep it off:
 *   1. the repo's `.npmrc` — any npm whose working directory is in the install;
 *   2. the launcher / morphit-setup.sh export the setting to their npm;
 *   3. this module writes it to the box's GLOBAL npmrc, so every npm on the box
 *      (any directory, any user) is covered — called by every upgrade and by the
 *      installer (a manual install never ran the Ansible task that does the
 *      same).
 *
 * WHY NOT `npm config set --location=global`: npm chmods the global npmrc to
 * 0666 after saving (@npmcli/config save()), world-writable — any local account
 * could then add `script-shell=` or `node-options=` and run code as root the
 * next time root uses npm (verified in the v1.19.0 deep-deep). So the file is
 * edited here directly and left root-owned 0644, and an existing 0666 file (every
 * Ansible install, and anyone who ran `npm config set --location=global`) is
 * repaired.
 */

import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	statSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { atomicWrite } from './branding.ts';

export const NPM_QUIET_SETTINGS: ReadonlyArray<readonly [string, string]> = [
	['update-notifier', 'false'],
	['fund', 'false']
];

/** Set `key=value` lines in npmrc text; returns the new text (unchanged if already set). */
export function withNpmrcSettings(
	text: string,
	settings: ReadonlyArray<readonly [string, string]>
): string {
	let out = text;
	for (const [key, want] of settings) {
		const re = new RegExp(`^[ \\t]*${key.replace(/[-]/g, '\\-')}[ \\t]*=.*$`, 'gm');
		if (re.test(out)) {
			out = out.replace(re, `${key}=${want}`);
		} else {
			if (out.length > 0 && !out.endsWith('\n')) out += '\n';
			out += `${key}=${want}\n`;
		}
	}
	return out;
}

/**
 * npmrc keys that make npm RUN CODE, or repoint where it reads its config. If
 * the global npmrc was ever group/other-writable (npm's own `npm config set
 * --location=global` leaves it 0666), a local account could have added one of
 * these, and the next time ROOT runs npm — the very `npm ci` this upgrade runs —
 * it would execute their code as root (review B8). When we find the file was
 * insecure, we strip these before repairing the mode, so a planted line can
 * never fire. Ordinary quiet settings and benign operator config are kept.
 */
export const DANGEROUS_NPMRC_KEYS: readonly string[] = [
	'script-shell',
	'shell',
	'node-options',
	'globalconfig',
	'userconfig',
	'prefix',
	'cache',
	'init-module',
	'onload-script',
	'ignore-scripts', // an operator's `true` is fine, but a planted `false` re-enables lifecycle scripts
	'unsafe-perm'
];

/** Remove any npmrc line whose key is in `keys` (case-insensitive, tolerating
 *  `export`/whitespace/quotes). Returns {text, removed}. PURE. */
export function stripNpmrcKeys(
	text: string,
	keys: readonly string[]
): { text: string; removed: string[] } {
	const removed: string[] = [];
	const out: string[] = [];
	const lowerKeys = new Set(keys.map((k) => k.toLowerCase()));
	for (const line of text.split('\n')) {
		const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z0-9_.-]+)[ \t]*=/.exec(line);
		if (m && lowerKeys.has((m[1] ?? '').toLowerCase())) {
			removed.push(m[1]!);
			continue;
		}
		out.push(line);
	}
	return { text: out.join('\n'), removed };
}

export interface NpmrcResult {
	readonly path: string;
	readonly changed: boolean;
	readonly permsFixed: boolean;
	/** Code-execution keys stripped because the file had been left writable by
	 *  non-root (tamper vector). Empty on a normal, secure file. */
	readonly strippedKeys: string[];
}

/**
 * Ensure the npmrc at `path` carries the quiet settings and is root-owned
 * 0644. Refuses to follow a symbolic link. If the file was group/other-writable
 * (a tamper vector), any code-execution key is stripped first. Returns what it
 * did.
 */
export function ensureQuietNpmrc(path: string): NpmrcResult {
	if (!isAbsolute(path)) throw new Error(`not an absolute path: ${path}`);
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
		throw new Error(`${path} is a symbolic link — refusing to write through it`);
	}
	const existed = existsSync(path);
	// Was it writable by anyone but the owner BEFORE we repair the mode? If so, a
	// local account could have planted a code-execution key while it was 0666.
	const wasInsecure = existed && (lstatSync(path).mode & 0o022) !== 0;
	const before = existed ? readFileSync(path, 'utf8') : '';
	let strippedKeys: string[] = [];
	let base = before;
	if (wasInsecure) {
		const s = stripNpmrcKeys(before, DANGEROUS_NPMRC_KEYS);
		base = s.text;
		strippedKeys = s.removed;
	}
	const after = withNpmrcSettings(base, NPM_QUIET_SETTINGS);
	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	let changed = false;
	if (after !== before || !existed) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
		atomicWrite(path, after, 0o644);
		changed = true;
	}
	const st = statSync(path);
	let permsFixed = false;
	if ((st.mode & 0o777) !== 0o644) {
		chmodSync(path, 0o644);
		permsFixed = true;
	}
	if (asRoot && (st.uid !== 0 || st.gid !== 0)) {
		chownSync(path, 0, 0);
		permsFixed = true;
	}
	return { path, changed, permsFixed, strippedKeys };
}

/** The global npmrc path of the box's npm, or null if npm can't say. */
export function globalNpmrcPath(): string | null {
	const env = { ...process.env };
	for (const k of Object.keys(env)) if (/^npm_config_/i.test(k)) delete env[k];
	const r = spawnSync('npm', ['config', 'get', 'globalconfig'], {
		encoding: 'utf8',
		env,
		cwd: '/', // a deleted working directory would crash npm (uv_cwd)
		timeout: 60_000
	});
	const p = (r.stdout ?? '').trim();
	return r.status === 0 && isAbsolute(p) ? p : null;
}

/**
 * Quiet npm box-wide (global npmrc) and repair its permissions. Root only
 * (the global npmrc is root's to write); a no-op otherwise, and under tests
 * that relocate the env files (MORPHIT_ENV_ROOT). Never throws.
 */
export function healNpmUpdateNotice(): NpmrcResult | null {
	if ((process.env.MORPHIT_ENV_ROOT ?? '') !== '') return null;
	if (typeof process.getuid === 'function' && process.getuid() !== 0) return null;
	try {
		const p = globalNpmrcPath();
		return p === null ? null : ensureQuietNpmrc(p);
	} catch {
		return null;
	}
}
