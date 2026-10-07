/**
 * Installed-box heal: BunkerWeb's scheduler runs Morphit's job lists, so it
 * fetches nothing from the internet.
 *
 * WHY. Four of BunkerWeb 1.5.10's scheduler jobs reach a third party whatever
 * its settings say (read from the 1.5.10 sources and seen in a real scheduler
 * run, apps/ops-cli:bunkerweb-no-phone-home-smoke):
 *  - mmdb-country and mmdb-asn ask db-ip.com every day and download its GeoIP
 *    databases;
 *  - update-check asks api.github.com for BunkerWeb's releases;
 *  - download-pro-plugins downloads "preview" Pro plugins from
 *    assets.bunkerity.com, even without a licence, and installs their code.
 * Morphit mounts its own copies of the two files that list those jobs
 * (ops/bunkerweb/scheduler/: the internal-jobs list without the three, with
 * mmdb-local.py putting the image's own GeoIP files in place instead, and the
 * Pro plugin file without its job) read-only over the image's.
 *
 * WHAT, on this server: for each running BunkerWeb 1.5.10 scheduler started by
 * Docker Compose whose live job lists still name one of those jobs, the three
 * read-only mounts are added to its service in the compose file that defines
 * it (kept byte for byte otherwise; a copy is kept first), Compose must show
 * them, and the scheduler alone is recreated. VERIFY, by observation: the
 * scheduler runs again, the job lists inside it are Morphit's, and its log
 * since the restart shows its jobs ran with none of those four among them.
 * FALL BACK: otherwise the original compose file is put back and the scheduler
 * recreated on it. A mount the operator already put at one of those paths is
 * theirs: the heal leaves the stack alone and says so. Settings an operator
 * chose that make BunkerWeb download something (EXTERNAL_PLUGIN_URLS, a Pro
 * licence, nightly CRS rules, real-IP lists) are named, not changed.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import {
	composeArgs,
	composeCommand,
	composeRefOf,
	parseDockerInspect,
	serviceRange,
	type ComposeRef,
	type ContainerInfo
} from './proxyConfigHeal.ts';

/** Morphit's files (relative to its install) and where the scheduler reads them. */
export const SCHEDULER_JOB_FILES: ReadonlyArray<{ readonly rel: string; readonly target: string }> =
	[
		{
			rel: 'ops/bunkerweb/scheduler/jobs-plugin.json',
			target: '/usr/share/bunkerweb/core/jobs/plugin.json'
		},
		{
			rel: 'ops/bunkerweb/scheduler/mmdb-local.py',
			target: '/usr/share/bunkerweb/core/jobs/jobs/mmdb-local.py'
		},
		{
			rel: 'ops/bunkerweb/scheduler/pro-plugin.json',
			target: '/usr/share/bunkerweb/core/pro/plugin.json'
		}
	];
/** BunkerWeb 1.5.10 jobs that reach a third party whatever the settings. */
export const PHONE_HOME_JOBS: readonly string[] = [
	'mmdb-country',
	'mmdb-asn',
	'update-check',
	'download-pro-plugins'
];
/** BunkerWeb 1.5.10's own plugins (src/common/core). */
const CORE_PLUGINS = new Set(
	'antibot authbasic backup badbehavior blacklist brotli bunkernet clientcache cors country customcert db dnsbl errors greylist gzip headers inject jobs letsencrypt limit metrics misc modsecurity php pro realip redirect redis reverseproxy reversescan selfsigned sessions ui whitelist'.split(
		' '
	)
);
const VERSION = '1.5.10';

/** Job names in a BunkerWeb plugin.json text ([] when it has none or is not one). PURE. */
export function jobsListed(pluginJson: string | null): string[] {
	try {
		const j = JSON.parse(pluginJson ?? '') as { jobs?: Array<{ name?: unknown }> };
		return (j.jobs ?? []).map((x) => String(x.name ?? ''));
	} catch {
		return [];
	}
}

/** Jobs a scheduler log says it ran ("Executing job <job> from plugin <plugin>"). PURE. */
export function jobsRun(log: string): Array<{ job: string; plugin: string }> {
	return [...log.matchAll(/Executing job (\S+) from plugin (\S+)/g)]
		.map((m) => ({ job: m[1]!, plugin: m[2]! }))
		.filter((j) => j.job !== 'scheduler');
}

