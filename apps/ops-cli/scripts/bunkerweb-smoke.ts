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
	BUNKERWEB_IMAGE,
	currentServerName,
	isPlaceholderServerName,
	validateServerName,
	setServerName,
	certPathsForServerName,
	setFrontendBuildPath,
	dockerInstallGuidance,
	planBunkerwebInstall,
	installDirFromEnv,
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

// ─── beta11: guided installer — PURE helpers ────────────────────────
{
	// currentServerName
	expect(
		'installer: currentServerName reads the value',
		currentServerName('# x\nSERVER_NAME=trade.example.org\nSERVER_TYPE=http\n') === 'trade.example.org'
	);
	expect('installer: currentServerName null when absent', currentServerName('no key') === null);

	// isPlaceholderServerName
	for (const ph of ['morphit.example.com', '', 'foo.example.net', 'x.example.org']) {
		expect(`installer: "${ph || '<empty>'}" is a placeholder`, isPlaceholderServerName(ph));
	}
	expect('installer: a real domain is not a placeholder', !isPlaceholderServerName('trade.agorise.net'));

	// validateServerName
	expect('installer: validate accepts a real hostname', validateServerName('trade.agorise.net').ok);
	expect('installer: validate accepts a short TLD host', validateServerName('x.io').ok);
	expect('installer: validate rejects a URL', !validateServerName('https://x.org').ok);
	expect('installer: validate rejects whitespace', !validateServerName('a b.com').ok);
	expect('installer: validate rejects no-dot', !validateServerName('localhost').ok);
	expect('installer: validate rejects the placeholder', !validateServerName('morphit.example.com').ok);
	expect('installer: validate rejects empty', !validateServerName('   ').ok);

	// setServerName: replace / idempotent / cert-line preserved / insert
	const envIn =
		'# header\nSERVER_NAME=morphit.example.com\nCUSTOM_SSL_CERT=/etc/letsencrypt/live/${SERVER_NAME}/fullchain.pem\n';
	const sset = setServerName(envIn, 'trade.agorise.net');
	expect(
		'installer: setServerName replaces the value (placeholder gone, cert ${SERVER_NAME} line preserved)',
		sset.changed &&
			sset.previous === 'morphit.example.com' &&
			sset.text.includes('SERVER_NAME=trade.agorise.net') &&
			!sset.text.includes('morphit.example.com') &&
			sset.text.includes('${SERVER_NAME}/fullchain.pem')
	);
	expect('installer: setServerName is idempotent', !setServerName(sset.text, 'trade.agorise.net').changed);
	const sins = setServerName('SOME=thing\n', 'trade.agorise.net');
	expect(
		'installer: setServerName inserts when the key is absent',
		sins.changed && sins.previous === null && sins.text.startsWith('SERVER_NAME=trade.agorise.net\n')
	);

	// certPathsForServerName
	const cp = certPathsForServerName('trade.agorise.net');
	expect(
		'installer: certPathsForServerName builds the letsencrypt live paths',
		cp.fullchain === '/etc/letsencrypt/live/trade.agorise.net/fullchain.pem' &&
			cp.privkey === '/etc/letsencrypt/live/trade.agorise.net/privkey.pem'
	);

	// setFrontendBuildPath: canonical no-op / custom rewrite / no-match no-op
	const compose = '  frontend:\n    volumes:\n      - /opt/morphit/apps/web/build:/usr/share/nginx/html:ro\n';
	expect('installer: setFrontendBuildPath no-op on the canonical /opt/morphit', !setFrontendBuildPath(compose, '/opt/morphit').changed);
	const fb = setFrontendBuildPath(compose, '/home/op/morphit');
	expect(
		'installer: setFrontendBuildPath rewrites the bind path for a custom install dir',
		fb.changed &&
			fb.text.includes('/home/op/morphit/apps/web/build:/usr/share/nginx/html:ro') &&
			!fb.text.includes('/opt/morphit/apps/web/build')
	);
	expect('installer: setFrontendBuildPath no-op when the bind line is absent', !setFrontendBuildPath('no bind', '/home/op/morphit').changed);

	// installDirFromEnv
	expect('installer: installDirFromEnv defaults to /opt/morphit', installDirFromEnv({}) === '/opt/morphit');
	expect('installer: installDirFromEnv trims an override', installDirFromEnv({ MORPHIT_INSTALL_DIR: '  /srv/m  ' }) === '/srv/m');

	// dockerInstallGuidance
	const g = dockerInstallGuidance();
	expect(
		'installer: dockerInstallGuidance gives an official apt route + a convenience script',
		g.official.length >= 2 &&
			g.official.some((l) => l.includes('apt-get install')) &&
			g.convenience.includes('get.docker.com') &&
			g.docs.startsWith('https://')
	);
}

