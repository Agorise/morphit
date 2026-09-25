#!/usr/bin/env tsx
/**
 * scripts/ipfs-release-hosting-smoke.ts  (v1.9.x, the maintainer)
 *
 * Every Morphit instance runs a small Kubo node that pins THIS instance's
 * current signed release, so releases stay available even if every commercial
 * pinning service drops them. ON by default (decentralization priority #2;
 * operators keep 90% of the listing fees). This pins the whole chain:
 *   - the indexer PERSISTS the distribution block (migration v53) and
 *     /v1/release exposes it, so a node can read its own release's ipfs_cid
 *   - the pin script reads /v1/release → ipfs_cid → `ipfs pin add` (by CID)
 *   - the Ansible role installs Kubo (verified) + the pinning service, is
 *     wired into the playbook, and is ON by default in group_vars
 *   - a manual-install setup script + a `morphit-ops harden` menu entry give
 *     hand-managed boxes the same thing
 *
 * Source greps strip // and block comments; YAML greps keep comments.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0,
	fail = 0;
const ok = (m: string) => (pass++, console.log(`  \u2713 ${m}`));
const bad = (m: string, d = '') => (fail++, console.log(`  \u2717 ${m}${d ? `\n      ${d}` : ''}`));
const raw = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const strip = (s: string) =>
	s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const src = (p: string) => strip(raw(p));

// ── 1. distribution is persisted + exposed ──────────────────────────
{
	const mig = raw('apps/indexer/src/db/migrations.ts');
	/version:\s*53/.test(mig) && /ADD COLUMN IF NOT EXISTS distribution JSONB/.test(mig)
		? ok('migration v53 adds releases.distribution')
		: bad('migration v53');
	/ADD COLUMN IF NOT EXISTS distribution JSONB/.test(raw('apps/indexer/src/db/schema.sql'))
		? ok('schema.sql carries the distribution column')
		: bad('schema.sql distribution column');

	const h = src('apps/indexer/src/indexer/handlers/release.ts');
	/distribution_serialized/.test(h) && /distribution\b/.test(h)
		? ok('handler serializes distribution')
		: bad('handler serializes distribution');
	/INSERT INTO releases[\s\S]*?distribution\b/.test(h) && /v\.distribution_serialized/.test(h)
		? ok('handler INSERT stores distribution')
		: bad('handler INSERT stores distribution');

	const api = src('apps/indexer/src/api/release.ts');
	/treasury,\s*distribution/.test(api) && /distribution:\s*r\.distribution/.test(api)
		? ok('/v1/release SELECTs + returns distribution')
		: bad('/v1/release exposes distribution');
}

// ── 2. the pin script ───────────────────────────────────────────────
{
	const p = raw('ops/ipfs/morphit-ipfs-pin.sh');
	const checks: Array<[string, boolean]> = [
		['POSIX sh', /^#!\/bin\/sh/.test(p)],
		['reads /v1/release', /MORPHIT_RELEASE_URL/.test(p) && /v1\/release/.test(p)],
		['extracts ipfs_cid', /ipfs_cid/.test(p)],
		['pins by CID', /ipfs .*pin add/.test(p)],
		['skips when already pinned', /pin ls --type=recursive/.test(p)],
		['non-fatal when the daemon is down', /daemon not reachable/.test(p) && /exit 0/.test(p)],
		['non-fatal when no ipfs (Kubo not installed)', /not installed.*skipping/.test(p)]
	];
	for (const [n, okp] of checks) okp ? ok(`pin script: ${n}`) : bad(`pin script: ${n}`);
}

// ── 3. the Ansible role ─────────────────────────────────────────────
{
	for (const f of [
		'ops/ansible/roles/ipfs/defaults/main.yml',
		'ops/ansible/roles/ipfs/tasks/main.yml',
		'ops/ansible/roles/ipfs/handlers/main.yml',
		'ops/ansible/roles/ipfs/templates/ipfs.service.j2',
		'ops/ansible/roles/ipfs/templates/morphit-ipfs-pin.service.j2',
		'ops/ansible/roles/ipfs/templates/morphit-ipfs-pin.timer.j2',
		'ops/ansible/roles/ipfs/templates/ipfs-pin.env.j2'
	]) {
		try {
			raw(f);
			ok(`role file present: ${f.split('/').slice(-2).join('/')}`);
		} catch {
			bad(`role file present: ${f}`);
		}
	}
	const tasks = raw('ops/ansible/roles/ipfs/tasks/main.yml');
	/dist\.ipfs\.tech|morphit_kubo_dist_base/.test(tasks) && /sha512/i.test(tasks)
		? ok('role downloads Kubo + verifies a checksum')
		: bad('role Kubo download + verify');
	/morphit-ipfs-pin\.timer/.test(tasks) && /state:\s*started/.test(tasks)
		? ok('role enables the pinning timer')
		: bad('role enables the timer');
	const daemon = raw('ops/ansible/roles/ipfs/templates/ipfs.service.j2');
	/ipfs daemon/.test(daemon) && /127\.0\.0\.1/.test(raw('ops/ansible/roles/ipfs/defaults/main.yml'))
		? ok('daemon unit + loopback-bound API/gateway (low exposure)')
		: bad('daemon unit / loopback bind');
}

// ── 4. default ON + wired into the playbook ─────────────────────────
{
	const gv = raw('ops/ansible/group_vars/all.yml');
	/enable_ipfs:\s*true/.test(gv) ? ok('enable_ipfs defaults to true (ON)') : bad('enable_ipfs default ON');
	const pb = raw('ops/ansible/playbook.yml');
	/role:\s*ipfs/.test(pb) && /when:\s*enable_ipfs \| default\(true\)/.test(pb)
		? ok('playbook runs the ipfs role (default true)')
		: bad('playbook wires the ipfs role');
}

// ── 5. manual-install path (setup script + harden menu) ─────────────
{
	const s = raw('ops/ipfs/morphit-ipfs-setup.sh');
	/^#!\/bin\/sh/.test(s) &&
	/ipfs init --profile lowpower/.test(s) &&
	/systemctl enable --now ipfs\.service/.test(s) &&
	/systemctl enable --now morphit-ipfs-pin\.timer/.test(s)
		? ok('setup script installs Kubo + enables daemon + pin timer')
		: bad('setup script completeness');
	/sha512sum/.test(s) ? ok('setup script verifies the Kubo checksum') : bad('setup script verify');

	const harden = src('apps/ops-cli/src/commands/harden.ts');
	/Set up IPFS release hosting/.test(harden) && /morphit-ipfs-setup\.sh/.test(harden)
		? ok('morphit-ops harden offers IPFS release hosting')
		: bad('harden menu IPFS entry');
}

void (async (): Promise<void> => {
// ── 5. the pin script, EXECUTED, finds the indexer (v1.18.0 review) ─
// Its default named port 8088, which no indexer listens on, and the setup
// script wrote that into /etc/morphit/ipfs-pin.env — so a hand-installed box
// could skip pinning on every run, exiting 0 with "will retry". Run for real,
// with a stub Kubo and a stub indexer: a configured URL that does not answer
// must fall through to the indexer's standard address and pin.
{
	const dir = mkdtempSync(resolve(tmpdir(), 'pin-'));
	const log = resolve(dir, 'ipfs.log');
	writeFileSync(
		resolve(dir, 'ipfs'),
		`#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *"pin ls"*) exit 1;; esac\nexit 0\n`
	);
	chmodSync(resolve(dir, 'ipfs'), 0o755);
	const srv = createServer((_q, r) => {
		const b = JSON.stringify({ version: '9.9.9', distribution: { ipfs_cid: 'bafyEXECUTEDCID' } });
		r.writeHead(200, { 'content-length': String(b.length) }).end(b);
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	const port = (srv.address() as { port: number }).port;
	const dead = createServer();
	await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
	const deadPort = (dead.address() as { port: number }).port;
	await new Promise<void>((r) => dead.close(() => r()));
	// ASYNC spawn: the stub indexer lives in THIS process, and a spawnSync
	// would block the very event loop that has to answer the script.
	const run = await new Promise<{ stderr: string }>((done) => {
		const child = spawn('sh', [resolve(ROOT, 'ops/ipfs/morphit-ipfs-pin.sh')], {
			env: {
				PATH: `${dir}:${process.env.PATH ?? ''}`,
				MORPHIT_RELEASE_URL: `http://127.0.0.1:${deadPort}/v1/release`,
				MORPHIT_RELEASE_URL_FALLBACKS: `http://127.0.0.1:${port}/v1/release`
			}
		});
		let stderr = '';
		child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
		const t = setTimeout(() => child.kill(), 60_000);
		child.on('close', () => {
			clearTimeout(t);
			done({ stderr });
		});
	});
	await new Promise<void>((r) => srv.close(() => r()));
	let calls = '';
	try {
		calls = readFileSync(log, 'utf8');
	} catch {
		/* no calls at all */
	}
	/pin add .*bafyEXECUTEDCID/.test(calls)
		? ok('pin script: a configured URL that does not answer falls through to the indexer, and pins')
		: bad('pin script did not reach the indexer through its fallback', (run.stderr ?? '').slice(0, 300));
	/did not answer; used http:\/\/127\.0\.0\.1:\d+/.test(run.stderr ?? '')
		? ok('pin script: and says which address worked, so the setting can be corrected')
		: bad('pin script: the fallback was silent');
	const scripts = ['ops/ipfs/morphit-ipfs-pin.sh', 'ops/ipfs/morphit-ipns-rebroadcast.sh', 'ops/ipfs/morphit-ipfs-setup.sh', 'ops/desktop/morphit-upgrade-notify.sh'];
	const stale = scripts.filter((f) => /:-8088\b/.test(raw(f)));
	stale.length === 0 && /127\.0\.0\.1:8081\/v1\/release/.test(raw('ops/ipfs/morphit-ipfs-pin.sh'))
		? ok('no local-indexer default names port 8088; the fallbacks include the indexer default 8081')
		: bad('a default still names port 8088', stale.join(', '));
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 ipfs-release-hosting smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 every instance pins the signed release: persisted CID + /v1/release, pin script, Kubo role (default ON), manual setup + harden');
console.log(`\u2713 all ${pass} ipfs-release-hosting scenarios passed`);
})();