/** Settings an operator chose that make BunkerWeb download something. PURE. */
export function operatorDownloads(env: readonly string[]): string[] {
	const v = new Map(
		env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1).trim()] as const)
	);
	const out: string[] = [];
	if (v.get('EXTERNAL_PLUGIN_URLS')) out.push('EXTERNAL_PLUGIN_URLS (plugin downloads)');
	if (v.get('PRO_LICENSE_KEY')) out.push('PRO_LICENSE_KEY (licence checks at api.bunkerweb.io)');
	if (v.get('MODSECURITY_CRS_VERSION') === 'nightly')
		out.push('MODSECURITY_CRS_VERSION=nightly (rule downloads from GitHub)');
	if (v.get('USE_REAL_IP') === 'yes' && v.get('REAL_IP_FROM_URLS'))
		out.push('REAL_IP_FROM_URLS (address-list downloads)');
	return out;
}

export interface MountPlan {
	readonly text: string;
	readonly added: readonly string[];
	/** Paths an operator already mounts something else at. */
	readonly conflicts: readonly string[];
}

/**
 * Add the read-only mounts of Morphit's job files (under `root`) to `service`
 * in a compose text. An entry already mounting the same file there is kept;
 * an entry mounting something else there is a conflict (nothing is added).
 * Only the short `- source:target[:ro]` volume form is read. PURE.
 */
