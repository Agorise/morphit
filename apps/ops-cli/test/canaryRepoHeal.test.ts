/**
 * The weekly canary refresh runs the installed release's canary code
 * (lib/canaryRepoHeal.ts). morphitlat, 2026-10-07: the system timer's refresh
 * (/root/.morphit/update-canary.sh) had REPO pointing at ~/Downloads/morphit,
 * the copy the wizard ran setup.sh from; its old code fetched the chain head
 * from clearnet nodes the zero-clearnet box no longer reaches, and every weekly
 * run failed. Driven with real files (and a real gpg keyring) in a scratch
 * directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	healCanaryRefreshRepo,
	isCurrentFormRefresh,
	parseCanaryUnit,
	realCanaryRepoRuntime,
	refreshScriptRepo,
	repointRefreshScript,
	type CanaryRepoRuntime
} from '../src/lib/canaryRepoHeal.ts';

let S = '';
let rootHome = '';
let homes = '';
let install = '';
let unit = '';
let started = 0;
let rt: CanaryRepoRuntime;

/** An OLD-form refresh script (signs into $REPO/apps/web/static). */
const OLD = (repo: string, key = '2D158A336BD2C4D1AA4036E263B7FA5875D3C7F9', extra = ''): string =>
	[
		'#!/usr/bin/env bash',
		'set -euo pipefail',
		`export MORPHIT_CANARY_PGP_KEY_ID='${key}'`,
		"export MORPHIT_CANARY_OPERATOR_NAME='Libertad Latina'",
		"export MORPHIT_CANARY_INSTANCE_ORIGIN='http://ws7btkya.onion'",
		"export MORPHIT_CANARY_OPERATOR_ACCOUNT='morphitlat'",
		`REPO='${repo}'`,
		'cd "$REPO"',
		'bash scripts/canary/generate.sh',
		'install -m 0644 "$REPO/apps/web/static/canary.txt" /opt/morphit/apps/web/build/',
		'install -m 0644 "$REPO/apps/web/static/pgp_keys.asc" /opt/morphit/apps/web/build/',
		extra
	].join('\n');
/** setup.sh's current local form (signs into its staging folder). */
const CURRENT = (repo: string): string =>
	[
		'#!/usr/bin/env bash',
		'set -euo pipefail',
		"export MORPHIT_CANARY_PGP_KEY_ID='2D158A336BD2C4D1AA4036E263B7FA5875D3C7F9'",
		"export MORPHIT_CANARY_INSTANCE_ORIGIN='http://ws7btkya.onion'",
		`REPO='${repo}'`,
		"SERVE='/opt/morphit/apps/web/build'",
		"STAGE='/root/.morphit/canary'",
		'cd "$REPO"',
		'export MORPHIT_CANARY_OUT="$STAGE/canary.txt"',
		'bash scripts/canary/generate.sh',
		'install -m 0644 "$STAGE/pgp_keys.asc" "$SERVE/pgp_keys.asc"',
		''
	].join('\n');
const UNIT = (exec: string, user: string | null = 'root'): string =>
	`[Unit]\nDescription=Refresh the Morphit warrant canary\n\n[Service]\nType=oneshot\n${user === null ? '' : `User=${user}\n`}ExecStart=${exec}\n`;

beforeEach(() => {
	S = mkdtempSync(join(tmpdir(), 'canary-repo-'));
	rootHome = join(S, 'root');
	homes = join(S, 'home');
	install = join(S, 'opt', 'morphit');
	unit = join(S, 'morphit-canary.service');
	mkdirSync(join(rootHome, '.morphit'), { recursive: true });
	mkdirSync(homes, { recursive: true });
	mkdirSync(join(install, 'scripts', 'canary'), { recursive: true });
	writeFileSync(join(install, 'scripts', 'canary', 'generate.sh'), '#!/bin/sh\n');
	started = 0;
	const real = realCanaryRepoRuntime(rootHome, { systemUnit: unit, homes });
	rt = {
		...real,
		// The test runs as an ordinary user: "owned by root" means owned by us.
		ownerUid: (p) => {
			const u = real.ownerUid(p);
			return u !== null && u === (process.getuid?.() ?? 0) ? 0 : u;
		},
		startRefresh: () => {
			started++;
			return true;
		}
	};
});
afterEach(() => rmSync(S, { recursive: true, force: true }));

const run = () => healCanaryRefreshRepo(install, rt, { rootHome });
const rootScript = (): string => join(rootHome, '.morphit', 'update-canary.sh');

