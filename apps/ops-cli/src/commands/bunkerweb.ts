/**
 * `morphit-ops bunkerweb` (beta5 item H; guided installer added beta11).
 *
 * Morphit ships a turnkey BunkerWeb deployment (ops/bunkerweb/, an Ansible
 * role, and wizard Step 21). This command both CHECKS that WAF and, on a
 * TTY, INSTALLS + brings it up for the operator:
 *
 *   - READ-ONLY status (always, and the only behavior under --json or when
 *     stdin isn't a TTY): is Docker present, are BunkerWeb and its scheduler
 *     (found by image, not name — locateBunkerWeb) running + healthy? Exits 0
 *     when running, 1 otherwise — suitable for monitoring. A BunkerWeb that is
 *     not the shipped /etc/bunkerweb stack is managed through its own Compose
 *     project and never gets the installer below.
 *   - GUIDED INSTALLER (interactive default when NOT already running):
 *     plain-English, confirmation-gated steps that
 *       1. ensure Docker + the compose v2 plugin are present (guide the
 *          install — the distribution's apt packages only),
 *       2. copy ops/bunkerweb → /etc/bunkerweb (never clobbering an existing
 *          /etc/bunkerweb — reuse + say so instead),
 *       3. set SERVER_NAME to the operator's real domain,
 *       4. CHECK the Let's Encrypt cert SERVER_NAME needs actually exists
 *          (its absence is what crash-loops BunkerWeb — we stop and point at
 *          `morphit-ops ssl` rather than bring up a doomed stack),
 *       5. `docker compose pull` then `up -d`,
 *       6. re-check health.
 *     Each host-mutating step is confirmed and runs via `sudo` when not
 *     already root. If the operator declines, we fall back to printing the
 *     exact manual commands.
 *
 * BunkerWeb's Docker IMAGES are deliberately NOT bundled with Morphit;
 * they're pulled from BunkerWeb's own registry on first bring-up.
 */

import { ask, askYesNo, explain } from '../init/prompt.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { runAsync } from '../lib/spinRun.ts';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	composeCommand,
	composeRefOf,
	parseDockerInspect,
	type ComposeRef
} from '../lib/proxyConfigHeal.ts';

export interface BunkerWebCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** The two containers the shipped compose file defines. */
export const BUNKERWEB_CONTAINERS = ['bunkerweb', 'bunkerweb-scheduler'] as const;

/** One `docker ps -a` row (see PS_FORMAT). */
export interface PsRow {
	readonly name: string;
	readonly image: string;
	readonly ports: string;
	readonly up: boolean;
	readonly project: string;
	readonly service: string;
}

export const PS_FORMAT =
	'{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}';

/** Parse `docker ps -a --format PS_FORMAT`. PURE. */
export function parsePsRows(out: string): PsRow[] {
	return out
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => {
			const [name = '', image = '', ports = '', status = '', project = '', service = ''] =
				l.split('\t');
			return {
				name: name.trim(),
				image: image.trim(),
				ports,
				up: /^up\b/i.test(status.trim()),
				project: project.trim(),
				service: service.trim()
			};
		});
}

const imageIs = (image: string, repo: string): boolean =>
	new RegExp(`(^|/)${repo.replace(/[/.-]/g, '\\$&')}(?=$|[:@])`).test(image);

export interface BunkerWebLocation {
	/** The containers whose state decides the verdict. */
	readonly names: readonly string[];
	/** The public BunkerWeb container, when exactly one could be told apart. */
	readonly edge: string | null;
	/** Several BunkerWeb containers and nothing to tell the public one by. */
	readonly ambiguous: boolean;
	/** Compose services of the edge + its scheduler (same project). */
	readonly services: readonly string[];
}

/** Which containers ARE BunkerWeb on this server — by IMAGE, tie-broken by a
 *  running container and host port 443, never by name (wave 5, B-from-C §4: on
 *  morphit.io every container is called bunkerweb-<service>-1, and the stack
 *  lives in /opt/bunkerweb). No BunkerWeb image at all → the shipped names, so
 *  a fresh box still gets the canonical status + installer. PURE. */
export function locateBunkerWeb(rows: readonly PsRow[]): BunkerWebLocation {
	let edges = rows.filter((r) => imageIs(r.image, 'bunkerity/bunkerweb'));
	if (edges.length === 0)
		return { names: [...BUNKERWEB_CONTAINERS], edge: null, ambiguous: false, services: [] };
	if (edges.length > 1 && edges.some((r) => r.up)) edges = edges.filter((r) => r.up);
	if (edges.length > 1) edges = edges.filter((r) => /:443->/.test(r.ports));
	if (edges.length !== 1) {
		const all = rows.filter((r) => imageIs(r.image, 'bunkerity/bunkerweb')).map((r) => r.name);
		return { names: all, edge: null, ambiguous: true, services: [] };
	}
	const edge = edges[0]!;
	let scheds = rows.filter(
		(r) =>
			imageIs(r.image, 'bunkerity/bunkerweb-scheduler') &&
			(edge.project === '' || r.project === edge.project)
	);
	if (scheds.some((r) => r.up)) scheds = scheds.filter((r) => r.up);
	if (scheds.length > 1) scheds = scheds.filter((r) => !/init/.test(`${r.service} ${r.name}`));
	const sched = scheds[0] ?? null;
	return {
		names: sched ? [edge.name, sched.name] : [edge.name],
		edge: edge.name,
		ambiguous: false,
		services:
			edge.service !== ''
				? [edge.service, ...(sched && sched.service !== '' ? [sched.service] : [])]
				: []
	};
}

