/**
 * `morphit-ops bunkerweb` (beta5 item H; guided installer added beta11).
 *
 * Morphit ships a turnkey BunkerWeb deployment (ops/bunkerweb/, an Ansible
 * role, and wizard Step 21). This command both CHECKS that WAF and, on a
 * TTY, INSTALLS + brings it up for the operator:
 *
 *   - READ-ONLY status (always, and the only behavior under --json or when
 *     stdin isn't a TTY): is Docker present, are the `bunkerweb` and
 *     `bunkerweb-scheduler` containers running + healthy? Exits 0 when
 *     running, 1 otherwise — suitable for monitoring.
 *   - GUIDED INSTALLER (interactive default when NOT already running):
 *     plain-English, confirmation-gated steps that
 *       1. ensure Docker + the compose v2 plugin are present (guide the
 *          install — official apt route, or an explicit-opt-in get.docker.com),
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
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BunkerWebCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** The two containers the shipped compose file defines. */
export const BUNKERWEB_CONTAINERS = ['bunkerweb', 'bunkerweb-scheduler'] as const;

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

export type BunkerWebKind =
	| 'docker-missing'
	| 'not-running'
	| 'partial'
	| 'unhealthy'
	| 'running';

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
			message: 'BunkerWeb is not running (no bunkerweb containers found). Bring it up with the commands below.'
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

/** Operator commands matching wizard Step 21 + ops/bunkerweb/README.md.
 *  PURE. */
