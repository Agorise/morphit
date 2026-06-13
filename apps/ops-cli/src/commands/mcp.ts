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
 * relay keys — REVISIT-LIST §isolation).  Standing up or removing
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

import { askYesNo } from '../init/prompt.ts';
import { checkService, type ServiceState } from './health.ts';

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
			return 'failed (crashed — see `journalctl -u morphit-mcp`)';
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
	const paint = (open: string, s: string): string => (ctx.colorEnabled ? `${open}${s}\u001b[0m` : s);
	const bold = (s: string): string => paint('\u001b[1m', s);
	const dim = (s: string): string => paint('\u001b[2m', s);
	const green = (s: string): string => paint('\u001b[32m', s);
	const yellow = (s: string): string => paint('\u001b[33m', s);

	const state = readState('morphit-mcp');

	console.log('');
	console.log(bold('MCP server (Model Context Protocol — AI-agent orderbook surface)'));
	console.log(`  Unit:   ${UNIT}`);
	console.log(`  Status: ${state === 'active' ? green(describeState(state)) : describeState(state)}`);
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

	const action = nextAction(state);
	const root = isRoot();

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
		const { cmd, args } = systemctlArgv(root, 'disable', '--now', UNIT);
		const { status } = exec(cmd, args);
		console.log('');
		if (status === 0) {
			console.log(green('  ✓ MCP server stopped and disabled.'));
			console.log(dim('    Re-enable later with: morphit-ops mcp'));
			console.log('');
			return 0;
		}
		console.log(yellow('  ✗ Could not disable the unit.'));
		console.log(
			'    Run it manually:\n' +
				`      ${root ? '' : 'sudo '}systemctl disable --now ${UNIT}`
		);
		console.log('');
		return 1;
	}

	// action === 'enable'
	console.log(
		dim(
			'  Enabling starts the MCP server now AND sets it to start at every\n' +
				'  boot.  It binds to 127.0.0.1:8124 (loopback only) — reverse-proxy\n' +
				'  /mcp/* via nginx/BunkerWeb if you want public AI-agent exposure.\n' +
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
	const { cmd, args } = systemctlArgv(root, 'enable', '--now', UNIT);
	const { status } = exec(cmd, args);
	console.log('');
	if (status === 0) {
		console.log(green('  ✓ MCP server enabled and started.'));
		console.log(
			dim('    Confirm health with: morphit-ops status   (look for morphit-mcp)')
		);
		console.log('');
		return 0;
	}
	console.log(yellow('  ✗ Could not enable the unit.'));
	console.log(
		'    Run it manually:\n' + `      ${root ? '' : 'sudo '}systemctl enable --now ${UNIT}`
	);
	console.log('');
	return 1;
}
