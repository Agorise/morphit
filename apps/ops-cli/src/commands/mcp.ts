/**
 * morphit-ops mcp — the operator's on/off switch for the Morphit MCP
 * server (`morphit-mcp.service`).
 *
 * The MCP server is a read-only, non-custodial surface that exposes
 * THIS instance's slice of the federated orderbook to AI agents
 * (Claude / ChatGPT / Grok / Perplexity / Cursor / Cline / local LLM
 * stacks) via the Model Context Protocol.  It holds NO keys, signs NO
 * trades, and hands the user off to the web UI for the actual
 * key-signing step — so the zero-KYC + non-custodial invariant is
 * preserved.  It is installed + enabled by default on a fresh node;
 * this command is how an operator turns it OFF later (and back ON):
 * it reads the current service state and offers to stop+disable or
 * enable+start the unit.
 *
 * Scope — deliberately narrow.  This command drives systemd ONLY:
 * `systemctl enable --now` / `systemctl disable --now` on the
 * morphit-mcp.service unit.  It does NOT deploy or tear down the MCP
 * *install* (the isolated `/opt/morphit-mcp` working dir + the
 * low-privilege `morphit-mcp` service user that exists specifically
 * so the MCP process CANNOT read the main install's DB password and
 * relay keys — backlog §isolation).  Standing up or removing
 * that isolated deploy is the installer's job (the Ansible playbook /
 * the documented manual steps); flattening it into this CLI would
 * weaken the least-privilege boundary, so we don't.  If the unit
 * isn't installed at all, this command says so and points at the
 * installer rather than pretending to toggle a unit that isn't there.
 *
 * sudo-awareness: morphit-ops runs sometimes as root and sometimes
 * via sudo, so we shell out to `sudo systemctl …` only when we are
 * NOT already root (mirrors lib/restartServices.ts).  stdio is
 * inherited so any sudo password prompt + systemctl output is visible.
 *
 * Testability: the state read (`checkService`), the process spawn, and
 * the yes/no prompt are all injectable (defaulting to the real
 * implementations) so the decision logic is unit-testable without a
 * live systemd, a real `sudo`, or blocking on stdin.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { askYesNo } from '../init/prompt.ts';
import { checkService, type ServiceState } from './health.ts';
import { systemctlSpinning } from '../lib/spinRun.ts';
import { withSpinner } from '../init/spinner.ts';
import { localIndexerJson } from '../lib/hiddenOnly.ts';
import { buildMcpHealthUrl, classifyMcpHealth, resolveMcpHttpBind } from './upgrade.ts';

/** The unit this command toggles.  `.service` suffix is explicit;
 *  systemctl accepts it with or without, but being explicit keeps the
 *  argv unambiguous in logs. */
const UNIT = 'morphit-mcp.service';

/** A process runner: returns the exit status of `cmd args` (null on a
 *  spawn error, e.g. the binary not found). */
export type McpExec = (cmd: string, args: readonly string[]) => { status: number | null };

/** Real runner — inherits stdio so a sudo prompt + systemctl output
 *  reach the operator's terminal. */
const defaultExec: McpExec = (cmd, args) => {
	const r = spawnSync(cmd, args as string[], { stdio: 'inherit' });
	return { status: r.status };
};

/** True when the current process is uid 0.  `process.getuid` is
 *  undefined on non-POSIX platforms; morphit-ops only ever runs on
 *  Linux servers, but guard anyway so a typo can't throw. */
