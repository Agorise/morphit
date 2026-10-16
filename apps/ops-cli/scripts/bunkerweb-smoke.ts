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
	expect(
		'parse: running|none (no healthcheck)',
		b.present && b.status === 'running' && b.health === 'none'
	);
	const c = parseContainerState('bunkerweb', '');
	expect('parse: empty → absent', !c.present && c.status === 'absent');
}

// bunkerwebVerdict
expect('verdict: docker missing', bunkerwebVerdict(false, []).kind === 'docker-missing');

expect(
	'verdict: no containers → not-running',
	bunkerwebVerdict(
		true,
		BUNKERWEB_CONTAINERS.map((n) => st(n, false, 'absent', 'none'))
	).kind === 'not-running'
);

expect(
	'verdict: one missing → partial',
	bunkerwebVerdict(true, [
		st('bunkerweb', true, 'running', 'healthy'),
		st('bunkerweb-scheduler', false, 'absent', 'none')
	]).kind === 'partial'
);

expect(
	'verdict: present but exited → partial',
	bunkerwebVerdict(true, [
		st('bunkerweb', true, 'exited', 'none'),
		st('bunkerweb-scheduler', true, 'running', 'none')
	]).kind === 'partial'
);

expect(
	'verdict: running but unhealthy → unhealthy',
	bunkerwebVerdict(true, [
		st('bunkerweb', true, 'running', 'unhealthy'),
		st('bunkerweb-scheduler', true, 'running', 'none')
	]).kind === 'unhealthy'
);

expect(
	'verdict: all running healthy → running',
	bunkerwebVerdict(true, [
		st('bunkerweb', true, 'running', 'healthy'),
		st('bunkerweb-scheduler', true, 'running', 'none')
	]).kind === 'running'
);

expect(
	'verdict: running, health still starting → running (re-check)',
	bunkerwebVerdict(true, [
		st('bunkerweb', true, 'running', 'starting'),
		st('bunkerweb-scheduler', true, 'running', 'none')
	]).kind === 'running'
);

// bunkerwebCommands
{
	const cmds = bunkerwebCommands();
	expect(
		'commands: bring-up uses docker compose up -d',
		cmds.bringUp.some((l) => l.includes('docker compose up -d'))
	);
	expect(
		'commands: bring-up copies shipped config',
		cmds.bringUp.some((l) => l.includes('cp -r ops/bunkerweb /etc/bunkerweb'))
	);
	// BunkerWeb runs with logging driver `none` (nothing stored), so the only way to
	// see it is a live attach that never forwards signals/stdin to the container.
	expect(
		'commands: logs is the live attach view (docker compose logs cannot read a none-driver container)',
		/docker attach --no-stdin --sig-proxy=false bunkerweb/.test(cmds.logs) &&
			!cmds.logs.includes('docker compose logs')
	);
	expect('commands: down present', cmds.down.includes('docker compose down'));
}

