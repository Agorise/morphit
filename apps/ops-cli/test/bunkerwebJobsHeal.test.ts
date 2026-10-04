import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	healBunkerwebJobs,
	jobsRun,
	operatorDownloads,
	planSchedulerMounts,
	SCHEDULER_JOB_FILES,
	type JobsRuntime
} from '../src/lib/bunkerwebJobsHeal.ts';
import type { ContainerInfo } from '../src/lib/proxyConfigHeal.ts';

const REPO = resolve(__dirname, '..', '..', '..');
const ROOT = '/opt/morphit';
const COMPOSE = '/etc/bunkerweb/docker-compose.yml';
// The manual compose as v1.20.2 shipped it (the scheduler without the mounts).
const OLD_COMPOSE = `services:
  bunkerweb-scheduler:
    image: bunkerity/bunkerweb-scheduler:1.5.10
    container_name: bunkerweb-scheduler
    restart: unless-stopped
    env_file:
      - ./bunkerweb.env
    volumes:
      - bw-data:/data
      # BunkerWeb 1.5's scheduler finds the instance through the Docker API
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - bunkerweb_net
  frontend:
    image: fe
volumes:
  bw-data:
`;
const IMAGE_JOBS = JSON.stringify({
	id: 'jobs',
	jobs: [
		{ name: 'mmdb-country' },
		{ name: 'mmdb-asn' },
		{ name: 'update-check' },
		{ name: 'failover-backup' }
	]
});
const IMAGE_PRO = JSON.stringify({ id: 'pro', jobs: [{ name: 'download-pro-plugins' }] });
const OUR_JOBS = readFileSync(join(REPO, SCHEDULER_JOB_FILES[0]!.rel), 'utf8');
const OUR_PRO = readFileSync(join(REPO, SCHEDULER_JOB_FILES[2]!.rel), 'utf8');

const sched = (over: Partial<ContainerInfo> = {}): ContainerInfo => ({
	name: 'bunkerweb-scheduler',
	id: 'x',
	image: 'bunkerity/bunkerweb-scheduler:1.5.10',
	running: true,
	labels: {
		'com.docker.compose.project': 'bunkerweb',
		'com.docker.compose.service': 'bunkerweb-scheduler',
		'com.docker.compose.project.config_files': COMPOSE,
		'com.docker.compose.project.working_dir': '/etc/bunkerweb'
	},
	env: [],
	logDriver: 'json-file',
	logOptions: {},
	extraHosts: [],
	ports: [],
	mounts: [],
	binds: [],
	gateways: [],
	...over
});

/** A box: files, one scheduler; recreating it applies whatever the compose file mounts. */
class Box implements JobsRuntime {
	files = new Map<string, Buffer>([[COMPOSE, Buffer.from(OLD_COMPOSE)]]);
	c = sched();
	mounted = false;
	ups = 0;
	t = 0;
	/** What the next run of the scheduler logs. */
	runLog = (mounted: boolean): string =>
		[
			...(mounted
				? ['mmdb-local from plugin jobs']
				: ['mmdb-country from plugin jobs', 'update-check from plugin jobs']),
			'failover-backup from plugin jobs',
			'blacklist-download from plugin blacklist'
		]
			.map((j) => `[SCHEDULER] - Executing job ${j} ...`)
			.join('\n') + '\n[SCHEDULER] - All jobs in run_once() were successful\n';
	log = '';
	ignoreMounts = false;
	containers = () => [this.c];
	readFile = (p: string) => this.files.get(p) ?? null;
	writeFile = (p: string, b: Buffer) => (this.files.set(p, Buffer.from(b)), true);
	backup = (p: string) => (this.files.set(`${p}.bak`, Buffer.from(this.files.get(p)!)), `${p}.bak`);
	exists = (p: string) => SCHEDULER_JOB_FILES.some((f) => join(ROOT, f.rel) === p);
	installRoot = () => ROOT;
	composeBinds = (_r: unknown, service: string) => {
		const text = this.files.get(COMPOSE)!.toString();
		const out: Array<{ source: string; target: string; ro: boolean }> = [];
		const body = text.split(`  ${service}:\n`)[1]?.split(/\n  [a-z]/)[0] ?? '';
		for (const m of body.matchAll(/^ {6}- ([^:\s]+):([^:\s]+)(?::(ro))?$/gm))
			if (m[1]!.startsWith('/')) out.push({ source: m[1]!, target: m[2]!, ro: m[3] === 'ro' });
		return out;
	};
	composeUp = () => {
		this.ups++;
		this.mounted =
			!this.ignoreMounts && /core\/jobs\/plugin\.json:ro/.test(this.files.get(COMPOSE)!.toString());
		this.log = this.runLog(this.mounted);
		return true;
	};
	execCat = (_c: string, p: string) =>
		p.endsWith('core/jobs/plugin.json')
			? this.mounted
				? OUR_JOBS
				: IMAGE_JOBS
			: p.endsWith('core/pro/plugin.json')
				? this.mounted
					? OUR_PRO
					: IMAGE_PRO
				: null;
	logsSince = () => (this.c.logDriver === 'none' ? '' : this.log);
	now = () => this.t;
	sleep = async (ms: number) => {
		this.t += ms;
	};
}
const ctx = { info: () => {}, warn: () => {}, spinner: () => () => {} };

