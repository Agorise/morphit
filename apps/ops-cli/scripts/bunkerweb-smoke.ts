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

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 bunkerweb smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} bunkerweb scenarios passed`);
