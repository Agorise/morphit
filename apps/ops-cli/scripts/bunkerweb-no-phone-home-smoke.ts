/**
 * bunkerweb-no-phone-home-smoke.
 *
 * BunkerWeb, as Morphit ships it, contacts nobody at runtime: no bunkerweb.io,
 * no db-ip.com, no GitHub, no blocklist hosts, no DNSBL. (Let's Encrypt is the
 * one third party a clearnet node needs; Morphit's certificates come from the
 * host's certbot, so BunkerWeb's own ACME client is off too.)
 *
 * Every part runs against BOTH ways a node gets BunkerWeb: the Ansible
 * template (rendered) with its compose file, and the manual example with the
 * manual compose file.
 *
 * Always:
 *  - every BunkerWeb 1.5.10 setting that makes it reach a third party is
 *    effectively off (a key that is absent takes BunkerWeb's default);
 *  - the scheduler runs Morphit's list of internal jobs and Pro plugin file
 *    (ops/bunkerweb/scheduler/), mounted read-only over the image's: BunkerWeb's
 *    mmdb-country, mmdb-asn, update-check and download-pro-plugins jobs reach
 *    db-ip.com, api.github.com and assets.bunkerity.com whatever the settings.
 *
 * With MORPHIT_BW_SRC (a BunkerWeb v1.5.10 checkout) the override files are
 * also compared with the image's: same settings, only those jobs gone.
 *
 * Live, as root with MORPHIT_BW_SRC and MORPHIT_BW_DEPS (the scheduler's Python
 * packages, e.g. `python3.12 -m pip install --require-hashes --target <dir>
 * -r src/scheduler/requirements.txt -r src/common/gen/requirements.txt
 * -r src/common/db/requirements.txt` in that checkout): runs BunkerWeb's REAL
 * scheduler (bunkerweb-egress/run.sh: every job once, the config generator,
 * the push to the instance) in a network namespace where every connection
 * attempt and DNS lookup is recorded, and asserts
 *  - control: with BunkerWeb's defaults it DOES try db-ip.com and
 *    api.bunkerweb.io (the harness sees attempts);
 *  - Morphit's template and example: no attempt to anything but the instance
 *    itself, every job succeeds, the GeoIP databases are in place, and the
 *    settings BunkerWeb generated (variables.env) have every privacy setting
 *    of lib/bunkerwebPrivacy.ts off.
 * Without those it says so and skips the live part.
 */
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BUNKERWEB_PRIVACY_SETTINGS,
	bunkerwebSettingsProblems
} from '../src/lib/bunkerwebPrivacy.ts';
import { parseEnvText, renderAnsibleTemplate, repoPath, REPO } from './ansible-template-render.ts';

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

const wizard = {
	morphit_domain: 'trade.example.org',
	morphit_instance_tor_address: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz234567.onion',
	bunkerweb_docker_gid: '999',
	morphit_repo_path: '/opt/morphit'
};
const templateEnv = renderAnsibleTemplate(
	'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2',
	wizard
);
const exampleEnv = readFileSync(repoPath('ops/bunkerweb/bunkerweb.env.example'), 'utf8');
const templateCompose = renderAnsibleTemplate(
	'ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2',
	wizard
);
const manualCompose = readFileSync(repoPath('ops/bunkerweb/docker-compose.yml'), 'utf8');