describe('BunkerWeb’s scheduler runs Morphit’s job lists (nothing from the internet)', () => {
	it('an installed stack gets the three read-only mounts, and the scheduler is seen running without the phone-home jobs', async () => {
		const b = new Box();
		const r = await healBunkerwebJobs(ctx, { runtime: b });
		expect(r.strategy).toBe('applied');
		expect(r.verified).toBe(true);
		const text = b.files.get(COMPOSE)!.toString();
		for (const f of SCHEDULER_JOB_FILES)
			expect(text).toContain(`- ${join(ROOT, f.rel)}:${f.target}:ro`);
		expect(b.mounted).toBe(true);
		// Nothing else in the file moved.
		expect(
			text.replace(/\n {6}# Morphit's job lists[^\n]*\n(?: {6}- \/opt\/morphit\/[^\n]*\n)+/, '\n')
		).toBe(OLD_COMPOSE);
	});
	it('already on Morphit’s lists: nothing written, nothing restarted', async () => {
		const b = new Box();
		b.mounted = true;
		const r = await healBunkerwebJobs(ctx, { runtime: b });
		expect(r.strategy).toBe('already');
		expect(b.ups).toBe(0);
		expect(b.files.get(COMPOSE)!.toString()).toBe(OLD_COMPOSE);
	});
	it('another BunkerWeb version: left alone (the lists are made for 1.5.10)', async () => {
		const b = new Box();
		b.c = sched({ image: 'bunkerity/bunkerweb-scheduler:1.6.0' });
		const r = await healBunkerwebJobs(ctx, { runtime: b });
		expect(r.verified).toBe(false);
		expect(b.ups).toBe(0);
		expect(b.files.get(COMPOSE)!.toString()).toBe(OLD_COMPOSE);
	});
	it('the operator mounts their own file there: left alone', async () => {
		const b = new Box();
		const own = OLD_COMPOSE.replace(
			'      - /var/run/docker.sock:/var/run/docker.sock:ro\n',
			'      - /var/run/docker.sock:/var/run/docker.sock:ro\n      - /srv/my-jobs.json:/usr/share/bunkerweb/core/jobs/plugin.json:ro\n'
		);
		b.files.set(COMPOSE, Buffer.from(own));
		const r = await healBunkerwebJobs(ctx, { runtime: b });
		expect(r.verified).toBe(false);
		expect(b.ups).toBe(0);
		expect(b.files.get(COMPOSE)!.toString()).toBe(own);
		// Not even touched: no copy was needed.
		expect(b.files.has(`${COMPOSE}.bak`)).toBe(false);
	});
	it('the recreated scheduler still runs the phone-home jobs: the original file is put back and it runs again on it', async () => {
		const b = new Box();
		b.ignoreMounts = true;
		const r = await healBunkerwebJobs(ctx, { runtime: b, waitMs: 20_000 });
		expect(r.strategy).toBe('fallback-restored');
		expect(r.verified).toBe(false);
		expect(b.files.get(COMPOSE)!.toString()).toBe(OLD_COMPOSE);
		expect(b.ups).toBe(2);
	});
	it('its Docker log is off: the job lists inside it are the evidence', async () => {
		const b = new Box();
		b.c = sched({ logDriver: 'none' });
		const r = await healBunkerwebJobs(ctx, { runtime: b });
		expect(r.strategy).toBe('applied');
		expect(r.verified).toBe(true);
	});
	it('a job of a plugin that is neither BunkerWeb’s nor Morphit’s ran: applied, but not called clean', async () => {
		const b = new Box();
		const base = b.runLog;
		b.runLog = (m) =>
			`${base(m)}[SCHEDULER] - Executing job pro-report from plugin reporting ...\n`;
		const r = await healBunkerwebJobs(ctx, { runtime: b });
		expect(r.strategy).toBe('applied');
		expect(r.verified).toBe(false);
	});
	it('reads which jobs ran and which operator settings still download something', () => {
		expect(
			jobsRun('Executing job mmdb-local from plugin jobs ...\nExecuting job scheduler ...')
		).toEqual([{ job: 'mmdb-local', plugin: 'jobs' }]);
		expect(
			operatorDownloads(['EXTERNAL_PLUGIN_URLS=', 'PRO_LICENSE_KEY=', 'MODSECURITY_CRS_VERSION=4'])
		).toEqual([]);
		expect(
			operatorDownloads(['EXTERNAL_PLUGIN_URLS=https://x/p.zip', 'MODSECURITY_CRS_VERSION=nightly'])
		).toHaveLength(2);
	});
});

const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
describe.skipIf(!compose)('the planned file, read by the real Docker Compose', () => {
	it('v1.20.2’s manual compose, planned: Compose shows exactly the three read-only mounts added to the scheduler', () => {
		const old = readFileSync(join(REPO, 'ops/bunkerweb/docker-compose.yml'), 'utf8')
			.split('\n')
			.filter((l) => !/ops\/bunkerweb\/scheduler\//.test(l))
			.join('\n');
		const plan = planSchedulerMounts(old, 'bunkerweb-scheduler', ROOT);
		const dir = mkdtempSync(join(tmpdir(), 'bwjobs-'));
		try {
			const f = join(dir, 'docker-compose.yml');
			writeFileSync(join(dir, 'bunkerweb.env'), '');
			const cfg = (text: string) => {
				writeFileSync(f, text);
				const r = spawnSync('docker', ['compose', '-f', f, 'config', '--format', 'json'], {
					encoding: 'utf8',
					env: { ...process.env, DOCKER_GID: '999' }
				});
				expect(r.status, r.stderr).toBe(0);
				return (
					JSON.parse(r.stdout).services['bunkerweb-scheduler'].volumes as Array<
						Record<string, unknown>
					>
				).map((v) => `${v.source}:${v.target}:${v.read_only === true}`);
			};
			const before = cfg(old);
			const after = cfg(plan.text);
			expect(after.filter((v) => !before.includes(v)).sort()).toEqual(
				SCHEDULER_JOB_FILES.map((x) => `${join(ROOT, x.rel)}:${x.target}:true`).sort()
			);
			expect(before.every((v) => after.includes(v))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
