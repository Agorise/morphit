/**
 * service-perms-helper-smoke.
 *
 * Runs the REAL ops/scripts/morphit-service-perms.sh (what systemd runs as
 * root before the indexer and relay start) with bash on a scratch tree, with
 * real chgrp/chmod, and checks the resulting ownership — so the unprivileged
 * services can read their env files and the relay its keystore, and nothing
 * else ever changes:
 *  - a root-only env file in a root-only directory → root:<service group> 0640;
 *  - the relay keystore named by MORPHIT_RELAY_ACTIVE_KEY_FILE (quoted or not,
 *    `export` or not, last assignment wins) → root:<relay group> 0640;
 *  - a symlink, a file another user owns, a file in a directory another user
 *    owns or can write: left exactly as they are (no one can point root at
 *    another file);
 *  - a world-writable env file loses that bit;
 *  - nothing it reads is ever executed;
 *  - it always exits 0.
 * Needs root (it changes file groups). Uses the system groups `daemon` and
 * `adm` in place of morphit / morphit-relay.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

if (process.getuid?.() !== 0) {
	console.log('✗ service-perms-helper-smoke needs root (it changes file groups)');
	process.exit(1);
}
const gid = (name: string): number => {
	const r = spawnSync('getent', ['group', name], { encoding: 'utf8' });
	return Number(r.stdout.split(':')[2]);
};
const G_ENV = 'daemon';
const G_KEY = 'adm';
const HELPER =
	process.env.MORPHIT_PERMS_HELPER ?? join(REPO, 'ops/scripts/morphit-service-perms.sh');

const run = (root: string, role: string): number =>
	spawnSync('bash', [HELPER, role], {
		env: {
			...process.env,
			MORPHIT_PERMS_ROOT: root,
			MORPHIT_PERMS_GROUP: G_ENV,
			MORPHIT_PERMS_KEY_GROUP: G_KEY
		},
		encoding: 'utf8'
	}).status ?? -1;
const mode = (p: string): string => (statSync(p).mode & 0o7777).toString(8);
const owner = (p: string): string => `${statSync(p).uid}:${statSync(p).gid}`;

const fresh = (): string => {
	const root = mkdtempSync(join(tmpdir(), 'svcperms-'));
	chmodSync(root, 0o755);
	for (const d of ['opt/morphit', 'etc/morphit', 'secret'])
		mkdirSync(join(root, d), { recursive: true });
	chmodSync(join(root, 'etc/morphit'), 0o750);
	return root;
};
const put = (root: string, rel: string, body: string, m = 0o600): string => {
	const p = join(root, rel);
	writeFileSync(p, body);
	chmodSync(p, m);
	chownSync(p, 0, 0);
	return p;
};

// ── the indexer: its three env files ────────────────────────────────────
{
	const root = fresh();
	const a = put(root, 'opt/morphit/morphit.env', 'MORPHIT_INDEXER_DB_URL=postgres://x\n');
	const b = put(root, 'opt/morphit/morphit.config.env', 'MORPHIT_INSTANCE_NAME=My Market\n', 0o666);
	const c = put(root, 'etc/morphit/indexer.env', 'X=$(touch ' + join(root, 'PWNED') + ')\n');
	const status = run(root, 'indexer');
	check('exits 0', status === 0, `status ${status}`);
	for (const p of [a, b, c])
		check(
			`${p.slice(root.length)} → root:${G_ENV} 0640`,
			owner(p) === `0:${gid(G_ENV)}` && mode(p) === '640',
			`${owner(p)} ${mode(p)}`
		);
	check('never executes what it reads', !existsSync(join(root, 'PWNED')));
	rmSync(root, { recursive: true, force: true });
}

// ── the relay: env files + the keystore they name ───────────────────────
{
	const root = fresh();
	put(root, 'opt/morphit/morphit.env', `MORPHIT_RELAY_ACTIVE_KEY_FILE=/etc/morphit/old.keystore\n`);
	put(
		root,
		'etc/morphit/relay.env',
		`export MORPHIT_RELAY_ACTIVE_KEY_FILE="/etc/morphit/relay.keystore"\n`
	);
	const old = put(root, 'etc/morphit/old.keystore', '{}');
	const key = put(root, 'etc/morphit/relay.keystore', '{"cipher":"x"}');
	run(root, 'relay');
	check(
		'the keystore the LAST assignment names → root:<relay group> 0640',
		owner(key) === `0:${gid(G_KEY)}` && mode(key) === '640',
		`${owner(key)} ${mode(key)}`
	);
	check(
		'an earlier, overridden keystore path is not touched',
		owner(old) === '0:0' && mode(old) === '600'
	);
	rmSync(root, { recursive: true, force: true });
}

// ── what it must never touch ────────────────────────────────────────────
{
	const root = fresh();
	// a symlink pointing at a root-only file elsewhere
	const target = put(root, 'secret/shadow', 'x');
	symlinkSync(target, join(root, 'opt/morphit/morphit.env'));
	// a file another user owns
	const theirs = put(root, 'opt/morphit/morphit.config.env', 'A=1\n');
	chownSync(theirs, 4242, 4242);
	// a file in a directory another user can write
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	chmodSync(join(root, 'etc/morphit'), 0o770);
	const loose = put(root, 'etc/morphit/indexer.env', 'B=1\n');
	run(root, 'indexer');
	check(
		'a symlink is not followed (the target keeps root:root 0600)',
		owner(target) === '0:0' && mode(target) === '600'
	);
	check(
		'a file another user owns is left as it is',
		owner(theirs) === '4242:4242' && mode(theirs) === '600'
	);
	check(
		'a file in a directory others can write is left as it is',
		owner(loose) === '0:0' && mode(loose) === '600'
	);
	rmSync(root, { recursive: true, force: true });
}
{
	const root = fresh();
	// the relay keystore named in a directory another user owns
	mkdirSync(join(root, 'home/op'), { recursive: true });
	chownSync(join(root, 'home/op'), 4242, 4242);
	put(root, 'etc/morphit/relay.env', `MORPHIT_RELAY_ACTIVE_KEY_FILE=/home/op/k.json\n`);
	const k = put(root, 'home/op/k.json', '{}');
	const status = run(root, 'relay');
	check(
		'a keystore in another user’s directory is left as it is',
		owner(k) === '0:0' && mode(k) === '600'
	);
	check('still exits 0', status === 0);
	rmSync(root, { recursive: true, force: true });
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} service-perms-helper checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} service-perms-helper checks failed`);
process.exit(1);