// ─── PURE helpers (unit-tested) ─────────────────────────────────────

export interface ContainerState {
	readonly name: string;
	readonly present: boolean;
	/** docker State.Status: running / exited / created / … */
	readonly status: string;
	/** docker State.Health.Status: healthy / unhealthy / starting / none */
	readonly health: string;
}

/** Parse the `STATUS|HEALTH` line produced by our `docker inspect`
 *  format string. PURE. */
export function parseContainerState(name: string, inspectOut: string): ContainerState {
	const line = inspectOut.trim();
	if (line === '') return { name, present: false, status: 'absent', health: 'none' };
	const [status, health] = line.split('|');
	return {
		name,
		present: true,
		status: (status ?? '').trim() || 'unknown',
		health: (health ?? '').trim() || 'none'
	};
}

export type BunkerWebKind = 'docker-missing' | 'not-running' | 'partial' | 'unhealthy' | 'running';

export interface BunkerWebVerdict {
	readonly kind: BunkerWebKind;
	readonly message: string;
}

/** Decide overall BunkerWeb health from the per-container states.
 *  PURE. `dockerPresent=false` short-circuits to docker-missing. */
export function bunkerwebVerdict(
	dockerPresent: boolean,
	states: readonly ContainerState[]
): BunkerWebVerdict {
	if (!dockerPresent) {
		return {
			kind: 'docker-missing',
			message:
				'Docker is not installed (or not on PATH). BunkerWeb runs as Docker containers; ' +
				'install Docker first, or serve directly behind nginx/Caddy instead.'
		};
	}
	const present = states.filter((s) => s.present);
	if (present.length === 0) {
		return {
			kind: 'not-running',
			message:
				'BunkerWeb is not running (no bunkerweb containers found). Bring it up with the commands below.'
		};
	}
	if (present.length < states.length) {
		const missing = states.filter((s) => !s.present).map((s) => s.name);
		return {
			kind: 'partial',
			message: `Only some BunkerWeb containers are present (missing: ${missing.join(', ')}). The stack is incomplete — bring it fully up.`
		};
	}
	const notRunning = present.filter((s) => s.status !== 'running');
	if (notRunning.length > 0) {
		return {
			kind: 'partial',
			message: `Some BunkerWeb containers exist but are not running (${notRunning.map((s) => `${s.name}=${s.status}`).join(', ')}). Check the logs and restart.`
		};
	}
	const unhealthy = present.filter((s) => s.health === 'unhealthy');
	if (unhealthy.length > 0) {
		return {
			kind: 'unhealthy',
			message: `BunkerWeb containers are running but reporting unhealthy (${unhealthy.map((s) => s.name).join(', ')}). Check the logs.`
		};
	}
	const starting = present.filter((s) => s.health === 'starting');
	if (starting.length > 0) {
		return {
			kind: 'running',
			message: 'BunkerWeb is running; health checks are still starting up — re-check in a moment.'
		};
	}
	return { kind: 'running', message: 'BunkerWeb is running.' };
}

export interface BunkerWebCommands {
	readonly bringUp: readonly string[];
	readonly status: string;
	readonly logs: string;
	readonly down: string;
}

/** Watch BunkerWeb's output live, on this server, without storing it: the
 *  container has logging driver `none`, so `docker compose logs` has nothing to
 *  read. Ctrl-C detaches; the container keeps running (--sig-proxy=false). */
export const BUNKERWEB_LIVE_VIEW = 'sudo docker attach --no-stdin --sig-proxy=false bunkerweb';

/** The live view for the BunkerWeb container actually found on this server. */
export function bunkerwebLiveView(container: string): string {
	return `sudo docker attach --no-stdin --sig-proxy=false ${container}`;
}

/** Operator commands matching wizard Step 21 + ops/bunkerweb/README.md.
 *  PURE. */
export function bunkerwebCommands(): BunkerWebCommands {
	return {
		bringUp: [
			'sudo cp -r ops/bunkerweb /etc/bunkerweb',
			'# edit /etc/bunkerweb/bunkerweb.env — set SERVER_NAME to your domain',
			'echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" | sudo tee -a /etc/bunkerweb/.env',
			'cd /etc/bunkerweb && docker compose up -d'
		],
		status: 'cd /etc/bunkerweb && docker compose ps',
		// BunkerWeb runs with `logging: driver: none` (its access/error/ban lines
		// name visitors; nothing is stored), so `docker compose logs bunkerweb`
		// cannot read anything. Watch it LIVE instead (review C1 / wave 2).
		logs: BUNKERWEB_LIVE_VIEW,
		down: 'cd /etc/bunkerweb && docker compose down'
	};
}

// ─── Guided-installer PURE helpers (unit-tested) ────────────────────

/** The BunkerWeb image tag the canonical compose pins. Informational
 *  (the compose file is the source of truth); surfaced in narration. */
export const BUNKERWEB_IMAGE = 'bunkerity/bunkerweb:1.5.10';

const DEFAULT_INSTALL_DIR = '/opt/morphit';