// BunkerWeb 1.5.10's defaults for the settings that make it reach a third
// party (src/common/core/*/plugin.json), and what each one does when on.
const OUTBOUND: Array<{ key: string; dflt: string; safe: (v: string) => boolean; what: string }> = [
	{
		key: 'USE_BUNKERNET',
		dflt: 'yes',
		safe: (v) => v === 'no',
		what: 'reports to api.bunkerweb.io'
	},
	{
		key: 'USE_DNSBL',
		dflt: 'yes',
		safe: (v) => v === 'no',
		what: 'DNSBL lookups (Spamhaus, SORBS, blocklist.de)'
	},
	{
		key: 'USE_BLACKLIST',
		dflt: 'yes',
		safe: (v) => v === 'no',
		what: 'list downloads + reverse DNS'
	},
	{
		key: 'USE_WHITELIST',
		dflt: 'yes',
		safe: (v) => v === 'no',
		what: 'list downloads + reverse DNS'
	},
	{
		key: 'USE_GREYLIST',
		dflt: 'no',
		safe: (v) => v === 'no',
		what: 'list downloads + reverse DNS'
	},
	{
		key: 'SEND_ANONYMOUS_REPORT',
		dflt: 'yes',
		safe: (v) => v === 'no',
		what: 'daily report to api.bunkerweb.io'
	},
	{ key: 'USE_REAL_IP', dflt: 'no', safe: (v) => v === 'no', what: 'REAL_IP_FROM_URLS downloads' },
	{
		key: 'USE_REVERSE_SCAN',
		dflt: 'no',
		safe: (v) => v === 'no',
		what: "connects back to visitors' ports"
	},
	{
		key: 'USE_ANTIBOT',
		dflt: 'no',
		safe: (v) => !['recaptcha', 'hcaptcha', 'turnstile'].includes(v),
		what: 'Google / hCaptcha / Cloudflare verification'
	},
	{
		key: 'AUTO_LETS_ENCRYPT',
		dflt: 'no',
		safe: (v) => v === 'no',
		what: "BunkerWeb's own ACME client"
	},
	{ key: 'EXTERNAL_PLUGIN_URLS', dflt: '', safe: (v) => v === '', what: 'plugin downloads' },
	{
		key: 'PRO_LICENSE_KEY',
		dflt: '',
		safe: (v) => v === '',
		what: 'api.bunkerweb.io licence checks'
	},
	{
		key: 'MODSECURITY_CRS_VERSION',
		dflt: '3',
		safe: (v) => v !== 'nightly',
		what: 'nightly rule downloads from GitHub'
	}
];
for (const [label, text] of [
	['template', templateEnv],
	['manual example', exampleEnv]
] as const) {
	const env = parseEnvText(text);
	for (const o of OUTBOUND) {
		const v = env.get(o.key) ?? o.dflt;
		check(`${label}: ${o.key}=${v} (${o.what} — off)`, o.safe(v));
	}
}

// ── the scheduler's job overrides, in both compose files ────────────────
const OVERRIDES: Array<[string, string]> = [
	['ops/bunkerweb/scheduler/jobs-plugin.json', '/usr/share/bunkerweb/core/jobs/plugin.json'],
	['ops/bunkerweb/scheduler/mmdb-local.py', '/usr/share/bunkerweb/core/jobs/jobs/mmdb-local.py'],
	['ops/bunkerweb/scheduler/pro-plugin.json', '/usr/share/bunkerweb/core/pro/plugin.json']
];
/** Read-only bind mounts (source, target) of the service using the scheduler image. */
function schedulerBinds(composeText: string): Array<[string, string]> {
	// PyYAML (Ansible's own parser, already needed to render the template).
	const r = spawnSync(
		'python3',
		['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin)))'],
		{ input: composeText, encoding: 'utf8' }
	);
	const doc = JSON.parse(r.status === 0 ? r.stdout : '{}') as {
		services?: Record<string, { image?: string; volumes?: unknown[] }>;
	};
	// The scheduler itself, not a one-shot that borrows its image (bw-init
	// replaces the entrypoint).
	const svc = Object.values(doc.services ?? {}).find(
		(s) =>
			/bunkerity\/bunkerweb-scheduler:/.test(String(s.image ?? '')) &&
			(s as { entrypoint?: unknown }).entrypoint === undefined
	);
	const out: Array<[string, string]> = [];
	for (const v of svc?.volumes ?? []) {
		if (typeof v === 'string') {
			const [src, dst, mode] = v.split(':');
			if (src && dst && mode === 'ro') out.push([src, dst]);
		} else if (v && typeof v === 'object') {
			const o = v as { type?: string; source?: string; target?: string; read_only?: boolean };
			if (o.type === 'bind' && o.source && o.target && o.read_only) out.push([o.source, o.target]);
		}
	}
	return out;
}
const bindsFor: Record<string, Array<[string, string]>> = {};
for (const [label, text] of [
	['template compose', templateCompose],
	['manual compose', manualCompose]
] as const) {
	const binds = schedulerBinds(text);
	bindsFor[label] = binds;
	for (const [rel, target] of OVERRIDES)
		check(
			`${label}: the scheduler mounts ${rel} read-only over ${target}`,
			binds.some(([s, t]) => t === target && s === `/opt/morphit/${rel}`),
			binds.map(([s, t]) => `${s}:${t}`).join(' ') || 'no read-only mounts'
		);
}
for (const [rel] of OVERRIDES) check(`${rel} is in the release`, existsSync(repoPath(rel)));
// BunkerWeb runs a job file directly, so it must stay executable (git mode 100755).
check(
	'mmdb-local.py is executable (the scheduler runs job files directly)',
	existsSync(repoPath(OVERRIDES[1]![0])) &&
		(statSync(repoPath(OVERRIDES[1]![0])).mode & 0o111) === 0o111
);
const jobsOverride = existsSync(repoPath(OVERRIDES[0]![0]))
	? (JSON.parse(readFileSync(repoPath(OVERRIDES[0]![0]), 'utf8')) as {
			jobs: Array<{ name: string; file: string }>;
		})
	: { jobs: [] };
