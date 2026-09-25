/**
 * ops-bridge-scripts-smoke (v1.18.0 review, O11).
 *
 * `ops/apply-relay-fix.sh` and `ops/apply-federation-fix.sh` were one-off
 * bridges: each patched the installed indexer source on a live box to carry a
 * fix until the release that contained it shipped, then restarted the indexer.
 * Both fixes have long since shipped, and both scripts still travel in every
 * release, in /opt/morphit/ops. Run on today's code:
 *
 *   - apply-relay-fix.sh replaced `relayProbeCandidates` wholesale with its old
 *     body, silently dropping the rule added since that keeps a hidden-only
 *     node from looking its relay's public name up — then restarted the
 *     indexer on the reverted code;
 *   - apply-federation-fix.sh found no anchor, reported success anyway, and
 *     restarted the indexer.
 *
 * This EXECUTES both against a copy of the current source, with systemctl,
 * psql and sleep stubbed, and asserts: exit 0, source untouched, no restart.
 *
 * To watch it fail on the old scripts:
 *   MORPHIT_OPS_BRIDGE_DIR=<old>/ops npx tsx scripts/ops-bridge-scripts-smoke.ts
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPS = process.env.MORPHIT_OPS_BRIDGE_DIR ?? join(REPO, 'ops');

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

const work = mkdtempSync(join(tmpdir(), 'morphit-bridge-'));
try {
	const bin = join(work, 'bin');
	mkdirSync(bin);
	const calls = join(work, 'calls.log');
	const stub = (name: string, body: string): void => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub('systemctl', `echo "systemctl $*" >> "${calls}"`);
	// A HEALTHY box — the case an operator is in when they run an old script
	// "just in case": the relay is up and the peer probes good, so the old
	// scripts judged their patch proven and KEPT it.
	stub('psql', `echo "psql" >> "${calls}"; echo good`);
	stub('sleep', 'exit 0');
	stub('curl', `echo "curl $*" >> "${calls}"; echo '{"relay":{"up":true}}'`);
	stub('id', 'echo 0'); // the scripts demand root; the stubs make that moot

	const cases: Array<{ script: string; rel: string }> = [
		{ script: 'apply-relay-fix.sh', rel: 'src/api/operationalHealth.ts' },
		{ script: 'apply-federation-fix.sh', rel: 'src/indexer/federationProbe.ts' }
	];
	for (const { script, rel } of cases) {
		const idx = join(work, `indexer-${script}`);
		mkdirSync(join(idx, dirname(rel)), { recursive: true });
		const target = join(idx, rel);
		copyFileSync(join(REPO, 'apps/indexer', rel), target);
		const before = readFileSync(target, 'utf8');
		rmSync(calls, { force: true });
		const r = spawnSync('bash', [join(OPS, script)], {
			encoding: 'utf8',
			timeout: 60_000,
			env: {
				PATH: `${bin}:/usr/bin:/bin`,
				HOME: work,
				IDXDIR: idx,
				MORPHIT_INDEXER_DATABASE_URL: 'postgres://stub/stub'
			}
		});
		const after = readFileSync(target, 'utf8');
		const log = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
		check(
			`${script}: exits 0 on a release that already carries its fix`,
			r.status === 0,
			`exit ${r.status}`
		);
		check(`${script}: leaves the installed source exactly as it was`, after === before);
		check(
			`${script}: does not restart the indexer`,
			!log.includes('systemctl'),
			log.trim().split('\n')[0]
		);
		check(
			`${script}: says the fix is already installed`,
			(r.stdout ?? '').includes('already part of the installed release'),
			(r.stdout ?? '').trim().split('\n').slice(-1)[0]
		);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

console.log(
	fail === 0
		? `\n✓ all ${pass} ops-bridge-scripts checks passed`
		: `\n✗ ops-bridge-scripts: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