function isRoot(): boolean {
	return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Build a sudo-aware `systemctl` argv.  When root: `systemctl <args>`.
 * Otherwise: `sudo systemctl <args>`.  Pure — no spawning — so the
 * exact command line is unit-testable.
 */
export function systemctlArgv(
	root: boolean,
	...systemctlArgs: readonly string[]
): { readonly cmd: string; readonly args: readonly string[] } {
	return root
		? { cmd: 'systemctl', args: [...systemctlArgs] }
		: { cmd: 'sudo', args: ['systemctl', ...systemctlArgs] };
}

/**
 * Given the current service state, decide which action this command
 * offers: if the unit is up (active/activating) we offer to turn it
 * OFF; otherwise we offer to turn it ON.  Pure.
 *
 * Note: 'not-installed' is handled by the caller BEFORE this is
 * consulted (we don't offer to enable a unit that isn't on disk), so
 * the natural default here for any non-up state is 'enable'.
 */
export function nextAction(state: ServiceState): 'enable' | 'disable' {
	return state === 'active' || state === 'activating' ? 'disable' : 'enable';
}

/** Human-readable one-liner for a service state (for the status line). */
export function describeState(state: ServiceState): string {
	switch (state) {
		case 'active':
			return 'running';
		case 'activating':
			return 'starting';
		case 'inactive':
			return 'stopped';
		case 'failed':
			return 'keeps crashing (see its last log lines below)';
		case 'not-installed':
			return 'not installed on this host';
		case 'unknown':
		default:
			return 'unknown (is systemd present?)';
	}
}

export interface McpCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** Injectable dependencies — defaulted to the real implementations.
 *  Exposed so the smoke can drive every branch deterministically. */
export interface McpDeps {
	readonly exec?: McpExec;
	readonly readState?: (unit: string) => ServiceState;
	readonly confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
	/** Does the MCP server answer GET /health on its loopback port? */
	readonly probeHealth?: () => Promise<boolean>;
	/** Its last journal lines (null: journalctl could not be read). */
	readonly journalTail?: () => string | null;
	/** The MCP address this node's indexer advertises (/v1/instance mcp_url). */
	readonly advertisedUrl?: () => Promise<string | null>;
	/** How long to watch a just-started unit (default MCP_SETTLE_MS). */
	readonly settleMs?: number;
}

/** How long a just-enabled MCP server is watched for coming up and answering
 *  (`npm start` takes a moment), and how often it is looked at. */
export const MCP_SETTLE_MS = 20_000;
const MCP_POLL_MS = 1_000;

/** The MCP server's env file (its unit's EnvironmentFile, read after the
 *  unit's defaults). MORPHIT_ETC_DIR / MORPHIT_ENV_ROOT relocate it (tests). */
export function mcpEnvPath(): string {
	const etc = process.env.MORPHIT_ETC_DIR ?? `${process.env.MORPHIT_ENV_ROOT ?? ''}/etc/morphit`;
	return join(etc, 'mcp.env');
}

/** Where the MCP server listens, and where this server reaches it.
 *  The unit's default is 127.0.0.1:8124, but /etc/morphit/mcp.env wins: the
 *  installer writes 0.0.0.0 (all addresses — the site's web server in Docker
 *  reaches it across the bridge), and a BunkerWeb host may pin the bridge
 *  address (172.18.0.1). It used to probe 127.0.0.1 always and say "listens on
 *  this server only (127.0.0.1)": a bridge-bound server "did not answer" and
 *  enabling it ended ✗, exit 1. */
export interface McpBind {
	/** As configured (MORPHIT_MCP_HTTP_HOST). */
	readonly host: string;
	readonly port: number;
	/** The address a probe on this server uses (an all-addresses bind is
	 *  reached on loopback). */
	readonly probeHost: string;
	/** Where it listens, in words. */
	readonly where: string;
}

/** PURE given the file's contents (read by resolveMcpHttpBind). */
export function mcpBind(envPath: string = mcpEnvPath()): McpBind {
	const { host, port } = resolveMcpHttpBind(envPath);
	const h = host.replace(/^\[|\]$/g, '');
	const all = h === '0.0.0.0' || h === '::' || h === '';
	const loopback = /^127\./.test(h) || h === '::1' || h === 'localhost';
	const addr = (x: string): string => `${x.includes(':') ? `[${x}]` : x}:${port}`;
	return {
		host: h,
		port,
		probeHost: all ? '127.0.0.1' : h,
		where: all
			? `on all of this server's network addresses (${addr(h || '0.0.0.0')}, set in ${envPath})`
			: loopback
				? `on this server only (${addr(h)})`
				: `on ${addr(h)} (set in ${envPath})`
	};
}

/** The port MCP listens on (see {@link mcpBind}). */
export function mcpPort(): number {
	return mcpBind().port;
}

async function defaultProbeHealth(): Promise<boolean> {
	const b = mcpBind();
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), 3_000);
	try {
		const r = await fetch(buildMcpHealthUrl(b.probeHost, b.port), {
			signal: ac.signal,
			redirect: 'manual'
		});
		return classifyMcpHealth(r.status, (await r.text()).slice(0, 4096)) === 'ok';
	} catch {
		return false;
	} finally {
		clearTimeout(t);
	}
}

function defaultJournalTail(): string | null {
	const r = spawnSync('journalctl', ['-u', UNIT, '-n', '15', '--no-pager', '-o', 'cat'], {
		encoding: 'utf8',
		timeout: 10_000
	});
	return r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() !== ''
		? r.stdout.trimEnd()
		: null;
}