// ─── beta11: install planner decision matrix ────────────────────────
{
	const already = planBunkerwebInstall({
		dockerPresent: true,
		composePresent: true,
		alreadyFullyRunning: true,
		configDirExists: true
	});
	expect(
		'planner: already-running → no install steps',
		already.alreadyRunning &&
			!already.needDocker &&
			!already.copyConfig &&
			!already.willBringUp
	);

	const fresh = planBunkerwebInstall({
		dockerPresent: false,
		composePresent: false,
		alreadyFullyRunning: false,
		configDirExists: false
	});
	expect(
		'planner: fresh host → install docker, copy config, set name, pull, up',
		!fresh.alreadyRunning &&
			fresh.needDocker &&
			fresh.copyConfig &&
			!fresh.reuseExistingConfig &&
			fresh.ensureServerName &&
			fresh.willPull &&
			fresh.willBringUp
	);

	const cfgExists = planBunkerwebInstall({
		dockerPresent: true,
		composePresent: true,
		alreadyFullyRunning: false,
		configDirExists: true
	});
	expect(
		'planner: existing /etc/bunkerweb is reused, never clobbered',
		!cfgExists.copyConfig && cfgExists.reuseExistingConfig
	);

	const noPlugin = planBunkerwebInstall({
		dockerPresent: true,
		composePresent: false,
		alreadyFullyRunning: false,
		configDirExists: false
	});
	expect('planner: docker without the compose plugin still needs the docker step', noPlugin.needDocker);
}

// ─── beta11: image-tag parity with the shipped compose ──────────────
{
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
	const compose = readFileSync(resolve(root, 'ops/bunkerweb/docker-compose.yml'), 'utf8');
	expect(
		`installer: BUNKERWEB_IMAGE (${BUNKERWEB_IMAGE}) matches the shipped compose pin`,
		compose.includes(BUNKERWEB_IMAGE),
		'the narrated image tag must match docker-compose.yml or operators see a wrong version'
	);
}

// ─── beta11: structural wiring assertions on bunkerweb.ts ───────────
{
	const src = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'bunkerweb.ts'),
		'utf8'
	);
	const want: Array<{ re: RegExp; desc: string }> = [
		{ re: /async function runBunkerwebInstaller\(/, desc: 'the guided installer orchestrator exists' },
		{
			re: /process\.stdin\.isTTY === true && ctx\.flags\.status !== 'true'/,
			desc: 'runBunkerWeb gates the installer on an interactive TTY (and a --status opt-out)'
		},
		{ re: /return await runBunkerwebInstaller\(/, desc: 'runBunkerWeb hands off to the installer when interactive + not running' },
		{ re: /planBunkerwebInstall\(\{/, desc: 'the installer derives its plan from planBunkerwebInstall' },
		{ re: /certPathsForServerName\(domain\)/, desc: 'the installer checks the cert path before bring-up' },
		{ re: /existsSync\(certs\.fullchain\)/, desc: 'the cert check is the crash-loop guard (existsSync on fullchain)' },
		{ re: /\['compose', '-f', composePath, 'up', '-d'\]/, desc: 'the installer runs docker compose up -d' },
		{ re: /\['compose', '-f', composePath, 'pull'\]/, desc: 'the installer pulls images first' },
		{ re: /if \(plan\.copyConfig\) \{/, desc: 'config is copied only when the plan says so (never clobbering existing)' },
		{ re: /realCmd = root \? cmd : 'sudo'/, desc: 'host-mutating commands run via sudo when not root' }
	];
	for (const w of want) {
		expect(`wiring: ${w.desc}`, w.re.test(src), `missing: ${w.desc}`);
	}

	// The old "read-only, never runs docker compose" promise must be gone
	// from the docblock — it would now be a lie (and a confusing one).
	expect(
		'wiring: stale "does NOT run docker compose" docblock claim removed',
		!/It does NOT run `docker compose` itself/.test(src),
		'the installer DOES run docker compose now; the old read-only claim must go'
	);
}


console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 bunkerweb smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} bunkerweb scenarios passed`);