export function bunkerwebCommands(): BunkerWebCommands {
	return {
		bringUp: [
			'sudo cp -r ops/bunkerweb /etc/bunkerweb',
			'# edit /etc/bunkerweb/bunkerweb.env — set SERVER_NAME to your domain',
			'cd /etc/bunkerweb && docker compose up -d'
		],
		status: 'cd /etc/bunkerweb && docker compose ps',
		logs: 'cd /etc/bunkerweb && docker compose logs -f bunkerweb',
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
	if (/^https?:\/\//i.test(d)) return { ok: false, reason: 'looks like a URL — enter just the hostname (no https://)' };
	if (d.includes('/')) return { ok: false, reason: 'contains "/" — enter just the hostname' };
	if (!d.includes('.')) return { ok: false, reason: 'not a fully-qualified domain (needs a dot, e.g. trade.example.org)' };
	if (!/^[a-z0-9.-]+$/i.test(d)) return { ok: false, reason: 'has characters not valid in a hostname' };
	if (isPlaceholderServerName(d)) return { ok: false, reason: 'still the example placeholder — use your real domain' };
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
	if (!composeText.includes(canonical)) return { text: composeText, changed: false };
	const replacement = `${installDir}/apps/web/build:/usr/share/nginx/html`;
	return { text: composeText.split(canonical).join(replacement), changed: true };
}

export interface DockerInstallGuidance {
	/** The official, distro-package route (preferred — gets security updates). */
	readonly official: readonly string[];
	/** The upstream convenience script (one command, but pipes a remote
	 *  script to root — offered only behind an explicit default-NO prompt). */
	readonly convenience: string;
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
		convenience: 'curl -fsSL https://get.docker.com | sudo sh',
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
	const { spawnSync } = await import('node:child_process');
	const r = spawnSync(
		'docker',
		[
			'inspect',
			'--format',
			'{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
			name
		],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
	);
	if (r.status !== 0) return { name, present: false, status: 'absent', health: 'none' };
	return parseContainerState(name, typeof r.stdout === 'string' ? r.stdout : '');
}

/** Best-effort: is the `docker compose` v2 plugin usable? IMPURE. */
async function dockerComposePresent(): Promise<boolean> {
	const { spawnSync } = await import('node:child_process');
	return (
		spawnSync('docker', ['compose', 'version'], { stdio: 'pipe', timeout: 5000 }).status === 0
	);
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

// ─── Command ────────────────────────────────────────────────────────

function color(enabled: boolean) {
	const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
	return { green: wrap('32'), yellow: wrap('33'), red: wrap('31'), dim: wrap('2'), bold: wrap('1') };
}

export async function runBunkerWeb(ctx: BunkerWebCtx): Promise<number> {
	const c = color(ctx.colorEnabled);
	const json = ctx.flags.json === 'true';

	const hasDocker = await dockerPresent();
	const states = hasDocker
		? await Promise.all(BUNKERWEB_CONTAINERS.map((n) => inspectContainer(n)))
		: BUNKERWEB_CONTAINERS.map((n) => ({ name: n, present: false, status: 'absent', health: 'none' }));
	const verdict = bunkerwebVerdict(hasDocker, states);
	const cmds = bunkerwebCommands();

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
		console.log(`  ${c.dim('Logs:')}    ${cmds.logs}`);
		console.log(`  ${c.dim('Restart:')} cd /etc/bunkerweb && docker compose restart`);
		console.log(`  ${c.dim('Stop:')}    ${cmds.down}`);
		console.log('');
		console.log('━'.repeat(60));
		console.log('');
		return 0;
	}

	// Not running. On an interactive terminal (and not forced to status-only
	// with --status), offer the guided installer. Otherwise keep the
	// read-only behavior: print the exact manual bring-up commands so
	// scripts / non-TTY callers still get actionable output.
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
			'I\'ll explain each step and ask before doing anything that changes\n' +
			'your system. Steps that need admin rights will use sudo (you may be\n' +
			'asked for your password).'
	);
	if (!(await askYesNo('Install + start BunkerWeb now?', true))) return manualBailout();

	// ── Preconditions → plan ────────────────────────────────────────
	if (!existsSync(srcDir)) {
		console.log('');
		console.log(
			`  ${c.red('✗')} Could not find the bundled BunkerWeb config at ${srcDir}.`
		);
		console.log(
			'      That directory ships inside the Morphit repo. If you installed'
		);
		console.log(
			'      Morphit somewhere other than /opt/morphit, set MORPHIT_INSTALL_DIR'
		);
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
				'`docker compose` plugin) isn\'t available yet. The recommended way\n' +
				'to install it is from your distro\'s packages:\n' +
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
			explain(
				'Alternatively, Docker\'s official convenience script installs the\n' +
					'latest Docker in one command. It pipes a remote script to a root\n' +
					`shell, so only use it if you trust it:\n\n  ${g.convenience}`
			);
			if (await askYesNo('Run the get.docker.com convenience script instead?', false)) {
				// curl … | sudo sh — run via a shell so the pipe works.
				await runHostCmd('sh', ['-c', 'curl -fsSL https://get.docker.com | sudo sh']);
				dockerReady = (await dockerPresent()) && (await dockerComposePresent());
			}
		}
		if (!dockerReady) {
			console.log('');
			console.log(
				`  ${c.red('✗')} Docker isn\'t ready, so I can\'t bring BunkerWeb up. Install`
			);
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
						`Your install is at ${installDir}, not /opt/morphit, so the\n` +
							'frontend build path in the compose file needs to match or the\n' +
							'site would serve empty. I can update that one line for you.'
					);
					if (await askYesNo('Fix the frontend build path in docker-compose.yml?', true)) {
						if (await writeMaybeSudo(composePath, fixed.text)) {
							console.log(`  ${c.green('✓')} Updated the frontend build path.`);
						} else {
							console.log(
								`  ${c.yellow('⚠')} Couldn\'t update it automatically — edit ${composePath}`
							);
							console.log(`      and set the frontend bind-mount to ${installDir}/apps/web/build.`);
						}
					}
				}
			}
		}
		console.log(`  ${c.green('✓')} Config installed at ${dstDir}.`);
	} else if (plan.reuseExistingConfig) {
		console.log('');
		console.log(
			`  ${c.dim(`Reusing your existing ${dstDir} (I won\'t overwrite your edits).`)}`
		);
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
			'\nBunkerWeb is configured to use a Let\'s Encrypt certificate for that\n' +
				'domain, and it will CRASH-LOOP on startup if the certificate isn\'t\n' +
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
	explain(
		'Now I\'ll download the BunkerWeb images and start the stack. The\n' +
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
		console.log(`      Check the logs:  cd ${dstDir} && docker compose logs -f`);
		console.log('');
		return 1;
	}

	// ── 6. Re-check health ──────────────────────────────────────────
	const states2 = await Promise.all(BUNKERWEB_CONTAINERS.map((n) => inspectContainer(n)));
	const verdict2 = bunkerwebVerdict(true, states2);
	console.log('');
	console.log('━'.repeat(60));
	if (verdict2.kind === 'running') {
		console.log(`  ${c.green('✓')} ${verdict2.message} BunkerWeb is up.`);
		console.log('');
		console.log(`  ${c.dim('Logs:')}    cd ${dstDir} && docker compose logs -f bunkerweb`);
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
	console.log(`      \`morphit-ops bunkerweb\`, or watch the logs:`);
	console.log(`      cd ${dstDir} && docker compose logs -f`);
	console.log('━'.repeat(60));
	console.log('');
	return 1;
}
