/**
 * The weekly warrant-canary refresh must run the INSTALLED release's canary
 * code, not a copy left wherever it was first set up.
 *
 * `scripts/canary/setup.sh` wrote the refresh script (`~/.morphit/
 * update-canary.sh`) with `REPO='<the tree setup.sh ran from>'`. The install
 * wizard runs it from the unpacked source (~/Downloads/morphit), so on such a
 * box the weekly refresh kept running that copy's canary code forever, while
 * upgrades only ever replace /opt/morphit. morphitlat (2026-10-07): the system
 * timer's refresh ran an old copy that fetched the chain head straight from
 * clearnet nodes; since v1.21.0 that zero-clearnet box lets only Tor and I2P
 * out, so every weekly run failed, and the canary would have gone stale and
 * shown visitors a false tamper warning. (setup.sh now records the deployed
 * tree; this heal repairs refresh scripts written before that.)
 *
 * The heal looks at every canary unit on the box — the system unit, root's
 * user unit and each account's user unit — and for a refresh script whose
 * REPO is not the install dir:
 *  - CURRENT form (signs into ~/.morphit/canary via MORPHIT_CANARY_OUT and
 *    takes the public key from there): REPO is pointed at the install dir —
 *    the script reads nothing else from REPO.
 *  - OLD form (signs into $REPO/apps/web/static and copies the public key from
 *    there): pointing REPO elsewhere would break it (the installed release has
 *    no apps/web/static/pgp_keys.asc — morphitlat's first fix attempt stopped
 *    exactly there). It is rewritten in the current local form with the same
 *    key, operator, origin, account and served folder; the public key is
 *    exported once from root's keyring into root's staging folder and checked
 *    to be the signing key. An old form that uploads elsewhere (scp) is left
 *    alone, with the setup command.
 * Only a script that runs as root, lives under /root (which only root can
 * change) and is owned by root is written, and never through a link. Any other
 * refresh script is the operator's account's: the heal names the command to
 * run as that account. Every write is read back. After a repair of the system
 * unit's script the canary is renewed in the background with it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { HealResult } from './healTypes.ts';
import { ensureOwnDir, readNoFollow, writeNoFollow } from './noFollowFs.ts';

export const SYSTEM_CANARY_UNIT = '/etc/systemd/system/morphit-canary.service';

/** Shells a unit may run the refresh script through (`ExecStart=/bin/bash X`). */
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh']);

/** The parts of a canary unit file the heal needs. PURE. A later `ExecStart=`
 *  or `User=` (a drop-in appended after the unit) wins, as in systemd. */
export function parseCanaryUnit(text: string): { execStart: string | null; user: string | null } {
	const all = (key: string): string[] =>
		[...text.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'gm'))].map(
			(m) => m[1] ?? ''
		);
	const execs = all('ExecStart');
	const exec = execs.length > 0 ? execs[execs.length - 1]! : '';
	const users = all('User');
	const user = users.length > 0 ? users[users.length - 1]! : '';
	// ExecStart may carry systemd prefixes (-, @, +, !); the script is the first
	// word, or the first non-option word after a shell.
	const words = exec
		.replace(/^[-@+!:]+/, '')
		.split(/\s+/)
		.filter((w) => w !== '');
	let script: string | null = words[0] ?? null;
	if (script !== null && SHELLS.has(basename(script))) {
		script = words.slice(1).find((w) => !w.startsWith('-')) ?? null;
	}
	return { execStart: script, user: user === '' ? null : user };
}

/** The tree a refresh script runs the canary code from (its REPO='…' line), or
 *  null when it has none. PURE. */