// ─── shipped-config SPA/PWA safety + example↔ansible parity ──
// The incident: /v1/ was rate-limited at 60r/m (1 r/s), tighter
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
		expect(
			`${label}: BAD_BEHAVIOR_STATUS_CODES is set`,
			codes.length > 0,
			'must be set explicitly'
		);
		for (const banned of ['400', '403', '404', '429']) {
			expect(
				`${label}: bad-behavior does NOT count ${banned}`,
				!codes.includes(banned),
				`counting ${banned} re-introduces the self-feeding / burst ban (got: ${codesRaw})`
			);
		}
	}

	// v1.16.9 — the upgrade self-heal must be MULTI-STRATEGY:
	// all three fixes, tried more than one way, verified against the container.
	const up = readFileSync(resolve(root, 'apps/ops-cli/src/commands/upgrade.ts'), 'utf8');
	// Called from the shared heal list since the final v1.18.0 review (runSelfHeals).
	expect(
		'self-heal: healBunkerWebWaf exists + is called',
		/function healBunkerWebWaf\(/.test(up) &&
			/healBunkerWebWaf\(undefined, installBuildDir\(\)/.test(up) &&
			/\(\) => startWebProxyHeals\(\)/.test(up) &&
			/await runSelfHeals\(\)/.test(up)
	);
	expect(
		'self-heal fixes MAX_CLIENT_SIZE (413)',
		/MAX_CLIENT_SIZE/.test(up) && /RELAY_BODY_FLOOR/.test(up)
	);
	expect(
		'self-heal drops 400 from bad-behavior (403 ban)',
		/BAD_BEHAVIOR_STATUS_CODES/.test(up) && /c !== '400'/.test(up)
	);
	// v1.20.1 — ONE copy only: the file copy (v1.16.9–v1.20.0) made BunkerWeb refuse
	// every new config on morphitir ("Rule id: 1990001 is duplicated"). The behaviour
	// is driven for real in test/bunkerwebWafIdentify.test.ts.
	expect(
		'self-heal keeps ONE copy of the ModSec exemption (the setting) and removes extra copies',
		/CUSTOM_CONF_MODSEC_morphit_json_api_off/.test(up) &&
			!/morphit-json-api-off\.conf/.test(up) &&
			/planRuleDedupe\(/.test(up) &&
			/removeRuleCopies\(/.test(up)
	);
	expect(
		'self-heal has a reload FALLBACK chain (not one method)',
		/strategies: Array<\(\) => boolean>/.test(up) && /docker-compose/.test(up)
	);
	expect(
		"self-heal reads BunkerWeb's own verdict and VERIFIES the exemption on the live site (and puts copies back if /v1/ is blocked)",
		/waitForSchedulerCycle\(/.test(up) &&
			/exemption verified live/.test(up) &&
			/restoreRuleCopies\(/.test(up)
	);
	expect(
		'self-heal PROBES a real-sized body against the live endpoint (413 detect)',
		/v1\/broadcast/.test(up) && /50 \* 1024|A'\.repeat/.test(up)
	);
	expect(
		'self-heal escalates the ModSec request-body limit (the real 413 source when client_max_body_size is generous)',
		/SecRequestBodyNoFilesLimit/.test(up) && /SecRequestBodyLimitAction ProcessPartial/.test(up)
	);

	// example ↔ ansible parity on the security-critical knobs
	for (const key of [
		'LIMIT_REQ_RATE_1',
		'LIMIT_REQ_RATE_2',
		'BAD_BEHAVIOR_STATUS_CODES',
		'MAX_CLIENT_SIZE'
	]) {
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
		currentServerName('# x\nSERVER_NAME=trade.example.org\nSERVER_TYPE=http\n') ===
			'trade.example.org'
	);
	expect('installer: currentServerName null when absent', currentServerName('no key') === null);

	// isPlaceholderServerName
	for (const ph of ['morphit.example.com', '', 'foo.example.net', 'x.example.org']) {
		expect(`installer: "${ph || '<empty>'}" is a placeholder`, isPlaceholderServerName(ph));
	}
	expect(
		'installer: a real domain is not a placeholder',
		!isPlaceholderServerName('trade.agorise.net')
	);

	// validateServerName
	expect('installer: validate accepts a real hostname', validateServerName('trade.agorise.net').ok);
	expect('installer: validate accepts a short TLD host', validateServerName('x.io').ok);
	expect('installer: validate rejects a URL', !validateServerName('https://x.org').ok);
	expect('installer: validate rejects whitespace', !validateServerName('a b.com').ok);
	expect('installer: validate rejects no-dot', !validateServerName('localhost').ok);
	expect(
		'installer: validate rejects the placeholder',
		!validateServerName('morphit.example.com').ok
	);
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
	expect(
		'installer: setServerName is idempotent',
		!setServerName(sset.text, 'trade.agorise.net').changed
	);
	const sins = setServerName('SOME=thing\n', 'trade.agorise.net');
	expect(
		'installer: setServerName inserts when the key is absent',
		sins.changed &&
			sins.previous === null &&
			sins.text.startsWith('SERVER_NAME=trade.agorise.net\n')
	);

	// certPathsForServerName
	const cp = certPathsForServerName('trade.agorise.net');
	expect(
		'installer: certPathsForServerName builds the letsencrypt live paths',
		cp.fullchain === '/etc/letsencrypt/live/trade.agorise.net/fullchain.pem' &&
			cp.privkey === '/etc/letsencrypt/live/trade.agorise.net/privkey.pem'
	);

	// setFrontendBuildPath: canonical no-op / custom rewrite / no-match no-op
	const compose =
		'  frontend:\n    volumes:\n      - /opt/morphit/apps/web/build:/usr/share/nginx/html:ro\n';
	expect(
		'installer: setFrontendBuildPath no-op on the canonical /opt/morphit',
		!setFrontendBuildPath(compose, '/opt/morphit').changed
	);
	const fb = setFrontendBuildPath(compose, '/home/op/morphit');
	expect(
		'installer: setFrontendBuildPath rewrites the bind path for a custom install dir',
		fb.changed &&
			fb.text.includes('/home/op/morphit/apps/web/build:/usr/share/nginx/html:ro') &&
			!fb.text.includes('/opt/morphit/apps/web/build')
	);
	expect(
		'installer: setFrontendBuildPath no-op when the bind line is absent',
		!setFrontendBuildPath('no bind', '/home/op/morphit').changed
	);
	// The REAL manual compose on an install that is not at /opt/morphit: every
	// /opt/morphit bind source (build, frontend nginx.conf, the scheduler's job
	// lists) must point into the install, and each must exist there as what its
	// target is (a file over a file) — a missing source makes Docker create an
	// empty DIRECTORY and the scheduler cannot start.
	{
		const { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, existsSync } =
			await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const repo = join(import.meta.dirname, '..', '..', '..');
		const inst = mkdtempSync(join(tmpdir(), 'morphit-bw-install-'));
		try {
			cpSync(join(repo, 'ops', 'bunkerweb'), join(inst, 'ops', 'bunkerweb'), { recursive: true });
			mkdirSync(join(inst, 'apps', 'web', 'build'), { recursive: true });
			const real = readFileSync(join(repo, 'ops', 'bunkerweb', 'docker-compose.yml'), 'utf8');
			const out = setFrontendBuildPath(real, inst);
			const binds = [...out.text.matchAll(/^\s*-\s+(\/[^:\s]+):(\/[^:\s]+)(?::ro)?\s*$/gm)].map(
				(m) => [m[1]!, m[2]!]
			);
			const leftover = binds.filter(([s]) => s.startsWith('/opt/morphit/'));
			const bad = binds
				.filter(([s]) => s.startsWith(`${inst}/`))
				.filter(([s, d]) => !existsSync(s) || statSync(s).isDirectory() !== !/\.[a-z]+$/.test(d));
			expect(
				'installer: the real compose on a custom install dir mounts every Morphit file from that install (none left at /opt/morphit, each source exists as a file or directory like its target)',
				out.changed &&
					leftover.length === 0 &&
					bad.length === 0 &&
					binds.some(([s]) => s.endsWith('/mmdb-local.py')),
				`leftover: ${leftover.map(([s]) => s).join(', ')}; bad: ${bad.map(([s]) => s).join(', ')}`
			);
		} finally {
			rmSync(inst, { recursive: true, force: true });
		}
	}

	// installDirFromEnv
	expect(
		'installer: installDirFromEnv defaults to /opt/morphit',
		installDirFromEnv({}) === '/opt/morphit'
	);
	expect(
		'installer: installDirFromEnv trims an override',
		installDirFromEnv({ MORPHIT_INSTALL_DIR: '  /srv/m  ' }) === '/srv/m'
	);

	// dockerInstallGuidance
	const g = dockerInstallGuidance();
	expect(
		'installer: dockerInstallGuidance gives the apt route only (no remote script piped into a root shell)',
		g.official.length >= 2 &&
			g.official.some((l) => l.includes('apt-get install')) &&
			!JSON.stringify(g).includes('get.docker.com') &&
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
		already.alreadyRunning && !already.needDocker && !already.copyConfig && !already.willBringUp
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
	expect(
		'planner: docker without the compose plugin still needs the docker step',
		noPlugin.needDocker
	);
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
		{
			re: /async function runBunkerwebInstaller\(/,
			desc: 'the guided installer orchestrator exists'
		},
		{
			re: /process\.stdin\.isTTY === true && ctx\.flags\.status !== 'true'/,
			desc: 'runBunkerWeb gates the installer on an interactive TTY (and a --status opt-out)'
		},
		{
			re: /return await runBunkerwebInstaller\(/,
			desc: 'runBunkerWeb hands off to the installer when interactive + not running'
		},
		{
			re: /planBunkerwebInstall\(\{/,
			desc: 'the installer derives its plan from planBunkerwebInstall'
		},
		{
			re: /certPathsForServerName\(domain\)/,
			desc: 'the installer checks the cert path before bring-up'
		},
		{
			re: /existsSync\(certs\.fullchain\)/,
			desc: 'the cert check is the crash-loop guard (existsSync on fullchain)'
		},
		{
			re: /\['compose', '-f', composePath, 'up', '-d'\]/,
			desc: 'the installer runs docker compose up -d'
		},
		{ re: /\['compose', '-f', composePath, 'pull'\]/, desc: 'the installer pulls images first' },
		{
			re: /if \(plan\.copyConfig\) \{/,
			desc: 'config is copied only when the plan says so (never clobbering existing)'
		},
		{
			re: /realCmd = root \? cmd : 'sudo'/,
			desc: 'host-mutating commands run via sudo when not root'
		}
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

// ─── vigilante.trading, v1.21.8: a first visit got 429 on the site's own files ───
// BunkerWeb applies its own catch-all request rule (LIMIT_REQ_URL=/ at 2r/s,
// counted per visitor AND per file) to every address the settings do not
// replace. On a first visit the page, the offline cache and the tamper check
// each fetch the same script file within a second, so the third fetch got 429
// ("Failed to fetch dynamically imported module"). Driven here through a model
// of BunkerWeb 1.5.10's limit plugin (src/common/core/limit/limit.lua: rule per
// URL regex, `/` only when no other rule matches, timestamps kept per server +
// visitor + file for 1 s / 1 min / …, a 429 once more than the rate are kept),
// checked against that Lua file running for real when this was written.
// MORPHIT_BW_ROOT=<dir containing ops/> runs another tree to watch it fail.
{
	const root = resolve(
		process.env.MORPHIT_BW_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
	);
	const parse = (text: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const l of text.split('\n')) {
			const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
			if (m) out[m[1]!] = m[2]!.trim();
		}
		return out;
	};
	/** BunkerWeb 1.5.10's request limit for one site, from its settings. */
	const bunkerWebLimit = (settings: Record<string, string>) => {
		const v: Record<string, string> = {
			USE_LIMIT_REQ: 'yes',
			LIMIT_REQ_URL: '/',
			LIMIT_REQ_RATE: '2r/s',
			...settings
		};
		const rules = new Map<string, string | undefined>();
		for (const [k, url] of Object.entries(v))
			if (/LIMIT_REQ_URL/.test(k)) rules.set(url, v[k.replace('URL', 'RATE')]);
		const stamps = new Map<string, number[]>();
		const DELAY: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
		return (uri: string, now: number, visitor = '203.0.113.7'): number => {
			if (v.USE_LIMIT_REQ !== 'yes') return 200;
			let rate: string | undefined;
			for (const [url, r] of rules)
				if (url !== '/' && new RegExp(url).test(uri)) {
					rate = r;
					break;
				}
			if (rate === undefined) {
				if (!rules.has('/')) return 200;
				rate = rules.get('/');
			}
			const m = /(\d+)r\/(.)/.exec(rate ?? '');
			if (!m) return 200;
			const max = Number(m[1]);
			const key = `${visitor}${uri}`;
			const kept = (stamps.get(key) ?? []).filter((t) => now - t <= (DELAY[m[2]!] ?? 0));
			if (kept.length <= max) kept.push(now);
			stamps.set(key, kept);
			return kept.length > max ? 429 : 200;
		};
	};
	const { BW_LIMIT_REQ_URL, BW_LIMIT_REQ_RATE, BW_LIMIT_CONN_MAX_HTTP2 } = await import(
		'../src/commands/upgrade.ts'
	);
	for (const [label, rel] of [
		['ansible.j2', 'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'],
		['env.example', 'ops/bunkerweb/bunkerweb.env.example']
	] as const) {
		const settings = parse(readFileSync(resolve(root, rel), 'utf8'));
		const fetchAll = (uri: string, times: number, at: number): number[] => {
			const limit = bunkerWebLimit(settings);
			return Array.from({ length: times }, () => limit(uri, at));
		};
		for (const uri of [
			'/_app/immutable/chunks/CmsKOCeN.js',
			'/_app/immutable/entry/app.Dx1.js',
			'/',
			'/orderbook',
			'/brand/site-logo.svg',
			'/verify.json',
			'/service-worker.js'
		]) {
			const codes = fetchAll(uri, 5, 1_000_000);
			expect(
				`${label}: a first visit fetching ${uri} 5 times in one second gets no 429`,
				!codes.includes(429),
				`BunkerWeb would answer ${codes.join(' ')}`
			);
		}
		for (const uri of ['/ipfs/bafyexample', '/ipns/k51example', '/rss/orders.xml', '/mcp']) {
			const codes = fetchAll(uri, 4, 1_000_000);
			expect(
				`${label}: ${uri} keeps BunkerWeb's 2 per second (third fetch in a second → 429)`,
				codes.join(' ') === '200 200 429 429',
				`BunkerWeb would answer ${codes.join(' ')}`
			);
		}
		{
			const limit = bunkerWebLimit(settings);
			const n = Array.from({ length: 30 }, () => limit('/v1/orderbook', 1_000_000)).filter(
				(c) => c === 429
			).length;
			expect(
				`${label}: 30 /v1/ calls in one second still pass (its own 1800r/m rule)`,
				n === 0,
				`${n} × 429`
			);
		}
		const conn = Number(settings.LIMIT_CONN_MAX_HTTP2 ?? '100');
		expect(
			`${label}: a visitor may download ≥ 256 files at once over HTTP/2 (two connections of nginx's 128)`,
			settings.USE_LIMIT_CONN !== 'no' && conn >= 256,
			`LIMIT_CONN_MAX_HTTP2=${settings.LIMIT_CONN_MAX_HTTP2 ?? '(BunkerWeb default 100)'}`
		);
		expect(
			`${label}: the request rule and download count are the ones the upgrade heal writes`,
			settings.LIMIT_REQ_URL === BW_LIMIT_REQ_URL &&
				settings.LIMIT_REQ_RATE === BW_LIMIT_REQ_RATE &&
				settings.LIMIT_CONN_MAX_HTTP2 === BW_LIMIT_CONN_MAX_HTTP2,
			`file: ${settings.LIMIT_REQ_URL} ${settings.LIMIT_REQ_RATE} ${settings.LIMIT_CONN_MAX_HTTP2}; heal: ${BW_LIMIT_REQ_URL} ${BW_LIMIT_REQ_RATE} ${BW_LIMIT_CONN_MAX_HTTP2}`
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