const PHONE_HOME_JOBS = ['mmdb-country', 'mmdb-asn', 'update-check'];
check(
	'the jobs list has none of mmdb-country, mmdb-asn, update-check, and runs mmdb-local',
	!jobsOverride.jobs.some((j) => PHONE_HOME_JOBS.includes(j.name)) &&
		jobsOverride.jobs.some((j) => j.name === 'mmdb-local' && j.file === 'mmdb-local.py')
);
const proOverride = existsSync(repoPath(OVERRIDES[2]![0]))
	? (JSON.parse(readFileSync(repoPath(OVERRIDES[2]![0]), 'utf8')) as { jobs?: unknown[] })
	: { jobs: ['missing'] };
check(
	'the Pro plugin file has no job (no download-pro-plugins)',
	(proOverride.jobs ?? []).length === 0
);

const SRC = process.env.MORPHIT_BW_SRC ?? '';
const srcOk = SRC !== '' && existsSync(join(SRC, 'src/common/core/jobs/plugin.json'));
if (srcOk) {
	const orig = (rel: string): Record<string, unknown> =>
		JSON.parse(readFileSync(join(SRC, rel), 'utf8')) as Record<string, unknown>;
	const strip = (o: Record<string, unknown>): string => JSON.stringify({ ...o, jobs: undefined });
	const jo = orig('src/common/core/jobs/plugin.json');
	const po = orig('src/common/core/pro/plugin.json');
	const ours = JSON.parse(readFileSync(repoPath(OVERRIDES[0]![0]), 'utf8')) as Record<
		string,
		unknown
	>;
	const oursPro = JSON.parse(readFileSync(repoPath(OVERRIDES[2]![0]), 'utf8')) as Record<
		string,
		unknown
	>;
	check("the jobs list keeps the image file's id, name and settings", strip(jo) === strip(ours));
	check(
		"the Pro plugin file keeps the image file's id, name and settings",
		strip(po) === strip(oursPro)
	);
	const origJobs = (jo.jobs as Array<{ name: string }>).map((j) => j.name);
	check(
		"only the jobs that reach a third party are gone from the image's list",
		origJobs
			.filter((n) => !PHONE_HOME_JOBS.includes(n))
			.every((n) => jobsOverride.jobs.some((j) => j.name === n))
	);
} else
	check(
		'skipped the comparison with BunkerWeb 1.5.10: MORPHIT_BW_SRC is not a BunkerWeb checkout',
		true
	);

// ── live: BunkerWeb's real scheduler, every attempt recorded ────────────
const DEPS = process.env.MORPHIT_BW_DEPS ?? '';
const has = (b: string): boolean => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const live =
	srcOk &&
	DEPS !== '' &&
	existsSync(DEPS) &&
	process.getuid?.() === 0 &&
	['ip', 'nft', 'unshare', 'python3.12'].every(has);
if (!live)
	check(
		'skipped the live run: needs root, ip, nft, unshare, python3.12, MORPHIT_BW_SRC and MORPHIT_BW_DEPS',
		true
	);