/** A real signing key in root's keyring (the old-form rewrite exports it). */
function makeRootKey(): string {
	const home = join(rootHome, '.gnupg');
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const gpg = (args: string[]) =>
		spawnSync(
			'gpg',
			['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
			{ encoding: 'utf8' }
		);
	expect(
		gpg(['--quick-gen-key', 'Canary <c@example.invalid>', 'ed25519', 'sign', 'never']).status
	).toBe(0);
	return /^fpr:+([0-9A-F]{40}):/m.exec(gpg(['--with-colons', '--list-keys']).stdout)?.[1] ?? '';
}

describe('the canary refresh-source heal', () => {
	it("current form: root's weekly refresh gets REPO = the install, nothing else changes, and it renews now", () => {
		writeFileSync(rootScript(), CURRENT('/home/op/Downloads/morphit'));
		chmodSync(rootScript(), 0o755);
		writeFileSync(unit, UNIT(rootScript()));
		const r = run();
		expect(r.strategy, r.detail).toBe('applied');
		expect(r.verified).toBe(true);
		expect(readFileSync(rootScript(), 'utf8')).toBe(CURRENT(install));
		expect(statSync(rootScript()).mode & 0o777).toBe(0o755); // still executable
		expect(started).toBe(1);
		expect(r.detail).toMatch(/renewing the canary now/);
	});

	it('old form (morphitlat): rewritten in the current form, same values, key exported from root’s keyring', () => {
		const fpr = makeRootKey();
		writeFileSync(rootScript(), OLD('/home/op/Downloads/morphit', fpr));
		chmodSync(rootScript(), 0o755);
		writeFileSync(unit, UNIT(rootScript()));
		const r = run();
		expect(r.strategy, r.detail).toBe('applied');
		const after = readFileSync(rootScript(), 'utf8');
		expect(isCurrentFormRefresh(after)).toBe(true);
		expect(refreshScriptRepo(after)).toBe(install);
		expect(after).toContain(`export MORPHIT_CANARY_PGP_KEY_ID='${fpr}'`);
		expect(after).toContain("export MORPHIT_CANARY_OPERATOR_NAME='Libertad Latina'");
		expect(after).toContain("export MORPHIT_CANARY_INSTANCE_ORIGIN='http://ws7btkya.onion'");
		expect(after).toContain("export MORPHIT_CANARY_OPERATOR_ACCOUNT='morphitlat'");
		expect(after).not.toMatch(/\$REPO\/apps\/web\/static/);
		const pub = readFileSync(join(rootHome, '.morphit', 'canary', 'pgp_keys.asc'), 'utf8');
		expect(pub).toContain('BEGIN PGP PUBLIC KEY BLOCK');
		expect(rt.fingerprints(pub)).toContain(fpr);
		expect(spawnSync('bash', ['-n', rootScript()]).status).toBe(0);
		expect(started).toBe(1);
	});

	it('old form that named its served folder keeps it', () => {
		const fpr = makeRootKey();
		writeFileSync(rootScript(), OLD('/old', fpr, "SERVE='/var/www/morphit-frontend'"));
		writeFileSync(unit, UNIT(rootScript()));
		expect(run().strategy).toBe('applied');
		expect(readFileSync(rootScript(), 'utf8')).toContain("SERVE='/var/www/morphit-frontend'");
	});

	it('old form whose key is not in root’s keyring: nothing is written', () => {
		const before = OLD('/home/op/Downloads/morphit', 'DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF');
		writeFileSync(rootScript(), before);
		writeFileSync(unit, UNIT(rootScript()));
		const r = run();
		expect(r.strategy).toBe('failed');
		expect(readFileSync(rootScript(), 'utf8')).toBe(before);
		expect(started).toBe(0);
	});

	it('old form that uploads elsewhere (scp) is left alone, with the setup command', () => {
		const before = OLD('/home/op/Downloads/morphit', undefined, 'scp -O "$SIGNED" host:/x');
		writeFileSync(rootScript(), before);
		writeFileSync(unit, UNIT(rootScript()));
		const r = run();
		expect(r.strategy).toBe('left-alone');
		expect(r.detail).toContain(`sudo bash ${install}/scripts/canary/setup.sh`);
		expect(readFileSync(rootScript(), 'utf8')).toBe(before);
	});

	it('is quiet when REPO already names the install', () => {
		writeFileSync(rootScript(), CURRENT(install));
		writeFileSync(unit, UNIT(rootScript()));
		const r = run();
		expect(r.strategy).toBe('already');
		expect(r.routine).toBe(true);
		expect(started).toBe(0);
	});

	it('another account’s script is never written; current form → the sed command, old form → the setup command', () => {
		const home = join(homes, 'op', '.morphit');
		mkdirSync(home, { recursive: true });
		const script = join(home, 'update-canary.sh');
		writeFileSync(script, CURRENT('/home/op/Downloads/morphit'));
		writeFileSync(unit, UNIT(script, 'op'));
		let r = run();
		expect(r.strategy).toBe('left-alone');
		expect(r.detail).toContain(`as op: sed -i "s#^REPO=.*#REPO='${install}'#"`);
		expect(refreshScriptRepo(readFileSync(script, 'utf8'))).toBe('/home/op/Downloads/morphit');
		// The old form must NOT get the sed (it would break it): setup instead.
		writeFileSync(script, OLD('/home/op/Downloads/morphit'));
		r = run();
		expect(r.strategy).toBe('left-alone');
		expect(r.detail).not.toMatch(/sed -i/);
		expect(r.detail).toContain(
			`as op, run the canary setup again: bash ${install}/scripts/canary/setup.sh`
		);
	});

	it('a user unit in an account’s home is reported the same way, never written', () => {
		const unitDir = join(homes, 'op', '.config', 'systemd', 'user');
		mkdirSync(unitDir, { recursive: true });
		const script = join(homes, 'op', '.morphit', 'update-canary.sh');
		mkdirSync(join(homes, 'op', '.morphit'), { recursive: true });
		writeFileSync(script, OLD('/home/op/Downloads/morphit'));
		writeFileSync(join(unitDir, 'morphit-canary.service'), UNIT(script, null));
		const r = run();
		expect(r.strategy).toBe('left-alone');
		expect(r.detail).toContain('as op, run the canary setup again');
		expect(readFileSync(script, 'utf8')).toBe(OLD('/home/op/Downloads/morphit'));
	});

	it('a path that only LOOKS like it is under /root (/root/../elsewhere) is not written', () => {
		mkdirSync(join(S, 'elsewhere'), { recursive: true });
		const outside = join(S, 'elsewhere', 'update-canary.sh');
		writeFileSync(outside, CURRENT('/old'));
		writeFileSync(unit, UNIT(`${rootHome}/../elsewhere/update-canary.sh`));
		const r = run();
		expect(r.strategy).toBe('left-alone');
		expect(readFileSync(outside, 'utf8')).toBe(CURRENT('/old'));
	});

	it('does not follow a link planted at the script path', () => {
		const target = join(S, 'victim');
		writeFileSync(target, CURRENT('/elsewhere'));
		symlinkSync(target, rootScript());
		writeFileSync(unit, UNIT(rootScript()));
		run();
		expect(readFileSync(target, 'utf8')).toBe(CURRENT('/elsewhere'));
	});

	it('a drop-in that overrides ExecStart is the one used', () => {
		const other = join(rootHome, '.morphit', 'other.sh');
		writeFileSync(other, CURRENT('/old'));
		writeFileSync(rootScript(), CURRENT(install));
		writeFileSync(unit, UNIT(rootScript()));
		mkdirSync(`${unit}.d`);
		writeFileSync(`${unit}.d/override.conf`, `[Service]\nExecStart=\nExecStart=${other}\n`);
		expect(run().strategy).toBe('applied');
		expect(refreshScriptRepo(readFileSync(other, 'utf8'))).toBe(install);
	});

	it('changes nothing when the install holds no canary code, or there is no unit', () => {
		writeFileSync(rootScript(), CURRENT('/old'));
		writeFileSync(unit, UNIT(rootScript()));
		rmSync(join(install, 'scripts'), { recursive: true });
		expect(run().strategy).toBe('skipped');
		rmSync(unit);
		expect(run().strategy).toBe('skipped');
		expect(refreshScriptRepo(readFileSync(rootScript(), 'utf8'))).toBe('/old');
		expect(existsSync(join(rootHome, '.morphit', 'canary'))).toBe(false);
	});
});

describe('the parsers', () => {
	it('reads ExecStart (with a systemd prefix, a shell, a drop-in) and User', () => {
		expect(parseCanaryUnit(UNIT('-/root/.morphit/update-canary.sh --x'))).toEqual({
			execStart: '/root/.morphit/update-canary.sh',
			user: 'root'
		});
		expect(parseCanaryUnit(UNIT('/bin/bash -e /root/.morphit/update-canary.sh')).execStart).toBe(
			'/root/.morphit/update-canary.sh'
		);
		expect(parseCanaryUnit('[Service]\nExecStart=/a/b.sh\n').user).toBeNull();
		// An empty User= does not swallow the next line.
		expect(parseCanaryUnit('[Service]\nUser=\nExecStart=/a/b.sh\n')).toEqual({
			execStart: '/a/b.sh',
			user: null
		});
	});
	it('repoints only the REPO line', () => {
		expect(repointRefreshScript(CURRENT('/x'), '/opt/morphit')).toBe(CURRENT('/opt/morphit'));
		expect(repointRefreshScript('#!/bin/sh\necho hi\n', '/opt/morphit')).toBeNull();
	});
});
