/**
 * `morphit-ops bunkerweb` (beta5 item H) — BunkerWeb WAF status.
 *
 * Morphit already ships a turnkey BunkerWeb deployment (ops/bunkerweb/,
 * an Ansible role, and wizard Step 21). What was missing was a way to
 * answer "is my WAF actually up and healthy?" — so this command:
 *
 *   - READ-ONLY status: is Docker present, are the `bunkerweb` and
 *     `bunkerweb-scheduler` containers running, and are they healthy?
 *   - If not running, prints the exact bring-up commands (matching
 *     Step 21 + ops/bunkerweb/README.md). If running, prints the
 *     logs / restart / down commands.
 *
 * It does NOT run `docker compose` itself — bringing containers up
 * mutates the host and can't be validated from here (same hands-on
 * boundary as cert issuance + service install). BunkerWeb's Docker
 * IMAGES are deliberately NOT bundled with Morphit; they're pulled
 * from BunkerWeb's own registry.
 */

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

	if (verdict.kind === 'running') {
		console.log(`  ${c.dim('Logs:')}    ${cmds.logs}`);
		console.log(`  ${c.dim('Restart:')} cd /etc/bunkerweb && docker compose restart`);
		console.log(`  ${c.dim('Stop:')}    ${cmds.down}`);
	} else if (verdict.kind !== 'docker-missing') {
		console.log(`  ${c.bold('Bring BunkerWeb up:')}`);
		for (const line of cmds.bringUp) console.log(`        ${line}`);
		console.log('');
		console.log(`  ${c.dim('Then re-run `morphit-ops bunkerweb` to confirm health.')}`);
		console.log('  Full guide: ops/bunkerweb/README.md, OPERATIONS.md §32.');
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log('');
	return verdict.kind === 'running' ? 0 : 1;
}
