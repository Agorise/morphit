/**
 * assemble-install-smoke.ts (cp600) — pins the install runner's orchestration
 * invariants (assembleInstall) with mock deps: the real ansible-playbook/apt
 * spawn is Beelink territory, but the ORDER and SAFETY must hold — secrets
 * saved before the run, vars file always cleaned up (even on failure), correct
 * local argv, failures turned into a plain re-runnable message, and best-effort
 * post-install steps (the home desktop notifier) that run on success but can
 * never fail the install.
 */
import { assembleInstall, type InstallPlan, type AssembleDeps } from '../apps/ops-cli/src/init/assembleInstall.ts';
import { buildAnsibleVars, type AnsibleInstallInputs } from '../apps/ops-cli/src/init/ansibleVars.ts';
import type { SecretToSave } from '../apps/ops-cli/src/init/saveSecrets.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

const inputs: AnsibleInstallInputs = {
	mode: 'home',
	autoRegister: true,
	domain: 'trade.example.com',
	instanceName: 'Morphit Test',
	operatorAccount: 'my-operator',
	operatorTag: 'myoperator',
	feesAccount: 'my-operator',
	keystorePath: '/etc/morphit/relay.keystore',
	acmeEmail: 'me@example.com',
	indexerDbPassword: 'x'.repeat(43),
	relayDbPassword: 'y'.repeat(43),
	ddnsUpdateUrl: 'https://njal.la/update/?a={ip}'
};
const secrets: SecretToSave[] = [
	{ label: 'Database password (indexer)', value: inputs.indexerDbPassword },
	{ label: 'Database password (relay)', value: inputs.relayDbPassword }
];
const basePlan: InstallPlan = {
	vars: buildAnsibleVars(inputs),
	secretsToSave: secrets,
	playbookPath: '/opt/morphit/ops/ansible/playbook.yml',
	varsFilePath: '/run/morphit-install-vars.json'
};
const NOTIFY_ARGV = ['bash', '/opt/morphit/ops/desktop/morphit-upgrade-notify-setup.sh'];
const planWithPostInstall: InstallPlan = {
	...basePlan,
	postInstall: [{ label: 'desktop upgrade notifications', argv: NOTIFY_ARGV }]
};

interface Trace {
	events: string[];
	wrote?: { path: string; content: string };
	spawnedArgvs: (readonly string[])[];
	removed?: string;
	ensuredDir?: string;
	printed: string[];
}
function mockDeps(opts: { ensureOk?: boolean; exitCode?: number; postInstallExit?: number; hostCount?: number; trace: Trace }): AssembleDeps {
	const { trace } = opts;
	let spawnCount = 0;
	return {
		writeVarsFile: (path, content) => {
			trace.events.push('write');
			trace.wrote = { path, content };
		},
		promptSave: async (_s) => {
			trace.events.push('save');
		},
		ensureAnsible: async (dir: string) => {
			trace.events.push('ensure');
			trace.ensuredDir = dir;
			return opts.ensureOk ?? true;
		},
		spawn: async (argv) => {
			trace.events.push('spawn');
			trace.spawnedArgvs.push(argv);
			spawnCount += 1;
			// First spawn is the playbook; later spawns are post-install steps.
			return spawnCount === 1 ? (opts.exitCode ?? 0) : (opts.postInstallExit ?? 0);
		},
		removeVarsFile: (path) => {
			trace.events.push('remove');
			trace.removed = path;
		},
		print: (s: string) => {
			trace.printed.push(s);
		},
		// The pre-flight `--list-hosts` guard: default to "1 host found" so the
		// happy path proceeds. A dedicated check below drives this to 0 to prove
		// the guard aborts before any spawn (the host-pattern bug's backstop).
		probeHostCount: () => opts.hostCount ?? 1
	};
}
function newTrace(): Trace {
	return { events: [], spawnedArgvs: [], printed: [] };
}

