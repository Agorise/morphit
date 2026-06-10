/**
 * bunkerweb-smoke (beta5 item H).
 *
 * Unit-tests the PURE cores of `morphit-ops bunkerweb`: docker-inspect
 * state parsing, the overall health verdict (docker-missing /
 * not-running / partial / unhealthy / running), and the bring-up
 * command builder. The actual `docker inspect` I/O runs on a real box
 * with Docker and is not exercised here.
 */

import {
	parseContainerState,
	bunkerwebVerdict,
	bunkerwebCommands,
	BUNKERWEB_CONTAINERS,
	type ContainerState
} from '../src/commands/bunkerweb.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, detail = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (detail) console.log(`      ${detail}`);
};
const expect = (n: string, c: boolean, d = '') => (c ? ok(n) : bad(n, d));

const st = (name: string, present: boolean, status: string, health: string): ContainerState => ({
	name,
	present,
	status,
	health
});

// parseContainerState
{
	const a = parseContainerState('bunkerweb', 'running|healthy\n');
	expect('parse: running|healthy', a.present && a.status === 'running' && a.health === 'healthy');
	const b = parseContainerState('bunkerweb', 'running|none');
	expect('parse: running|none (no healthcheck)', b.present && b.status === 'running' && b.health === 'none');
	const c = parseContainerState('bunkerweb', '');
	expect('parse: empty → absent', !c.present && c.status === 'absent');
}

// bunkerwebVerdict
expect('verdict: docker missing', bunkerwebVerdict(false, []).kind === 'docker-missing');

expect(
	'verdict: no containers → not-running',
	bunkerwebVerdict(true, BUNKERWEB_CONTAINERS.map((n) => st(n, false, 'absent', 'none'))).kind === 'not-running'
);

expect(
	'verdict: one missing → partial',
	bunkerwebVerdict(true, [st('bunkerweb', true, 'running', 'healthy'), st('bunkerweb-scheduler', false, 'absent', 'none')]).kind === 'partial'
);

expect(
	'verdict: present but exited → partial',
	bunkerwebVerdict(true, [st('bunkerweb', true, 'exited', 'none'), st('bunkerweb-scheduler', true, 'running', 'none')]).kind === 'partial'
);

expect(
	'verdict: running but unhealthy → unhealthy',
	bunkerwebVerdict(true, [st('bunkerweb', true, 'running', 'unhealthy'), st('bunkerweb-scheduler', true, 'running', 'none')]).kind === 'unhealthy'
);

expect(
	'verdict: all running healthy → running',
	bunkerwebVerdict(true, [st('bunkerweb', true, 'running', 'healthy'), st('bunkerweb-scheduler', true, 'running', 'none')]).kind === 'running'
);

expect(
	'verdict: running, health still starting → running (re-check)',
	bunkerwebVerdict(true, [st('bunkerweb', true, 'running', 'starting'), st('bunkerweb-scheduler', true, 'running', 'none')]).kind === 'running'
);

// bunkerwebCommands
{
	const cmds = bunkerwebCommands();
	expect('commands: bring-up uses docker compose up -d', cmds.bringUp.some((l) => l.includes('docker compose up -d')));
	expect('commands: bring-up copies shipped config', cmds.bringUp.some((l) => l.includes('cp -r ops/bunkerweb /etc/bunkerweb')));
	expect('commands: logs targets bunkerweb', cmds.logs.includes('docker compose logs') && cmds.logs.includes('bunkerweb'));
	expect('commands: down present', cmds.down.includes('docker compose down'));
}

// ─── cp231: shipped-config SPA/PWA safety + example↔ansible parity ──
// The cp231 incident: /v1/ was rate-limited at 60r/m (1 r/s), tighter
// than a normal page-load burst of /v1/* calls, so legitimate browsing
// produced 429s that bad-behavior counted into an hour-long, self-
// feeding IP ban. These assertions pin the fix: the edge rate must stay
// well above the indexer's own limits, and the bad-behavior counted set
// must never re-include the codes that trap real users (403 = also the
// ban's own response → self-perpetuating; 429 = rate-limit burst;
// 404 = normal PWA/SPA probing). Both the standalone env and the
// ansible template must agree, or a deploy via one path silently
// reintroduces the bug.
{
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
	const envExample = readFileSync(resolve(root, 'ops/bunkerweb/bunkerweb.env.example'), 'utf8');
	const ansible = readFileSync(
		resolve(root, 'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'),
		'utf8'
	);
	const get = (content: string, key: string): string | null => {
		const m = content.match(new RegExp('^' + key + '=(.*)$', 'm'));
		return m ? m[1].trim() : null;
	};
	// "1800r/m" / "30r/s" → requests per minute
	const toPerMin = (v: string | null): number => {
		if (!v) return NaN;
		const m = v.match(/^(\d+)r\/([ms])$/);
		if (!m) return NaN;
		const n = Number(m[1]);
		return m[2] === 's' ? n * 60 : n;
	};
	// INDEXER_SINGLE_RECORD_LIMIT_RPM — the most generous app-level /v1/
	// limit (single-record lookups). The WAF edge ceiling must exceed it.
	const APP_V1_CEILING_RPM = 600;

	for (const [label, content] of [
		['env.example', envExample],
		['ansible.j2', ansible]
	] as const) {
		const v1 = toPerMin(get(content, 'LIMIT_REQ_RATE_1'));
		expect(
			`${label}: /v1/ edge rate (${v1} r/m) is above the app's own ${APP_V1_CEILING_RPM} r/m ceiling`,
			Number.isFinite(v1) && v1 > APP_V1_CEILING_RPM,
			`LIMIT_REQ_RATE_1 must parse and exceed ${APP_V1_CEILING_RPM} r/m (got ${v1})`
		);
		const codesRaw = get(content, 'BAD_BEHAVIOR_STATUS_CODES');
		const codes = (codesRaw ?? '').split(/\s+/).filter(Boolean);
		expect(`${label}: BAD_BEHAVIOR_STATUS_CODES is set`, codes.length > 0, 'must be set explicitly');
		for (const banned of ['403', '404', '429']) {
			expect(
				`${label}: bad-behavior does NOT count ${banned}`,
				!codes.includes(banned),
				`counting ${banned} re-introduces the self-feeding / burst ban (got: ${codesRaw})`
			);
		}
	}

	// example ↔ ansible parity on the security-critical knobs
	for (const key of ['LIMIT_REQ_RATE_1', 'LIMIT_REQ_RATE_2', 'BAD_BEHAVIOR_STATUS_CODES']) {
		expect(
			`example↔ansible agree on ${key}`,
			get(envExample, key) === get(ansible, key),
			`drift: example=${get(envExample, key)} ansible=${get(ansible, key)}`
		);
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 bunkerweb smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} bunkerweb scenarios passed`);