else {
	const work = mkdtempSync(join(tmpdir(), 'bw-nph-'));
	try {
		// The scheduler image's /usr/share/bunkerweb (src/scheduler/Dockerfile).
		const usb = join(work, 'usb');
		mkdirSync(usb);
		for (const [from, to] of [
			['src/common/api', 'api'],
			['src/common/cli', 'cli'],
			['src/common/confs', 'confs'],
			['src/common/db', 'db'],
			['src/common/core', 'core'],
			['src/common/gen', 'gen'],
			['src/common/helpers', 'helpers'],
			['src/common/settings.json', 'settings.json'],
			['src/common/utils', 'utils'],
			['src/scheduler', 'scheduler'],
			['src/VERSION', 'VERSION']
		])
			cpSync(join(SRC, from!), join(usb, to!), { recursive: true });
		mkdirSync(join(usb, 'deps'));
		symlinkSync(DEPS, join(usb, 'deps', 'python'));
		writeFileSync(join(usb, 'INTEGRATION'), 'Docker\n');
		const harness = join(REPO, 'apps/ops-cli/scripts/bunkerweb-egress/run.sh');
		const mmdb = join(SRC, 'src/bw/misc');
		const runCase = (name: string, envText: string, binds: Array<[string, string]>) => {
			const envFile = join(work, `${name}.env`);
			writeFileSync(envFile, envText);
			const out = join(work, `out-${name}`);
			const args = binds.map(([s, t]) => `${s.replace(/^\/opt\/morphit\//, `${REPO}/`)}:${t}`);
			spawnSync('bash', [harness, usb, mmdb, envFile, out, '180', ...args], {
				stdio: 'ignore',
				timeout: 400_000
			});
			const log = existsSync(join(out, 'scheduler.log'))
				? readFileSync(join(out, 'scheduler.log'), 'utf8')
				: '';
			const hosts = new Set<string>();
			if (existsSync(join(out, 'audit.log')))
				for (const line of readFileSync(join(out, 'audit.log'), 'utf8')
					.split('\n')
					.filter(Boolean)) {
					const e = JSON.parse(line) as { ev: string; args: string };
					const m = /^\('([^']+)', (\d+)/.exec(e.args);
					if (!m) continue; // unix sockets
					if (['bunkerweb', 'localhost', '127.0.0.1', '::1'].includes(m[1]!)) continue;
					hosts.add(`${m[1]}:${m[2]}`);
				}
			let sink: string[] = [];
			try {
				const j = JSON.parse(readFileSync(join(out, 'sink.json'), 'utf8')) as {
					nftables: Array<{ set?: { elem?: Array<{ concat: unknown[] }> } }>;
				};
				sink = j.nftables.flatMap((x) => x.set?.elem ?? []).map((e) => e.concat.join(' '));
			} catch {
				sink = ['(no record)'];
			}
			const cache = existsSync(join(out, 'jobs-cache.txt'))
				? readFileSync(join(out, 'jobs-cache.txt'), 'utf8')
				: '';
			const vars = existsSync(join(out, 'nginx/variables.env'))
				? readFileSync(join(out, 'nginx/variables.env'), 'utf8')
				: '';
			return { log, hosts: [...hosts], sink, cache, vars };
		};
		const ACME = /(^|\.)api\.letsencrypt\.org:/;
		const control = runCase(
			'defaults',
			'SERVER_NAME=trade.example.org\nAPI_WHITELIST_IP=127.0.0.0/8\n',
			[]
		);
		check(
			'control — BunkerWeb with its own defaults tries db-ip.com and api.bunkerweb.io (the harness sees attempts)',
			control.hosts.some((h) => h.startsWith('db-ip.com:')) &&
				control.hosts.some((h) => h.startsWith('api.bunkerweb.io:')),
			control.hosts.join(' ') || 'nothing recorded'
		);
		for (const [label, envText, binds] of [
			['template', templateEnv, bindsFor['template compose']!],
			['manual example', exampleEnv, bindsFor['manual compose']!]
		] as const) {
			const r = runCase(label.replace(/\s/g, '-'), envText, binds);
			check(
				`${label}: BunkerWeb's scheduler ran every job once and pushed its config`,
				/All jobs in run_once\(\) were successful/.test(r.log) &&
					/Successfully reloaded bunkerweb/.test(r.log),
				r.log
					.split('\n')
					.filter((l) => /❌/.test(l))
					.slice(0, 3)
					.join(' | ') || 'no completion line'
			);
			check(
				`${label}: no attempt to reach any host but the instance (ACME aside)`,
				r.hosts.filter((h) => !ACME.test(h)).length === 0,
				r.hosts.join(' ')
			);
			check(
				`${label}: nothing left the scheduler's network namespace`,
				r.sink.length === 0,
				r.sink.join(', ')
			);
			check(
				`${label}: the GeoIP databases are in place (from the image, nothing downloaded)`,
				/country\.mmdb/.test(r.cache) && /asn\.mmdb/.test(r.cache),
				r.cache.trim().split('\n').join(' ')
			);
			// What BunkerWeb really runs with: the variables.env its generator wrote.
			const problems = bunkerwebSettingsProblems(
				r.vars,
				new Map(BUNKERWEB_PRIVACY_SETTINGS.map((x) => [x.key, x.value] as const))
			);
			check(
				`${label}: BunkerWeb's generated settings have every privacy setting off (${BUNKERWEB_PRIVACY_SETTINGS.map((x) => x.key).join(', ')})`,
				r.vars !== '' && problems.length === 0,
				problems.join('; ') || 'no variables.env'
			);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} bunkerweb-no-phone-home checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} bunkerweb-no-phone-home checks failed`);
process.exit(1);