export function planSchedulerMounts(text: string, service: string, root: string): MountPlan {
	const lines = text.split('\n');
	const r = serviceRange(lines, service);
	if (!r) return { text, added: [], conflicts: [] };
	let vol = -1;
	for (let i = r[0] + 1; i < r[1]; i++) if (/^    volumes:\s*$/.test(lines[i]!)) vol = i;
	let last = vol;
	const have: Array<{ src: string; dst: string; ro: boolean }> = [];
	if (vol >= 0)
		for (let i = vol + 1; i < r[1]; i++) {
			const l = lines[i]!;
			if (/^\s*#/.test(l) || l.trim() === '') continue;
			const m = /^ {6}- ["']?([^"':]+):([^"':]+)(?::([a-z,]+))?["']?\s*$/.exec(l);
			if (!m) {
				if (/^ {6}- /.test(l)) {
					last = i;
					continue;
				}
				break;
			}
			have.push({ src: m[1]!, dst: m[2]!, ro: (m[3] ?? '').split(',').includes('ro') });
			last = i;
		}
	const added: string[] = [];
	const conflicts: string[] = [];
	const add: string[] = [];
	for (const f of SCHEDULER_JOB_FILES) {
		const src = join(root, f.rel);
		const at = have.find((h) => h.dst === f.target);
		if (at) {
			if (at.src !== src || !at.ro) conflicts.push(f.target);
			continue;
		}
		add.push(`      - ${src}:${f.target}:ro`);
		added.push(f.target);
	}
	if (conflicts.length > 0 || add.length === 0) return { text, added: [], conflicts };
	const block = [
		"      # Morphit's job lists: BunkerWeb's scheduler fetches nothing from the internet",
		...add
	];
	let out: string[];
	if (vol >= 0) out = [...lines.slice(0, last + 1), ...block, ...lines.slice(last + 1)];
	else out = [...lines.slice(0, r[0] + 1), '    volumes:', ...block, ...lines.slice(r[0] + 1)];
	return { text: out.join('\n'), added, conflicts: [] };
}

export interface JobsRuntime {
	containers(): ContainerInfo[] | null;
	/** The docker command exists on this server (absent: assumed). */
	dockerInstalled?(): boolean;
	readFile(p: string): Buffer | null;
	writeFile(p: string, b: Buffer): boolean;
	backup(p: string): string | null;
	exists(p: string): boolean;
	installRoot(): string;
	/** Bind mounts (source → target, read-only) Compose gives `service`; null if it cannot say. */
	composeBinds(
		ref: ComposeRef,
		service: string
	): Array<{ source: string; target: string; ro: boolean }> | null;
	composeUp(ref: ComposeRef, service: string): boolean;
	/** A file inside a container; null when unreadable. */
	execCat(container: string, path: string): string | null;
	logsSince(container: string, sinceIso: string): string;
	now(): number;
	sleep(ms: number): Promise<void>;
}

const isScheduler = (c: ContainerInfo): boolean =>
	/(^|\/)bunkerity\/bunkerweb-scheduler(:|@|$)/.test(c.image) && c.running;

export async function healBunkerwebJobs(
	ctx: HealCtx,
	opts: { runtime?: JobsRuntime; waitMs?: number; pollMs?: number } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const all = rt.containers();
	if (all === null) {
		// No Docker at all: nothing here to check. Docker installed but not
		// answering: a problem the operator must see.
		if (rt.dockerInstalled !== undefined && !rt.dockerInstalled())
			return {
				strategy: 'skipped',
				verified: true,
				routine: true,
				detail: "BunkerWeb's jobs: no Docker on this server."
			};
		return {
			strategy: 'docker-unavailable',
			verified: false,
			detail:
				"BunkerWeb's jobs: Docker is not answering on this server, so its job lists could not be checked; on this server check: sudo systemctl status docker"
		};
	}
	const scheds = all.filter(isScheduler);
	if (scheds.length === 0)
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: "BunkerWeb's jobs: no BunkerWeb scheduler runs on this server."
		};
	const details: string[] = [];
	/** Schedulers with nothing to do and nothing to say (counted, not printed). */
	const quiet: string[] = [];
	let verified = true;
	let strategy = 'already';
	for (const s of scheds) {
		const notes = operatorDownloads(s.env);
		// An operator's setting that downloads something is a warning, named
		// with what to do — never folded into a line that says all is clean.
		const extra =
			notes.length > 0
				? ` Settings on this server still make BunkerWeb download something (Morphit sets none of them): ${notes.join('; ')}; remove them from BunkerWeb's settings if you do not need them.`
				: '';
		if (notes.length > 0) verified = false;
		if (!new RegExp(`:${VERSION.replace(/\./g, '\\.')}(@|$)`).test(s.image)) {
			details.push(
				`BunkerWeb's jobs: ${s.name} runs ${s.image}, not ${VERSION}, so Morphit's job lists (made for ${VERSION}) were not mounted.${extra}`
			);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		const live = () => [
			...jobsListed(rt.execCat(s.name, SCHEDULER_JOB_FILES[0]!.target)),
			...jobsListed(rt.execCat(s.name, SCHEDULER_JOB_FILES[2]!.target))
		];
		const before = live();
		if (before.length > 0 && !before.some((j) => PHONE_HOME_JOBS.includes(j))) {
			if (notes.length === 0)
				quiet.push(
					`BunkerWeb's jobs: ${s.name} already runs Morphit's job lists (its own jobs fetch nothing from the internet).`
				);
			else
				details.push(
					`BunkerWeb's jobs: ${s.name} already runs Morphit's job lists, so its own jobs fetch nothing from the internet.${extra}`
				);
			continue;
		}
		const ref = composeRefOf(s);
		if (!ref) {
			details.push(
				`BunkerWeb's jobs: ${s.name} was not started by Docker Compose, so its job lists were left as they are; it still asks db-ip.com, api.github.com and assets.bunkerity.com daily.${extra}`
			);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		const root = rt.installRoot();
		const missing = SCHEDULER_JOB_FILES.filter((f) => !rt.exists(join(root, f.rel)));
		if (missing.length > 0) {
			details.push(
				`BunkerWeb's jobs: ${missing.map((f) => f.rel).join(', ')} not found under ${root}; ${s.name} was left as it is.`
			);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		const file = [...ref.files].reverse().find((f) => {
			const t = rt.readFile(f)?.toString('utf8');
			return t !== undefined && serviceRange(t.split('\n'), ref.service) !== null;
		});
		const orig = file ? rt.readFile(file) : null;
		if (!file || !orig) {
			details.push(
				`BunkerWeb's jobs: the compose file that defines ${ref.service} could not be read; ${s.name} was left as it is.`
			);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		const plan = planSchedulerMounts(orig.toString('utf8'), ref.service, root);
		if (plan.conflicts.length > 0 || plan.added.length === 0) {
			details.push(
				plan.conflicts.length > 0
					? `BunkerWeb's jobs: ${file} already mounts something else at ${plan.conflicts.join(', ')} in ${ref.service}; that is left as it is.`
					: `BunkerWeb's jobs: ${file} has the mounts but ${s.name} still runs the image's job lists; on this server run: sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--force-recreate', ref.service])}`
			);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		const copy = rt.backup(file);
		if (!copy || !(rt.readFile(copy)?.equals(orig) ?? false)) {
			details.push(
				`BunkerWeb's jobs: could not keep a copy of ${file} first, so it was left as it is.`
			);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		const restore = (): boolean =>
			rt.writeFile(file, orig) && (rt.readFile(file)?.equals(orig) ?? false);
		const next = Buffer.from(plan.text, 'utf8');
		if (!rt.writeFile(file, next) || !(rt.readFile(file)?.equals(next) ?? false)) {
			restore();
			details.push(`BunkerWeb's jobs: could not write ${file}; it was put back as it was.`);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		const binds = rt.composeBinds(ref, ref.service) ?? [];
		const shown = SCHEDULER_JOB_FILES.every((f) =>
			binds.some((b) => b.target === f.target && b.source === join(root, f.rel) && b.ro)
		);
		if (!shown) {
			restore();
			details.push(
				`BunkerWeb's jobs: Docker Compose did not show the new mounts for ${ref.service}, so ${file} was put back as it was. Copy: ${copy}.`
			);
			strategy = 'left-alone';
			verified = false;
			continue;
		}
		// Recreate the scheduler alone and watch its first run of every job.
		const since = new Date(rt.now() - 2_000).toISOString();
		const stop = ctx.spinner("Restarting BunkerWeb's scheduler with Morphit's job lists…");
		// With its Docker log off, the job lists inside it are the evidence.
		const logs = s.logDriver !== 'none';
		let log = '';
		let lists: string[] = [];
		let running = false;
		try {
			if (rt.composeUp(ref, ref.service)) {
				const until = rt.now() + (opts.waitMs ?? 240_000);
				while (rt.now() < until) {
					running = (rt.containers() ?? []).some((c) => c.name === s.name && c.running);
					if (logs) log = rt.logsSince(s.name, since);
					if (running && (!logs || /jobs in run_once\(\)/.test(log))) break;
					await rt.sleep(opts.pollMs ?? 5_000);
				}
				lists = running ? live() : [];
			}
		} finally {
			stop();
		}
		const ran = jobsRun(log);
		const phoned = ran.filter((j) => PHONE_HOME_JOBS.includes(j.job));
		const foreign = ran.filter((j) => !CORE_PLUGINS.has(j.plugin));
		const ok =
			running &&
			(!logs || /jobs in run_once\(\)/.test(log)) &&
			lists.includes('mmdb-local') &&
			!lists.some((j) => PHONE_HOME_JOBS.includes(j)) &&
			phoned.length === 0;
		if (ok) {
			strategy = 'applied';
			if (foreign.length > 0) verified = false;
			details.push(
				`BunkerWeb's jobs: ${s.name} now runs Morphit's job lists — seen inside it` +
					(logs
						? `, and its first run since the restart ran ${ran.length} jobs, none of ${PHONE_HOME_JOBS.join(', ')}`
						: ' (its Docker log is off, so its job runs could not be read)') +
					` — so it no longer contacts db-ip.com, api.github.com or assets.bunkerity.com. Copy of the original: ${copy}.` +
					(foreign.length > 0
						? ` It also ran jobs of plugins that are not BunkerWeb's own or Morphit's: ${[...new Set(foreign.map((j) => `${j.job} (${j.plugin})`))].join(', ')}; remove those plugins if you do not use them, as they may fetch from the internet.`
						: '') +
					extra
			);
			continue;
		}
		// Fall back: the original file, the scheduler recreated on it.
		const back = restore();
		const stop2 = ctx.spinner("Putting BunkerWeb's scheduler back on its previous settings…");
		running = false;
		try {
			if (back && rt.composeUp(ref, ref.service)) {
				for (let i = 0; i < 20 && !running; i++) {
					running = (rt.containers() ?? []).some((c) => c.name === s.name && c.running);
					if (!running) await rt.sleep(opts.pollMs ?? 3_000);
				}
			}
		} finally {
			stop2();
		}
		strategy = 'fallback-restored';
		verified = false;
		details.push(
			`BunkerWeb's jobs: ${s.name} did not come up running Morphit's job lists (${phoned.length > 0 ? `it still ran ${phoned.map((j) => j.job).join(', ')}` : 'its jobs were not seen running'}), so ${file} was put back` +
				(running
					? ' and the scheduler runs again on it.'
					: `; check it on this server with: sudo docker ps -a --filter name=${s.name}; to start it: sudo ${composeCommand(ref, ['up', '-d', '--no-deps', ref.service])}`) +
				` Copy: ${copy}.`
		);
	}
	// Every scheduler already clean, with nothing to say: one routine result.
	if (details.length === 0)
		return { strategy: 'already', verified: true, routine: true, detail: quiet.join(' ') };
	return { strategy, verified, detail: details.join(' ') };
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healBunkerwebJobs(ctx);
}

const docker = (args: string[], timeout = 20_000): { ok: boolean; out: string } => {
	try {
		const r = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
		return { ok: r.status === 0, out: r.stdout ?? '' };
	} catch {
		return { ok: false, out: '' };
	}
};
const realRuntime: JobsRuntime = {
	dockerInstalled: () => {
		try {
			const r = spawnSync('docker', ['--version'], { stdio: 'ignore', timeout: 10_000 });
			return (r.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
		} catch {
			return true;
		}
	},
	containers: () => {
		const ps = docker(['ps', '--format', '{{.Names}}']);
		if (!ps.ok) return null;
		const names = ps.out
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean);
		if (names.length === 0) return [];
		const r = docker(['inspect', ...names]);
		return r.ok ? parseDockerInspect(r.out) : null;
	},
	readFile: (p) => {
		try {
			return readFileSync(p);
		} catch {
			return null;
		}
	},
	writeFile: (p, b) => {
		try {
			// In place, so the file keeps its owner and mode.
			writeFileSync(p, b);
			return true;
		} catch {
			return false;
		}
	},
	backup: (p) => {
		const b = `${p}.bak-bwjobs-${Date.now()}`;
		try {
			copyFileSync(p, b);
			return b;
		} catch {
			return null;
		}
	},
	exists: (p) => existsSync(p),
	installRoot: () => {
		const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
		const env = (process.env.MORPHIT_INSTALL_DIR ?? '').trim();
		return env || (m && m[1] && existsSync(join(m[1], 'ops')) ? m[1] : '/opt/morphit');
	},
	composeBinds: (ref, service) => {
		const r = docker(composeArgs(ref, ['config', '--format', 'json']), 60_000);
		if (!r.ok) return null;
		try {
			const j = JSON.parse(r.out) as {
				services?: Record<
					string,
					{
						volumes?: Array<{
							type?: string;
							source?: string;
							target?: string;
							read_only?: boolean;
						}>;
					}
				>;
			};
			return (j.services?.[service]?.volumes ?? [])
				.filter((v) => v.type === 'bind')
				.map((v) => ({
					source: String(v.source),
					target: String(v.target),
					ro: v.read_only === true
				}));
		} catch {
			return null;
		}
	},
	composeUp: (ref, service) =>
		docker(composeArgs(ref, ['up', '-d', '--no-deps', service]), 300_000).ok,
	execCat: (c, p) => {
		const r = docker(['exec', c, 'cat', p]);
		return r.ok ? r.out : null;
	},
	logsSince: (c, since) => {
		try {
			const r = spawnSync('docker', ['logs', '--since', since, c], {
				encoding: 'utf8',
				timeout: 20_000,
				maxBuffer: 64 * 1024 * 1024
			});
			return `${r.stdout ?? ''}${r.stderr ?? ''}`;
		} catch {
			return '';
		}
	},
	now: () => Date.now(),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