export function refreshScriptRepo(text: string): string | null {
	const m = /^REPO=(['"]?)(.+?)\1[ \t]*$/m.exec(text);
	return m ? m[2]! : null;
}

/** The refresh script with REPO pointed at `installDir`; null when there is no
 *  REPO line. Nothing else in the script changes. PURE. */
export function repointRefreshScript(text: string, installDir: string): string | null {
	if (refreshScriptRepo(text) === null) return null;
	return text.replace(/^REPO=.*$/m, `REPO='${installDir}'`);
}

/** A refresh script in the current form signs into its staging folder. PURE. */
export function isCurrentFormRefresh(text: string): boolean {
	return /^export MORPHIT_CANARY_OUT=/m.test(text);
}

/** `export NAME='value'` (or `NAME='value'`) from a refresh script, quotes
 *  removed; null when absent or empty. PURE. */
export function refreshScriptValue(text: string, name: string): string | null {
	const m = new RegExp(`^(?:export[ \\t]+)?${name}=(['"]?)(.*?)\\1[ \\t]*$`, 'm').exec(text);
	return m && m[2] !== '' ? m[2]! : null;
}

export interface RefreshValues {
	readonly keyId: string;
	readonly operatorName: string;
	readonly origin: string;
	readonly account: string;
	readonly repo: string;
	readonly serve: string;
	readonly stage: string;
}

/** The refresh script in setup.sh's current LOCAL form. PURE. */
export function currentFormRefreshScript(v: RefreshValues): string {
	const q = (x: string): string => `'${x}'`;
	return [
		'#!/usr/bin/env bash',
		'# Auto-generated by scripts/canary/setup.sh — refreshes the Morphit warrant canary.',
		"# (Rewritten by morphit-ops upgrade: the installed release's canary code, signed into root's staging folder.)",
		'set -euo pipefail',
		`export MORPHIT_CANARY_PGP_KEY_ID=${q(v.keyId)}`,
		`export MORPHIT_CANARY_OPERATOR_NAME=${q(v.operatorName)}`,
		`export MORPHIT_CANARY_INSTANCE_ORIGIN=${q(v.origin)}`,
		`export MORPHIT_CANARY_OPERATOR_ACCOUNT=${q(v.account)}`,
		`REPO=${q(v.repo)}`,
		`SERVE=${q(v.serve)}`,
		`STAGE=${q(v.stage)}`,
		'cd "$REPO"',
		'export MORPHIT_CANARY_OUT="$STAGE/canary.txt"',
		'bash scripts/canary/generate.sh',
		'SIGNED="$STAGE/canary.txt"',
		'PUBKEY="$STAGE/pgp_keys.asc"',
		'DEST="$SERVE"',
		'mkdir -p "$DEST"',
		'install -m 0644 "$SIGNED" "$DEST/canary.txt"',
		'install -m 0644 "$PUBKEY" "$DEST/pgp_keys.asc"',
		'echo "canary: placed in $DEST/ (served at /canary.txt)"',
		''
	].join('\n');
}

/** One canary unit: the system one, or an account's user unit. */
export interface CanaryUnitRef {
	readonly path: string;
	readonly scope: 'system' | 'user';
	/** For a user unit: the account whose manager runs it. */
	readonly account?: string;
}

export interface CanaryRepoRuntime {
	/** The canary units on this box. */
	listUnits(): CanaryUnitRef[];
	/** A unit's effective text (with any drop-ins), or null when absent. */
	readUnit(ref: CanaryUnitRef): string | null;
	/** The refresh script, never read through a link; null when absent. */
	readScript(path: string): string | null;
	/** The uid that owns the script (not following a link), or null. */
	ownerUid(path: string): number | null;
	/** Replace it in place (same mode), never through a link. */
	writeScript(path: string, text: string): void;
	exists(path: string): boolean;
	/** Root's ASCII-armored public key for `keyId` from root's keyring, or null. */
	exportPublicKey(keyId: string): string | null;
	/** The fingerprints an armored key block holds (upper-case hex). */
	fingerprints(armored: string): string[];
	/** Write a file in root's own staging folder (created 0700, root's). */
	writeStaged(dir: string, name: string, text: string): void;
	/** Start the system canary unit without waiting for it; true when queued. */
	startRefresh(): boolean;
}

/** The box's files: read and written without following a link at the last
 *  component; an existing script keeps its mode (O_TRUNC, not a new file). */
export function realCanaryRepoRuntime(
	rootHome = '/root',
	paths: { readonly systemUnit?: string; readonly homes?: string } = {}
): CanaryRepoRuntime {
	const gpgHome = join(rootHome, '.gnupg');
	const systemUnit = paths.systemUnit ?? SYSTEM_CANARY_UNIT;
	const homes = paths.homes ?? '/home';
	const userUnit = (home: string): string =>
		join(home, '.config', 'systemd', 'user', 'morphit-canary.service');
	return {
		listUnits: () => {
			const out: CanaryUnitRef[] = [{ path: systemUnit, scope: 'system' }];
			out.push({ path: userUnit(rootHome), scope: 'user', account: 'root' });
			try {
				for (const name of readdirSync(homes)) {
					out.push({ path: userUnit(join(homes, name)), scope: 'user', account: name });
				}
			} catch {
				/* no /home: only the system and root units */
			}
			return out;
		},
		readUnit: (ref) => {
			const file = readNoFollow(ref.path);
			if (file === null) return null;
			// Drop-ins override the unit (ExecStart=, User=): append them in name
			// order so the parser's "last one wins" matches systemd.
			const dropDir = `${ref.path}.d`;
			let extra = '';
			try {
				for (const f of readdirSync(dropDir)
					.filter((n) => n.endsWith('.conf'))
					.sort()) {
					const t = readNoFollow(join(dropDir, f));
					if (t !== null) extra += `\n${t}`;
				}
			} catch {
				/* no drop-ins */
			}
			return file + extra;
		},
		readScript: (p) => readNoFollow(p),
		ownerUid: (p) => {
			try {
				return lstatSync(p).uid;
			} catch {
				return null;
			}
		},
		writeScript: (p, text) => writeNoFollow(p, text, 0o700),
		exists: (p) => existsSync(p),
		exportPublicKey: (keyId) => {
			const r = spawnSync('gpg', ['--homedir', gpgHome, '--batch', '--armor', '--export', keyId], {
				encoding: 'utf8',
				timeout: 30_000
			});
			return r.status === 0 && /BEGIN PGP PUBLIC KEY BLOCK/.test(r.stdout ?? '') ? r.stdout : null;
		},
		fingerprints: (armored) => {
			const r = spawnSync('gpg', ['--batch', '--with-colons', '--show-keys'], {
				input: armored,
				encoding: 'utf8',
				timeout: 30_000
			});
			return (r.stdout ?? '')
				.split('\n')
				.filter((l) => l.startsWith('fpr:'))
				.map((l) => (l.split(':')[9] ?? '').toUpperCase())
				.filter((f) => f !== '');
		},
		writeStaged: (dir, name, text) => {
			ensureOwnDir(join(dir, '..'), 0o700);
			ensureOwnDir(dir, 0o700);
			writeNoFollow(join(dir, name), text, 0o644);
		},
		startRefresh: () =>
			spawnSync('systemctl', ['start', '--no-block', 'morphit-canary.service'], {
				stdio: 'ignore',
				timeout: 15_000
			}).status === 0
	};
}

const ROUTINE = (strategy: string): HealResult => ({
	strategy,
	verified: true,
	detail: '',
	routine: true
});

function healOne(
	ref: CanaryUnitRef,
	installDir: string,
	rt: CanaryRepoRuntime,
	rootHome: string
): HealResult {
	const unit = rt.readUnit(ref);
	if (unit === null) return ROUTINE('skipped'); // no such canary unit
	const { execStart, user } = parseCanaryUnit(unit);
	if (execStart === null) return ROUTINE('skipped');
	const script = rt.readScript(execStart);
	if (script === null) return ROUTINE('skipped');
	const repo = refreshScriptRepo(script);
	const install = installDir.replace(/\/+$/, '');
	if (repo === null || repo.replace(/\/+$/, '') === install) return ROUTINE('already');
	if (!rt.exists(join(install, 'scripts', 'canary', 'generate.sh'))) {
		return ROUTINE('skipped'); // nothing better to point it at
	}
	const runsAs =
		ref.scope === 'user' ? (ref.account ?? null) : user === null || user === '0' ? 'root' : user;
	const resolved = resolve(execStart);
	const writable =
		runsAs === 'root' && resolved.startsWith(`${rootHome}/`) && rt.ownerUid(resolved) === 0;
	const current = isCurrentFormRefresh(script);
	const runAs = runsAs === null ? 'its owner' : runsAs;
	const sudo = runAs === 'root' ? 'sudo ' : '';
	const setupCmd = `${sudo}bash ${install}/scripts/canary/setup.sh`;
	const sedCmd = `${sudo}sed -i "s#^REPO=.*#REPO='${install}'#" ${resolved}`;
	const adviceFor = (text: string): string =>
		isCurrentFormRefresh(text)
			? `On this server, as ${runAs}: ${sedCmd}`
			: `On this server, as ${runAs}, run the canary setup again: ${setupCmd}`;
	if (!writable) {
		return {
			strategy: 'left-alone',
			verified: false,
			detail:
				`Warrant canary: the weekly refresh (${resolved}) runs the canary code from ${repo}, an old copy; ` +
				`upgrades only update ${install}. ${adviceFor(script)}`
		};
	}
	const fix = (why: string): string =>
		`Warrant canary: ${why} The weekly refresh (${resolved}) still runs the old copy in ${repo}. ` +
		`On this server, as root, run the canary setup again: ${setupCmd}`;
	let next: string | null;
	if (current) {
		next = repointRefreshScript(script, install);
		if (next === null) return ROUTINE('already');
	} else {
		if (/\bscp\b/.test(script)) {
			return {
				strategy: 'left-alone',
				verified: false,
				detail: fix('the weekly refresh is an old one that uploads the canary to another server.')
			};
		}
		const keyId = refreshScriptValue(script, 'MORPHIT_CANARY_PGP_KEY_ID');
		const operatorName = refreshScriptValue(script, 'MORPHIT_CANARY_OPERATOR_NAME');
		const origin = refreshScriptValue(script, 'MORPHIT_CANARY_INSTANCE_ORIGIN');
		const account = refreshScriptValue(script, 'MORPHIT_CANARY_OPERATOR_ACCOUNT');
		const oldServe = refreshScriptValue(script, 'SERVE');
		if (
			!keyId ||
			!/^[0-9A-Fa-f]{8,40}$/.test(keyId) ||
			!operatorName ||
			!origin ||
			!account ||
			/['\n$`\\]/.test(operatorName + origin + account)
		) {
			return {
				strategy: 'left-alone',
				verified: false,
				detail: fix('the old refresh script lacks a value to rewrite it from.')
			};
		}
		const armored = rt.exportPublicKey(keyId);
		const want = keyId.toUpperCase();
		if (armored === null || !rt.fingerprints(armored).some((f) => f.endsWith(want))) {
			return {
				strategy: 'failed',
				verified: false,
				detail: fix(`could not export public key ${keyId} from root's keyring.`)
			};
		}
		const stage = join(rootHome, '.morphit', 'canary');
		try {
			rt.writeStaged(stage, 'pgp_keys.asc', armored);
		} catch (e) {
			return {
				strategy: 'failed',
				verified: false,
				detail: fix(
					`could not save the public key in ${stage} (${e instanceof Error ? e.message : String(e)}).`
				)
			};
		}
		next = currentFormRefreshScript({
			keyId,
			operatorName,
			origin,
			account,
			repo: install,
			// The old script's own served folder, when it named one literally.
			serve:
				oldServe !== null && /^\/[^'$`\\\s]*$/.test(oldServe)
					? oldServe
					: join(install, 'apps', 'web', 'build'),
			stage
		});
	}
	try {
		rt.writeScript(resolved, next);
	} catch (e) {
		return {
			strategy: 'failed',
			verified: false,
			detail:
				`Warrant canary: could not repair the weekly refresh (${resolved}) ` +
				`(${e instanceof Error ? e.message : String(e)}). It still runs the old copy in ${repo}. ${adviceFor(script)}`
		};
	}
	const back = rt.readScript(resolved);
	const ok =
		back !== null &&
		refreshScriptRepo(back) === install &&
		isCurrentFormRefresh(back) &&
		(current || rt.exists(join(rootHome, '.morphit', 'canary', 'pgp_keys.asc')));
	if (!ok) {
		return {
			strategy: 'failed',
			verified: false,
			detail: `Warrant canary: wrote ${resolved}, but reading it back does not show the change. On this server: sudo cat ${resolved}`
		};
	}
	const renewing = ref.scope === 'system' && rt.startRefresh();
	return {
		strategy: 'applied',
		verified: true,
		detail:
			`Warrant canary: the weekly refresh now runs the installed release's canary code (${install}), not the old copy in ${repo} (read back).` +
			(renewing
				? ' It is renewing the canary now, in the background; to see how it went, on this server: sudo systemctl status morphit-canary.service'
				: '')
	};
}

export function healCanaryRefreshRepo(
	installDir: string,
	rt: CanaryRepoRuntime,
	opts: { readonly rootHome?: string } = {}
): HealResult {
	const rootHome = (opts.rootHome ?? '/root').replace(/\/+$/, '');
	const results = rt.listUnits().map((ref) => healOne(ref, installDir, rt, rootHome));
	const shown = results.filter((r) => !r.routine);
	if (shown.length === 0) {
		return ROUTINE(results.some((r) => r.strategy === 'already') ? 'already' : 'skipped');
	}
	const worst =
		shown.find((r) => r.strategy === 'failed') ??
		shown.find((r) => r.strategy === 'left-alone') ??
		shown[0]!;
	return {
		strategy: worst.strategy,
		verified: shown.every((r) => r.verified),
		detail: shown.map((r) => r.detail).join('\n')
	};
}