async function main(): Promise<void> {
	console.log('\u2500\u2500 assemble-install smoke (cp600) \u2500\u2500\u2500\u2500\u2500\u2500');

	// Happy path (no post-install).
	{
		const trace = newTrace();
		const res = await assembleInstall(basePlan, mockDeps({ trace }));
		check('happy: returns ok', res.ok === true);
		check('happy: order is write -> save -> ensure -> spawn -> remove', trace.events.join(',') === 'write,save,ensure,spawn,remove');
		check('happy: secrets SAVED before the playbook SPAWN', trace.events.indexOf('save') < trace.events.indexOf('spawn'));
		check('happy: vars file written 0600-style with JSON containing the domain', !!trace.wrote && trace.wrote.path === '/run/morphit-install-vars.json' && trace.wrote.content.includes('trade.example.com'));
		check('happy: spawned the LOCAL playbook argv (localhost, -c local, -e @vars)', trace.spawnedArgvs.length === 1 && trace.spawnedArgvs[0].includes('localhost,') && trace.spawnedArgvs[0].includes('local') && trace.spawnedArgvs[0].includes('@/run/morphit-install-vars.json') && trace.spawnedArgvs[0].includes('/opt/morphit/ops/ansible/playbook.yml'));
		check('happy: vars file removed at the end (no lingering secrets)', trace.removed === '/run/morphit-install-vars.json');
		check('happy: ensureAnsible got the ansible dir (to find collections/requirements.yml)', trace.ensuredDir === '/opt/morphit/ops/ansible');
	}

	// Post-install runs on success.
	{
		const trace = newTrace();
		const res = await assembleInstall(planWithPostInstall, mockDeps({ trace }));
		check('post-install: returns ok', res.ok === true);
		check('post-install: the notifier ran AFTER the playbook (2nd spawn)', trace.spawnedArgvs.length === 2 && trace.spawnedArgvs[1].join(' ') === NOTIFY_ARGV.join(' '));
		check('post-install: still cleaned up the vars file', trace.removed === '/run/morphit-install-vars.json');
	}

	// Post-install failure is best-effort (never fails the install).
	{
		const trace = newTrace();
		const res = await assembleInstall(planWithPostInstall, mockDeps({ trace, postInstallExit: 2 }));
		check('post-install fail: install STILL ok (notifier failure is not fatal)', res.ok === true);
		check('post-install fail: printed a "do it later" fallback with the command', trace.printed.some((s) => /couldn\u2019t set up/.test(s)) && trace.printed.some((s) => s.includes('morphit-upgrade-notify-setup.sh')));
	}

	// Ansible missing.
	{
		const trace = newTrace();
		const res = await assembleInstall(basePlan, mockDeps({ ensureOk: false, trace }));
		check('no-ansible: returns failure with an actionable reason', res.ok === false && /apt-get install -y ansible/.test((res as { reason: string }).reason));
		check('no-ansible: did NOT spawn the playbook', !trace.events.includes('spawn'));
		check('no-ansible: STILL removed the vars file (cleanup on early return)', trace.events.includes('remove'));
	}

	// Playbook fails (non-zero exit) → post-install must NOT run.
	{
		const trace = newTrace();
		const res = await assembleInstall(planWithPostInstall, mockDeps({ exitCode: 2, trace }));
		check('fail: returns failure mentioning the exit code + that a re-run is safe', res.ok === false && /exit code 2/.test((res as { reason: string }).reason) && /run this again/.test((res as { reason: string }).reason));
		check('fail: post-install did NOT run (only the playbook spawned)', trace.spawnedArgvs.length === 1);
		check('fail: STILL removed the vars file (cleanup in finally)', trace.removed === '/run/morphit-install-vars.json');
	}

	// promptSave throws → cleanup must still happen.
	{
		const trace = newTrace();
		const deps: AssembleDeps = { ...mockDeps({ trace }), promptSave: async () => { throw new Error('interrupted'); } };
		let threw = false;
		try {
			await assembleInstall(basePlan, deps);
		} catch {
			threw = true;
		}
		check('interrupted-save: propagates + STILL removed the vars file (finally)', threw && trace.events.includes('remove') && !trace.events.includes('spawn'));
	}

	// Pre-flight host guard: if the play would match 0 hosts, abort BEFORE the
	// playbook spawn with a clear reason. This is the backstop for the
	// host-pattern bug that once let the play no-op silently and still report
	// success. (The probe needs Ansible present, so it runs after ensureAnsible.)
	{
		const trace = newTrace();
		const res = await assembleInstall(basePlan, mockDeps({ hostCount: 0, trace }));
		check('0-host guard: returns failure mentioning 0 hosts / installer bug', res.ok === false && /0 hosts|no machine|host/i.test((res as { reason: string }).reason));
		check('0-host guard: did NOT spawn the playbook', !trace.events.includes('spawn'));
		check('0-host guard: STILL removed the vars file (cleanup in finally)', trace.removed === '/run/morphit-install-vars.json');
	}
}

main()
	.then(() => {
		console.log('');
		if (failed === 0) {
			console.log(`\u2713 all ${passed} assemble-install checks passed`);
			process.exit(0);
		} else {
			console.log(`\u2717 ${failed} of ${passed + failed} assemble-install checks failed`);
			process.exit(1);
		}
	})
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