/** Where the morphit repo (and thus ops/bunkerweb) lives on this host. */
export function installDirFromEnv(env: { MORPHIT_INSTALL_DIR?: string }): string {
	const v = (env.MORPHIT_INSTALL_DIR ?? '').trim();
	return v === '' ? DEFAULT_INSTALL_DIR : v;
}

/** Read the SERVER_NAME value from a bunkerweb.env text, or null if the
 *  key is absent. PURE. */
export function currentServerName(envText: string): string | null {
	const m = envText.match(/^SERVER_NAME=(.*)$/m);
	return m ? (m[1] ?? '').trim() : null;
}

/** Is a SERVER_NAME value the shipped placeholder / unset / an obvious
 *  example? Those must be replaced before bring-up. PURE. */
export function isPlaceholderServerName(v: string): boolean {
	const t = v.trim().toLowerCase();
	return t === '' || t === 'morphit.example.com' || /(^|\.)example\.(com|org|net)$/.test(t);
}

/** Validate an operator-entered public domain for SERVER_NAME. We keep
 *  this deliberately strict (a single hostname, not a URL or list) since
 *  it drives the cert path and the WAF server block. PURE. */
export function validateServerName(domain: string): { ok: boolean; reason?: string } {
	const d = domain.trim();
	if (d === '') return { ok: false, reason: 'empty' };
	if (/\s/.test(d)) return { ok: false, reason: 'contains whitespace (enter a single hostname)' };
	if (/^https?:\/\//i.test(d))
		return { ok: false, reason: 'looks like a URL — enter just the hostname (no https://)' };
	if (d.includes('/')) return { ok: false, reason: 'contains "/" — enter just the hostname' };
	if (!d.includes('.'))
		return {
			ok: false,
			reason: 'not a fully-qualified domain (needs a dot, e.g. trade.example.org)'
		};
	if (!/^[a-z0-9.-]+$/i.test(d))
		return { ok: false, reason: 'has characters not valid in a hostname' };
	if (isPlaceholderServerName(d))
		return { ok: false, reason: 'still the example placeholder — use your real domain' };
	return { ok: true };
}

/** Replace (or insert) the SERVER_NAME line in a bunkerweb.env text. PURE.
 *  Returns the new text, whether anything changed, and the previous value. */
export function setServerName(
	envText: string,
	domain: string
): { text: string; changed: boolean; previous: string | null } {
	const previous = currentServerName(envText);
	if (previous !== null) {
		if (previous === domain) return { text: envText, changed: false, previous };
		return {
			text: envText.replace(/^SERVER_NAME=.*$/m, `SERVER_NAME=${domain}`),
			changed: true,
			previous
		};
	}
	// Key absent (non-canonical file): prepend it.
	return { text: `SERVER_NAME=${domain}\n${envText}`, changed: true, previous: null };
}

/** The host cert paths BunkerWeb's USE_CUSTOM_SSL config expects for a
 *  given SERVER_NAME (must exist on the host before bring-up, or
 *  BunkerWeb crash-loops). PURE. */
export function certPathsForServerName(domain: string): { fullchain: string; privkey: string } {
	return {
		fullchain: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
		privkey: `/etc/letsencrypt/live/${domain}/privkey.pem`
	};
}

/** Rewrite the frontend build bind-mount path in a docker-compose text so
 *  it points at THIS install's apps/web/build instead of the canonical
 *  /opt/morphit (a wrong path serves an empty site — a guaranteed 404).
 *  PURE. No-op (changed=false) when the install dir is the canonical one
 *  or the expected bind line isn't present. */
export function setFrontendBuildPath(
	composeText: string,
	installDir: string
): { text: string; changed: boolean } {
	if (installDir === DEFAULT_INSTALL_DIR) return { text: composeText, changed: false };
	const canonical = `${DEFAULT_INSTALL_DIR}/apps/web/build:/usr/share/nginx/html`;
	const replacement = `${installDir}/apps/web/build:/usr/share/nginx/html`;
	// Also every file the compose mounts from the release's ops/bunkerweb/ (the
	// frontend's nginx.conf, the scheduler's job lists): a bind source that does
	// not exist is created by Docker as an empty DIRECTORY, and a directory over
	// a file target stops the container.
	const text = composeText
		.split(canonical)
		.join(replacement)
		.split(`${DEFAULT_INSTALL_DIR}/ops/bunkerweb/`)
		.join(`${installDir}/ops/bunkerweb/`);
	return { text, changed: text !== composeText };
}

export interface DockerInstallGuidance {
	/** The official, distro-package route (preferred — gets security updates). */
	readonly official: readonly string[];

	/** Where to read more. */
	readonly docs: string;
}

/** Plain-English Docker install guidance. PURE. */
export function dockerInstallGuidance(): DockerInstallGuidance {
	return {
		official: [
			'sudo apt-get update',
			'sudo apt-get install -y docker.io docker-compose-v2',
			'sudo systemctl enable --now docker'
		],
		docs: 'https://docs.docker.com/engine/install/'
	};
}

export interface BunkerwebInstallPlan {
	/** BunkerWeb is already fully up — show status + management only. */
	readonly alreadyRunning: boolean;
	/** Docker (or the compose v2 plugin) is missing — guide its install
	 *  before anything else. */
	readonly needDocker: boolean;
	/** Copy ops/bunkerweb → /etc/bunkerweb (only when the target is absent;
	 *  we never clobber an operator's edited /etc/bunkerweb). */
	readonly copyConfig: boolean;
	/** /etc/bunkerweb already exists — reuse it (and say so) rather than
	 *  overwrite the operator's edits. */
	readonly reuseExistingConfig: boolean;
	/** Ensure SERVER_NAME is a real domain in the env (always, when
	 *  installing). */
	readonly ensureServerName: boolean;
	/** `docker compose pull` then `up -d`. */
	readonly willPull: boolean;
	readonly willBringUp: boolean;
}

/** Decide the guided-install plan from host preconditions. PURE so the
 *  smoke can exhaust the cases. The orchestrator performs each enabled
 *  step behind its own confirmation. */
export function planBunkerwebInstall(opts: {
	dockerPresent: boolean;
	composePresent: boolean;
	alreadyFullyRunning: boolean;
	configDirExists: boolean;
}): BunkerwebInstallPlan {
	if (opts.alreadyFullyRunning) {
		return {
			alreadyRunning: true,
			needDocker: false,
			copyConfig: false,
			reuseExistingConfig: false,
			ensureServerName: false,
			willPull: false,
			willBringUp: false
		};
	}
	return {
		alreadyRunning: false,
		needDocker: !opts.dockerPresent || !opts.composePresent,
		copyConfig: !opts.configDirExists,
		reuseExistingConfig: opts.configDirExists,
		ensureServerName: true,
		willPull: true,
		willBringUp: true
	};
}

// ─── I/O (best-effort, never throws) ────────────────────────────────

async function dockerPresent(): Promise<boolean> {
	const { spawnSync } = await import('node:child_process');
	return spawnSync('which', ['docker'], { stdio: 'pipe', timeout: 3000 }).status === 0;
}

async function inspectContainer(name: string): Promise<ContainerState> {
	// Asynchronous, so the caller's spinner keeps turning while docker answers.
	const r = await runAsync(
		'docker',
		[
			'inspect',
			'--format',
			'{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
			name
		],
		{ timeoutMs: 5000 }
	);
	if (r.status !== 0) return { name, present: false, status: 'absent', health: 'none' };
	return parseContainerState(name, r.stdout);
}

/** Where BunkerWeb is on this server (by image), plus the edge's Compose
 *  project when it was started by Compose. IMPURE, never throws. */
async function findBunkerWeb(): Promise<{ loc: BunkerWebLocation; ref: ComposeRef | null }> {
	// Asynchronous, so the caller's spinner keeps turning while docker answers.
	const ps = await runAsync('docker', ['ps', '-a', '--format', PS_FORMAT], { timeoutMs: 8000 });
	const loc = locateBunkerWeb(ps.status === 0 ? parsePsRows(ps.stdout) : []);
	if (loc.edge === null) return { loc, ref: null };
	const insp = await runAsync('docker', ['inspect', loc.edge], {
		timeoutMs: 8000,
		maxOutputBytes: 16 * 1024 * 1024
	});
	const c = insp.status === 0 ? parseDockerInspect(insp.stdout || '[]')[0] : undefined;
	return { loc, ref: c ? composeRefOf(c) : null };
}

/** Best-effort: is the `docker compose` v2 plugin usable? IMPURE. */
async function dockerComposePresent(): Promise<boolean> {
	const { spawnSync } = await import('node:child_process');
	return spawnSync('docker', ['compose', 'version'], { stdio: 'pipe', timeout: 5000 }).status === 0;
}

/** Are we root (euid 0)? Determines whether host-mutating steps need a
 *  `sudo` prefix. IMPURE. */
function isRoot(): boolean {
	return typeof process.geteuid === 'function' && process.geteuid() === 0;
}

/** Run a host-mutating command, prefixing `sudo` when not already root so
 *  the operator gets a single inline password prompt. Inherits stdio so
 *  docker's own progress output is visible. Returns the exit status (or a
 *  non-zero sentinel if it couldn't be spawned). IMPURE. */
async function runHostCmd(cmd: string, args: readonly string[]): Promise<number> {
	const { spawnSync } = await import('node:child_process');
	const root = isRoot();
	const realCmd = root ? cmd : 'sudo';
	const realArgs = root ? args : [cmd, ...args];
	const r = spawnSync(realCmd, realArgs as string[], { stdio: 'inherit' });
	return typeof r.status === 'number' ? r.status : 1;
}

/** Read a possibly root-owned file, falling back to `sudo cat` on EACCES.
 *  Returns null if it can't be read. IMPURE. */
async function readMaybeSudo(path: string): Promise<string | null> {
	const { readFileSync } = await import('node:fs');
	try {
		return readFileSync(path, 'utf8');
	} catch {
		const { spawnSync } = await import('node:child_process');
		const root = isRoot();
		const r = spawnSync(root ? 'cat' : 'sudo', (root ? [path] : ['cat', path]) as string[], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5000
		});
		if (r.status === 0 && typeof r.stdout === 'string') return r.stdout;
		return null;
	}
}