async function defaultAdvertisedUrl(): Promise<string | null> {
	try {
		const b = await localIndexerJson<{ mcp_url?: unknown } | null>(
			'/v1/instance',
			{},
			{ timeoutMs: 4_000 }
		);
		return typeof b?.mcp_url === 'string' ? b.mcp_url : null;
	} catch {
		return null;
	}
}

/**
 * Show the MCP service state and offer to flip it.
 *
 * Exit codes: 0 = state shown / action completed / operator declined;
 * 1 = the systemctl call failed (non-zero / spawn error); 2 = the unit
 * isn't installed (nothing to toggle — caller may surface as guidance).
 * We return 0 for 'not-installed' so a plain `morphit-ops mcp` on a box
 * that never deployed MCP isn't treated as a hard error by scripts; the
 * guidance is printed regardless.
 */
export async function runMcp(ctx: McpCtx, deps: McpDeps = {}): Promise<number> {
	const exec = deps.exec ?? defaultExec;
	const readState = deps.readState ?? checkService;
	const confirm = deps.confirm ?? askYesNo;

	// Tiny color helper — no dependency on any global color state; a
	// no-op when the caller says color is off (piped / --no-color).
	const paint = (open: string, s: string): string =>
		ctx.colorEnabled ? `${open}${s}\u001b[0m` : s;
	const bold = (s: string): string => paint('\u001b[1m', s);
	const dim = (s: string): string => paint('\u001b[2m', s);
	const green = (s: string): string => paint('\u001b[32m', s);
	const yellow = (s: string): string => paint('\u001b[33m', s);

	const state = readState('morphit-mcp');

	console.log('');
	console.log(bold('MCP server (Model Context Protocol — AI-agent orderbook surface)'));
	console.log(`  Unit:   ${UNIT}`);
	console.log(
		`  Status: ${state === 'active' ? green(describeState(state)) : describeState(state)}`
	);
	console.log('');

	if (state === 'not-installed') {
		console.log(
			'  The morphit-mcp unit is not installed on this host, so there is\n' +
				'  nothing to enable or disable yet.  MCP is a separate, isolated\n' +
				'  deploy (its own low-privilege user + working directory so it\n' +
				'  cannot read your DB password or relay keys).  Stand it up with\n' +
				'  the installer (the Ansible playbook deploys + enables it by\n' +
				'  default), then re-run this command to manage it.\n' +
				'  Reference: docs/OPERATIONS.md §45 (MCP server) and\n' +
				'  docs/RUN-A-MORPHIT-NODE.md (AI-agent discovery).'
		);
		console.log('');
		return 0;
	}

	if (state === 'unknown') {
		console.log(
			'  Could not read the service state (systemd not reachable?).\n' +
				'  This command manages a systemd unit, so it only works on the\n' +
				'  host where morphit-mcp.service is installed.'
		);
		console.log('');
		return 1;
	}

	const probeHealth = deps.probeHealth ?? defaultProbeHealth;
	const journalTail = deps.journalTail ?? defaultJournalTail;
	const showJournal = (): void => {
		const tail = journalTail();
		if (tail === null) {
			console.log('    Its log could not be read here; on this server run:');
			console.log('      sudo journalctl -u morphit-mcp -n 50 --no-pager');
			return;
		}
		console.log('    Its last log lines:');
		for (const l of tail.split('\n')) console.log(dim(`      ${l}`));
	};

	const root = isRoot();
	// As root the systemctl call runs under the turning braille spinner (its
	// output shown after). Not as root, `sudo` may ask for a password: the
	// plain inherited call, no spinner over the prompt.
	const runCtl = async (label: string, ...systemctlArgs: string[]): Promise<number | null> => {
		if (deps.exec === undefined && root)
			return (await systemctlSpinning(label, systemctlArgs)).status;
		const { cmd, args } = systemctlArgv(root, ...systemctlArgs);
		return exec(cmd, args).status;
	};

	// Crash-looping (systemd restarting it after each failure): enabling it
	// again would change nothing. Show WHY, and offer to stop the loop.
	if (state === 'failed') {
		console.log(yellow('  The MCP server keeps crashing and being restarted.'));
		showJournal();
		console.log('');
		console.log('    After fixing what the log shows, start it again on this server:');
		console.log('      sudo systemctl restart morphit-mcp');
		console.log('');
		const stop = await confirm('Stop and disable it for now (so it stops restarting)?', false);
		if (!stop) {
			console.log('  No change made.');
			console.log('');
			return 1;
		}
		const st = await runCtl('Stopping and disabling the MCP server…', 'disable', '--now', UNIT);
		console.log('');
		console.log(
			st === 0
				? green('  ✓ MCP server stopped and disabled.')
				: yellow(`  ✗ Could not disable it. On this server: sudo systemctl disable --now ${UNIT}`)
		);
		console.log('');
		return st === 0 ? 0 : 1;
	}

	const action = nextAction(state);

	if (action === 'disable') {
		console.log(
			dim(
				'  Disabling stops the MCP server now AND prevents it from starting\n' +
					'  at the next boot.  Your instance stays fully usable for human\n' +
					'  traders — only the AI-agent discovery surface goes dark.  You\n' +
					'  can re-enable any time by running this command again.'
			)
		);
		console.log('');
		const ok = await confirm('Stop and disable the MCP server now?', false);
		if (!ok) {
			console.log('  Left running.  No change made.');
			console.log('');
			return 0;
		}
		const status = await runCtl('Stopping and disabling the MCP server…', 'disable', '--now', UNIT);
		console.log('');
		if (status === 0) {
			const after = readState('morphit-mcp');
			if (after === 'active' || after === 'activating') {
				console.log(yellow(`  ✗ It still shows as ${describeState(after)} after being stopped.`));
				console.log(`    On this server: sudo systemctl disable --now ${UNIT}`);
				console.log('');
				return 1;
			}
			console.log(green('  ✓ MCP server stopped and disabled (seen stopped).'));
			// The site may still TELL AI agents where MCP is (MORPHIT_MCP_ADVERTISE).
			const advertised = await (deps.advertisedUrl ?? defaultAdvertisedUrl)();
			if (advertised !== null) {
				console.log(
					yellow(
						`  ⚠ Your site still tells AI agents to use ${advertised}, which no longer answers.`
					)
				);
				console.log('    To stop that, on this server: set MORPHIT_MCP_ADVERTISE=false in');
				console.log('    /etc/morphit/indexer.env (sudo nano /etc/morphit/indexer.env), then:');
				console.log('      sudo systemctl restart morphit-indexer');
			}
			console.log(dim('    Turn it back on any time, on this server: sudo morphit-ops mcp'));
			console.log('');
			return 0;
		}
		console.log(yellow('  ✗ Could not disable the unit.'));
		console.log(`    On this server: sudo systemctl disable --now ${UNIT}`);
		console.log('');
		return 1;
	}

	// action === 'enable'
	const bind = mcpBind();
	console.log(
		dim(
			'  Enabling starts the MCP server now AND sets it to start at every\n' +
				`  boot.  It listens ${bind.where};\n` +
				"  your site's web server passes https://<your site>/mcp to it.\n" +
				'  Read-only and non-custodial: it holds no keys and signs nothing.'
		)
	);
	console.log('');
	const ok = await confirm('Enable and start the MCP server now?', true);
	if (!ok) {
		console.log('  Left disabled.  No change made.');
		console.log('');
		return 0;
	}
	const status = await runCtl('Enabling and starting the MCP server…', 'enable', '--now', UNIT);
	console.log('');
	if (status === 0) {
		// Type=simple: `enable --now` returns as soon as the process is started,
		// whether or not it stays up. Watch it come up and answer.
		const at = `${bind.probeHost.includes(':') ? `[${bind.probeHost}]` : bind.probeHost}:${bind.port}`;
		const settleMs = deps.settleMs ?? MCP_SETTLE_MS;
		const seen = await withSpinner('Checking the MCP server comes up and answers…', async () => {
			const until = Date.now() + settleMs;
			for (;;) {
				const st = readState('morphit-mcp');
				if (st === 'failed' || st === 'inactive') return { st, answers: false };
				if (st === 'active' && (await probeHealth())) return { st, answers: true };
				if (Date.now() >= until) return { st, answers: false };
				await new Promise((r) =>
					setTimeout(r, Math.min(MCP_POLL_MS, Math.max(0, until - Date.now())))
				);
			}
		});
		if (seen.answers) {
			console.log(green(`  ✓ MCP server enabled, running and answering on ${at}.`));
			console.log(dim('    To check it later, on this server: sudo morphit-ops health'));
			console.log('');
			return 0;
		}
		console.log(
			yellow(
				seen.st === 'active' || seen.st === 'activating'
					? `  ✗ The MCP server was started but does not answer on ${at} (it listens ${bind.where}).`
					: '  ✗ The MCP server was started but did not stay up.'
			)
		);
		showJournal();
		console.log(
			'    After fixing what the log shows, on this server: sudo systemctl restart morphit-mcp'
		);
		console.log('');
		return 1;
	}
	console.log(yellow('  ✗ Could not enable the unit.'));
	console.log(`    On this server: sudo systemctl enable --now ${UNIT}`);
	console.log('');
	return 1;
}