/** Write `text` to a root-owned path: stage in a temp file we CAN write,
 *  then `sudo cp` it into place (or plain cp when root). IMPURE. Returns
 *  true on success. */
async function writeMaybeSudo(path: string, text: string): Promise<boolean> {
	const { writeFileSync, mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const staged = join(mkdtempSync(join(tmpdir(), 'mbw-env-')), 'bunkerweb.env');
	try {
		writeFileSync(staged, text, 'utf8');
	} catch {
		return false;
	}
	return (await runHostCmd('cp', [staged, path])) === 0;
}

/** Add `DOCKER_GID=<gid>` to a Compose `.env` text unless it already sets one.
 *  PURE. `null` text = no file yet. */
export function withDockerGid(
	text: string | null,
	gid: string
): { text: string; changed: boolean } {
	const t = text ?? '';
	if (/^[ \t]*DOCKER_GID[ \t]*=[ \t]*\S/m.test(t)) return { text: t, changed: false };
	const sep = t === '' || t.endsWith('\n') ? '' : '\n';
	return { text: `${t}${sep}DOCKER_GID=${gid}\n`, changed: true };
}

/** The host's `docker` group id, or null. IMPURE. */
function dockerGroupGid(): string | null {
	const r = spawnSync('getent', ['group', 'docker'], { encoding: 'utf8', timeout: 5000 });
	const gid = (r.stdout ?? '').split(':')[2]?.trim() ?? '';
	return r.status === 0 && /^\d+$/.test(gid) ? gid : null;
}

/**
 * The shipped compose gives BunkerWeb's scheduler the host's docker group (it
 * finds the BunkerWeb instance only through the Docker API) and refuses to
 * start without `DOCKER_GID` in `<dir>/.env`, which Compose reads. Write it
 * (root, 0640) when missing; keep a value the operator set. IMPURE.
 */
export async function ensureDockerGidEnv(
	dir: string,
	gidOf: () => string | null = dockerGroupGid
): Promise<{ ok: boolean; detail: string }> {
	const path = join(dir, '.env');
	const gid = gidOf();
	const current = existsSync(path) ? await readMaybeSudo(path) : null;
	if (existsSync(path) && current === null) return { ok: false, detail: `could not read ${path}` };
	if (gid === null) {
		return withDockerGid(current, '0').changed
			? {
					ok: false,
					detail: `this server has no docker group, so DOCKER_GID could not be set in ${path}`
				}
			: { ok: true, detail: `${path} already sets DOCKER_GID` };
	}
	const next = withDockerGid(current, gid);
	if (!next.changed) return { ok: true, detail: `${path} already sets DOCKER_GID` };
	if (!(await writeMaybeSudo(path, next.text)))
		return { ok: false, detail: `could not write ${path}` };
	await runHostCmd('chown', ['root:root', path]);
	await runHostCmd('chmod', ['0640', path]);
	return { ok: true, detail: `DOCKER_GID=${gid} written to ${path}` };
}

// ─── Command ────────────────────────────────────────────────────────

function color(enabled: boolean) {
	const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
	return {
		green: wrap('32'),
		yellow: wrap('33'),
		red: wrap('31'),
		dim: wrap('2'),
		bold: wrap('1')
	};
}

export async function runBunkerWeb(ctx: BunkerWebCtx): Promise<number> {
	const c = color(ctx.colorEnabled);
	const json = ctx.flags.json === 'true';

	// Asking docker can take seconds on a busy box: under the spinner (to stderr
	// under --json, so stdout carries only the JSON).
	const stopLook = startDotsSpinner(
		'Looking for BunkerWeb’s containers…',
		json ? process.stderr : process.stdout
	);
	let hasDocker: boolean;
	let found: { loc: BunkerWebLocation; ref: ComposeRef | null };
	let states: ContainerState[];
	try {
		hasDocker = await dockerPresent();
		found = hasDocker ? await findBunkerWeb() : { loc: locateBunkerWeb([]), ref: null };
		const names = found.loc.names;
		states = hasDocker
			? await Promise.all(names.map((n) => inspectContainer(n)))
			: names.map((n) => ({ name: n, present: false, status: 'absent', health: 'none' }));
	} finally {
		stopLook();
	}
	const { loc, ref } = found;
	const verdict = bunkerwebVerdict(hasDocker, states);
	const cmds = bunkerwebCommands();
	// A BunkerWeb that is NOT the shipped /etc/bunkerweb stack (e.g. morphit.io's
	// hand-made /opt/bunkerweb one): manage it through ITS OWN Compose project,
	// only its own services (never `down`/whole-stack, which includes the
	// database), and never offer to install a second stack (wave 5).
	const own = loc.ambiguous || (loc.edge !== null && loc.edge !== BUNKERWEB_CONTAINERS[0]);
	const liveView = loc.edge !== null ? bunkerwebLiveView(loc.edge) : cmds.logs;
	const ownCmd = (verb: string[], fallback: string): string =>
		ref !== null && loc.services.length > 0
			? `sudo ${composeCommand(ref, [...verb, ...loc.services])}`
			: fallback;

	if (json) {
		console.log(
			JSON.stringify(
				{
					docker_installed: hasDocker,
					state: verdict.kind,
					containers: states.map((s) => ({
						name: s.name,
						present: s.present,
						status: s.status,
						health: s.health
					}))
				},
				null,
				2
			)
		);
		return verdict.kind === 'running' ? 0 : 1;
	}

	console.log('');
	console.log('━'.repeat(60));
	console.log('  Web Application Firewall — BunkerWeb');
	console.log('━'.repeat(60));
	console.log('');
	const tag =
		verdict.kind === 'running'
			? c.green('✓')
			: verdict.kind === 'unhealthy' || verdict.kind === 'partial'
				? c.yellow('⚠')
				: c.red('✗');
	console.log(`  ${tag} ${verdict.message}`);
	console.log('');

	if (hasDocker && states.some((s) => s.present)) {
		for (const s of states) {
			const mark = !s.present
				? c.red('✗ absent')
				: s.status !== 'running'
					? c.yellow(s.status)
					: s.health === 'unhealthy'
						? c.yellow('running (unhealthy)')
						: c.green(`running${s.health === 'healthy' ? ' (healthy)' : ''}`);
			console.log(`      ${s.name}: ${mark}`);
		}
		console.log('');
	}

	// Already up + healthy → show management commands and stop. (Also the
	// terminal state for --json above and for non-interactive callers.)
	if (verdict.kind === 'running') {
		console.log(`  ${c.dim('Live view (on this server; nothing is stored):')} ${liveView}`);
		console.log(`  ${c.dim('  (Ctrl-C detaches; the container keeps running.)')}`);
		if (own) {
			const names = loc.names.join(' ');
			console.log(
				`  ${c.dim('Restart (on this server):')} ${ownCmd(['restart'], `sudo docker restart ${names}`)}`
			);
			console.log(
				`  ${c.dim('Stop (on this server):')}    ${ownCmd(['stop'], `sudo docker stop ${names}`)}`
			);
		} else {
			console.log(`  ${c.dim('Restart:')} cd /etc/bunkerweb && docker compose restart`);
			console.log(`  ${c.dim('Stop:')}    ${cmds.down}`);
		}
		console.log('');
		console.log('━'.repeat(60));
		console.log('');
		return 0;
	}

	// Not running. On an interactive terminal (and not forced to status-only
	// with --status), offer the guided installer. Otherwise keep the
	// read-only behavior: print the exact manual bring-up commands so
	// scripts / non-TTY callers still get actionable output.
	if (own) {
		console.log(
			loc.ambiguous
				? `  Found several BunkerWeb containers on this server (${loc.names.join(', ')}) and could not tell which one is the public one, so nothing was changed.`
				: `  BunkerWeb on this server runs from its own setup (${loc.edge}${ref ? `, Docker Compose project "${ref.project}"` : ''}), so Morphit will not install a second copy.`
		);
		if (!loc.ambiguous) {
			console.log(`  ${c.bold('Start it, on this server:')}`);
			console.log(
				`        ${ownCmd(['up', '-d', '--no-deps'], `sudo docker start ${loc.names.join(' ')}`)}`
			);
			console.log(`  ${c.dim('Watch it live (on this server; nothing is stored):')} ${liveView}`);
		}
		console.log('');
		console.log('━'.repeat(60));
		console.log('');
		return 1;
	}

	const interactive = process.stdin.isTTY === true && ctx.flags.status !== 'true';
	if (interactive) {
		console.log('━'.repeat(60));
		console.log('');
		return await runBunkerwebInstaller(ctx, c, hasDocker, verdict);
	}

	if (verdict.kind !== 'docker-missing') {
		console.log(`  ${c.bold('Bring BunkerWeb up:')}`);
		for (const line of cmds.bringUp) console.log(`        ${line}`);
		console.log('');
		console.log(`  ${c.dim('Then re-run `morphit-ops bunkerweb` to confirm health.')}`);
		console.log('  Full guide: ops/bunkerweb/README.md, OPERATIONS.md §32.');
	} else {
		const g = dockerInstallGuidance();
		console.log(`  ${c.bold('Install Docker first:')}`);
		for (const line of g.official) console.log(`        ${line}`);
		console.log('');
		console.log(`  ${c.dim('Then re-run `morphit-ops bunkerweb` to install + bring up the WAF.')}`);
		console.log(`  ${c.dim(`Docker docs: ${g.docs}`)}`);
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log('');
	return 1;
}

/** Guided, confirmation-gated BunkerWeb install + bring-up. Returns 0 when
 *  the stack ends up running, 1 otherwise (or when the operator declines).
 *  Best-effort and chatty: every host-mutating step is explained and
 *  confirmed, and runs via `sudo` when not already root. */
async function runBunkerwebInstaller(
	ctx: BunkerWebCtx,
	c: ReturnType<typeof color>,
	hasDocker: boolean,
	_verdict: BunkerWebVerdict
): Promise<number> {
	const installDir = installDirFromEnv(process.env);
	const srcDir = join(installDir, 'ops', 'bunkerweb');
	const dstDir = '/etc/bunkerweb';
	const envPath = join(dstDir, 'bunkerweb.env');
	const composePath = join(dstDir, 'docker-compose.yml');

	const manualBailout = (): number => {
		const cmds = bunkerwebCommands();
		console.log('');
		console.log(`  ${c.bold('No problem — here are the manual steps:')}`);
		for (const line of cmds.bringUp) console.log(`        ${line}`);
		console.log('');
		console.log('  Full guide: ops/bunkerweb/README.md, OPERATIONS.md §32.');
		console.log('');
		return 1;
	};

	explain(
		'BunkerWeb is the web firewall that sits in front of your site: it\n' +
			'terminates HTTPS, runs the OWASP rule set, rate-limits abuse, and\n' +
			'proxies everything to your Morphit frontend. I can install and start\n' +
			`it for you now using the bundled config (image ${BUNKERWEB_IMAGE}).\n` +
			'\n' +
			"I'll explain each step and ask before doing anything that changes\n" +
			'your system. Steps that need admin rights will use sudo (you may be\n' +
			'asked for your password).'
	);
	if (!(await askYesNo('Install + start BunkerWeb now?', true))) return manualBailout();

	// ── Preconditions → plan ────────────────────────────────────────
	if (!existsSync(srcDir)) {
		console.log('');
		console.log(`  ${c.red('✗')} Could not find the bundled BunkerWeb config at ${srcDir}.`);
		console.log('      That directory ships inside the Morphit repo. If you installed');
		console.log('      Morphit somewhere other than /opt/morphit, set MORPHIT_INSTALL_DIR');
		console.log('      to your install path and re-run.');
		console.log('');
		return 1;
	}

	const composePresent = hasDocker ? await dockerComposePresent() : false;
	const plan = planBunkerwebInstall({
		dockerPresent: hasDocker,
		composePresent,
		alreadyFullyRunning: false, // we only get here when NOT fully running
		configDirExists: existsSync(dstDir)
	});

	// ── 1. Docker + compose ─────────────────────────────────────────
	if (plan.needDocker) {
		const g = dockerInstallGuidance();
		explain(
			'BunkerWeb runs as Docker containers, but Docker (or the\n' +
				"`docker compose` plugin) isn't available yet. The recommended way\n" +
				"to install it is from your distro's packages:\n" +
				'\n' +
				g.official.map((l) => `  ${l}`).join('\n')
		);
		let dockerReady = false;
		if (await askYesNo('Install Docker now using the apt packages above?', true)) {
			await runHostCmd('apt-get', ['update']);
			await runHostCmd('apt-get', ['install', '-y', 'docker.io', 'docker-compose-v2']);
			await runHostCmd('systemctl', ['enable', '--now', 'docker']);
			dockerReady = (await dockerPresent()) && (await dockerComposePresent());
			if (!dockerReady) {
				console.log(
					`  ${c.yellow('⚠')} Docker still isn\'t fully available after the install attempt.`
				);
			}
		}
		if (!dockerReady) {
			console.log('');
			console.log(`  ${c.red('✗')} Docker isn\'t ready, so I can\'t bring BunkerWeb up. Install`);
			console.log(`      Docker (see ${g.docs}) and re-run \`morphit-ops bunkerweb\`.`);
			console.log('');
			return 1;
		}
		console.log(`  ${c.green('✓')} Docker is ready.`);
	}

	// ── 2. Config: copy ops/bunkerweb → /etc/bunkerweb ──────────────
	if (plan.copyConfig) {
		explain(
			`I\'ll copy the bundled config from ${srcDir} to ${dstDir} (this is\n` +
				'where the compose file and the bunkerweb.env settings live). Your\n' +
				'edits there survive Morphit upgrades.'
		);
		if (!(await askYesNo(`Copy the config to ${dstDir}?`, true))) return manualBailout();
		if ((await runHostCmd('cp', ['-r', srcDir, dstDir])) !== 0) {
			console.log(`  ${c.red('✗')} Couldn\'t copy the config to ${dstDir}.`);
			return 1;
		}
		// The bundled bunkerweb.env.example is the template — make it the live
		// bunkerweb.env if the copy didn't already include one.
		if (!existsSync(envPath)) {
			await runHostCmd('cp', [join(dstDir, 'bunkerweb.env.example'), envPath]);
		}
		// If Morphit lives somewhere other than /opt/morphit, the compose's
		// frontend bind-mount path is wrong (it would serve an empty site).
		// Offer to fix that one line.
		if (installDir !== '/opt/morphit') {
			const composeText = await readMaybeSudo(composePath);
			if (composeText !== null) {
				const fixed = setFrontendBuildPath(composeText, installDir);
				if (fixed.changed) {
					explain(
						`Your install is at ${installDir}, not /opt/morphit, so the paths the\n` +
							'compose file mounts from Morphit (the site build, its nginx config and\n' +
							"the scheduler's job lists) need to match, or the site would serve empty\n" +
							'and the scheduler would not start. I can update them for you.'
					);
					if (await askYesNo('Fix the Morphit paths in docker-compose.yml?', true)) {
						if (await writeMaybeSudo(composePath, fixed.text)) {
							console.log(`  ${c.green('✓')} Updated the Morphit paths to ${installDir}.`);
						} else {
							console.log(
								`  ${c.yellow('⚠')} Couldn\'t update it automatically — edit ${composePath}`
							);
							console.log(
								`      and replace /opt/morphit/ with ${installDir}/ in its bind-mounts.`
							);
						}
					}
				}
			}
		}
		console.log(`  ${c.green('✓')} Config installed at ${dstDir}.`);
	} else if (plan.reuseExistingConfig) {
		console.log('');
		console.log(`  ${c.dim(`Reusing your existing ${dstDir} (I won\'t overwrite your edits).`)}`);
	}

	// ── 3. SERVER_NAME ──────────────────────────────────────────────
	const envText = await readMaybeSudo(envPath);
	if (envText === null) {
		console.log(`  ${c.red('✗')} Couldn\'t read ${envPath}.`);
		return 1;
	}
	const existing = currentServerName(envText) ?? '';
	const existingOk = existing !== '' && !isPlaceholderServerName(existing);
	let domain = existing;
	if (existingOk) {
		explain(`The configured domain (SERVER_NAME) is currently: ${existing}`);
		if (await askYesNo(`Keep ${existing} as the public domain?`, true)) {
			domain = existing;
		} else {
			domain = '';
		}
	}
	if (!existingOk || domain === '') {
		explain(
			'What is the public domain this instance will serve on? This must be\n' +
				'the domain your DNS points at this server, and the one your HTTPS\n' +
				'certificate is for (e.g. trade.example.org).'
		);
		// loop until valid
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const entered = await ask('Public domain', existingOk ? existing : undefined);
			const v = validateServerName(entered);
			if (v.ok) {
				domain = entered;
				break;
			}
			console.log(`  ${c.red('✗')} ${v.reason}. Try again.\n`);
		}
		const next = setServerName(envText, domain);
		if (next.changed) {
			if (await writeMaybeSudo(envPath, next.text)) {
				console.log(`  ${c.green('✓')} SERVER_NAME set to ${domain}.`);
			} else {
				console.log(`  ${c.red('✗')} Couldn\'t write ${envPath}.`);
				return 1;
			}
		}
	}

	// ── 4. Cert prerequisite (the crash-loop guard) ─────────────────
	const certs = certPathsForServerName(domain);
	if (!existsSync(certs.fullchain)) {
		console.log('');
		console.log(`  ${c.yellow('⚠')} No HTTPS certificate found at ${certs.fullchain}.`);
		explain(
			"\nBunkerWeb is configured to use a Let's Encrypt certificate for that\n" +
				"domain, and it will CRASH-LOOP on startup if the certificate isn't\n" +
				'there yet. The fix is to obtain the certificate first:\n' +
				'\n' +
				'  • run `morphit-ops ssl` for guided certificate setup, then\n' +
				'  • re-run `morphit-ops bunkerweb` to finish bringing the WAF up.'
		);
		if (!(await askYesNo('Continue and start BunkerWeb anyway (NOT recommended)?', false))) {
			console.log('');
			console.log(`  ${c.dim('Stopped before bring-up. Get the cert, then re-run.')}`);
			console.log('');
			return 1;
		}
	}

	// ── 5. Pull + up ────────────────────────────────────────────────
	const gidEnv = await ensureDockerGidEnv(dstDir);
	if (!gidEnv.ok) {
		console.log(`  ${c.red('✗')} ${gidEnv.detail}.`);
		console.log(
			`      On this server run:  echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" | sudo tee -a ${dstDir}/.env`
		);
		return 1;
	}
	console.log(`  ${c.dim(gidEnv.detail)}`);
	explain(
		"Now I'll download the BunkerWeb images and start the stack. The\n" +
			'first pull can take a few minutes depending on your connection.'
	);
	if (await askYesNo('Download the images now (docker compose pull)?', true)) {
		await runHostCmd('docker', ['compose', '-f', composePath, 'pull']);
	}
	if (!(await askYesNo('Start BunkerWeb now (docker compose up -d)?', true))) {
		return manualBailout();
	}
	const upStatus = await runHostCmd('docker', ['compose', '-f', composePath, 'up', '-d']);
	if (upStatus !== 0) {
		console.log('');
		console.log(`  ${c.red('✗')} \`docker compose up -d\` failed (exit ${upStatus}).`);
		console.log(
			`      On this server, check the scheduler + frontend logs:  cd ${dstDir} && docker compose logs -f bunkerweb-scheduler frontend`
		);
		console.log(
			`      BunkerWeb itself stores no logs; watch it live:  ${BUNKERWEB_LIVE_VIEW}  (Ctrl-C detaches)`
		);
		console.log('');
		return 1;
	}

	// ── 6. Re-check health ──────────────────────────────────────────
	const stopCheck = startDotsSpinner('Checking the BunkerWeb containers…');
	const states2 = await Promise.all(BUNKERWEB_CONTAINERS.map((n) => inspectContainer(n))).finally(
		stopCheck
	);
	const verdict2 = bunkerwebVerdict(true, states2);
	console.log('');
	console.log('━'.repeat(60));
	if (verdict2.kind === 'running') {
		console.log(`  ${c.green('✓')} ${verdict2.message} BunkerWeb is up.`);
		console.log('');
		console.log(
			`  ${c.dim('Live view (on this server; nothing is stored):')} ${BUNKERWEB_LIVE_VIEW}`
		);
		console.log(`  ${c.dim('  (Ctrl-C detaches; the container keeps running.)')}`);
		console.log(`  ${c.dim('Restart:')} cd ${dstDir} && docker compose restart`);
		console.log('');
		console.log('  Verify on a real request: load your site, then check');
		console.log('  /relay/v1/health and /v1/instance. See OPERATIONS.md §32.');
		console.log('━'.repeat(60));
		console.log('');
		return 0;
	}
	console.log(`  ${c.yellow('⚠')} ${verdict2.message}`);
	console.log('');
	console.log(`      Containers are still settling. Check health in a moment with`);
	console.log(
		`      \`morphit-ops bunkerweb\`, or on this server watch BunkerWeb live (Ctrl-C detaches):`
	);
	console.log(`      ${BUNKERWEB_LIVE_VIEW}`);
	console.log(
		`      (scheduler + frontend logs still work: cd ${dstDir} && docker compose logs -f bunkerweb-scheduler frontend)`
	);
	console.log('━'.repeat(60));
	console.log('');
	return 1;
}
