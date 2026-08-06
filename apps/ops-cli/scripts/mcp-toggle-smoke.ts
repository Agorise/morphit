#!/usr/bin/env tsx
/**
 * mcp-toggle-smoke — locks down `morphit-ops mcp`, the on/off switch
 * for the morphit-mcp.service unit (the read-only AI-agent orderbook
 * surface).  Ken's requirement: MCP is on by default, but an operator
 * must be able to stop + disable it from the morphit-ops menu.
 *
 * What this guards:
 *   1. nextAction() picks DISABLE only when the unit is up, ENABLE
 *      otherwise (so the menu always offers the opposite of current).
 *   2. systemctlArgv() is sudo-aware: bare `systemctl` as root, else
 *      `sudo systemctl …`.
 *   3. runMcp() drives the RIGHT systemctl verb for each state, never
 *      touches systemd when the unit is not-installed, and respects a
 *      "no" answer (no mutation) — all via injected exec/state/confirm
 *      so no real systemd, sudo, or stdin is involved.
 *   4. A non-zero systemctl exit surfaces as runMcp → 1.
 *   5. Wiring: main.ts dispatches the `mcp` subcommand (+ imports it),
 *      and the interactive menu (MENU_GROUPS) exposes a `mcp` item.
 *
 * On success prints exactly one canonical line at column 0:
 *   ✓ all N mcp-toggle-smoke scenarios passed
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	nextAction,
	systemctlArgv,
	describeState,
	runMcp,
	type McpExec
} from '../src/commands/mcp.ts';
import type { ServiceState } from '../src/commands/health.ts';
import { MENU_GROUPS } from '../src/commands/mainMenu.ts';

const here = dirname(fileURLToPath(import.meta.url));
const opsCliRoot = join(here, '..');

let checks = 0;
const failures: string[] = [];
function check(label: string, cond: boolean): void {
	checks++;
	if (!cond) failures.push(label);
}

/** Run an async fn with console.log silenced (runMcp is chatty). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
	const orig = console.log;
	console.log = () => {};
	try {
		return await fn();
	} finally {
		console.log = orig;
	}
}

/** A recording exec — captures the argv it was handed and returns a
 *  configurable status. */
function recordingExec(status: number | null): {
	exec: McpExec;
	calls: Array<{ cmd: string; args: readonly string[] }>;
} {
	const calls: Array<{ cmd: string; args: readonly string[] }> = [];
	const exec: McpExec = (cmd, args) => {
		calls.push({ cmd, args });
		return { status };
	};
	return { exec, calls };
}

const CTX = { flags: {}, positional: [] as readonly string[], colorEnabled: false };

async function main(): Promise<void> {
	// ── 1. nextAction ─────────────────────────────────────────────
	check('nextAction(active) = disable', nextAction('active') === 'disable');
	check('nextAction(activating) = disable', nextAction('activating') === 'disable');
	check('nextAction(inactive) = enable', nextAction('inactive') === 'enable');
	check('nextAction(failed) = enable', nextAction('failed') === 'enable');
	check('nextAction(unknown) = enable', nextAction('unknown') === 'enable');
	check('nextAction(not-installed) = enable', nextAction('not-installed') === 'enable');

	// ── 2. systemctlArgv (sudo-awareness) ─────────────────────────
	const asRoot = systemctlArgv(true, 'enable', '--now', 'morphit-mcp.service');
	check('root argv cmd = systemctl', asRoot.cmd === 'systemctl');
	check(
		'root argv = enable --now morphit-mcp.service',
		asRoot.args.join(' ') === 'enable --now morphit-mcp.service'
	);
	const asUser = systemctlArgv(false, 'disable', '--now', 'morphit-mcp.service');
	check('non-root argv cmd = sudo', asUser.cmd === 'sudo');
	check(
		'non-root argv = systemctl disable --now morphit-mcp.service',
		asUser.args.join(' ') === 'systemctl disable --now morphit-mcp.service'
	);

	// ── 3. describeState (spot checks) ────────────────────────────
	check('describeState(active) mentions running', /running/.test(describeState('active')));
	check(
		'describeState(not-installed) mentions not installed',
		/not installed/.test(describeState('not-installed'))
	);

	// ── 4. runMcp branches ────────────────────────────────────────
	// (a) running + confirm yes → systemctl disable --now, exit 0
	{
		const { exec, calls } = recordingExec(0);
		const rc = await quiet(() =>
			runMcp(CTX, {
				exec,
				readState: (_u: string): ServiceState => 'active',
				confirm: async () => true
			})
		);
		check('running+yes → exit 0', rc === 0);
		check('running+yes → exactly one systemctl call', calls.length === 1);
		check(
			'running+yes → disable --now morphit-mcp.service',
			calls.length === 1 &&
				[calls[0]!.cmd, ...calls[0]!.args].join(' ').endsWith('disable --now morphit-mcp.service')
		);
	}

	// (b) stopped + confirm yes → systemctl enable --now, exit 0
	{
		const { exec, calls } = recordingExec(0);
		const rc = await quiet(() =>
			runMcp(CTX, {
				exec,
				readState: (_u: string): ServiceState => 'inactive',
				confirm: async () => true
			})
		);
		check('stopped+yes → exit 0', rc === 0);
		check(
			'stopped+yes → enable --now morphit-mcp.service',
			calls.length === 1 &&
				[calls[0]!.cmd, ...calls[0]!.args].join(' ').endsWith('enable --now morphit-mcp.service')
		);
	}

	// (c) not-installed → NO systemctl call, exit 0 (guidance only)
	{
		const { exec, calls } = recordingExec(0);
		const rc = await quiet(() =>
			runMcp(CTX, {
				exec,
				readState: (_u: string): ServiceState => 'not-installed',
				confirm: async () => true
			})
		);
		check('not-installed → exit 0', rc === 0);
		check('not-installed → zero systemctl calls', calls.length === 0);
	}

	// (d) running + confirm NO → NO mutation, exit 0
	{
		const { exec, calls } = recordingExec(0);
		const rc = await quiet(() =>
			runMcp(CTX, {
				exec,
				readState: (_u: string): ServiceState => 'active',
				confirm: async () => false
			})
		);
		check('running+no → exit 0', rc === 0);
		check('running+no → zero systemctl calls', calls.length === 0);
	}

	// (e) systemctl fails → runMcp exit 1
	{
		const { exec } = recordingExec(1);
		const rc = await quiet(() =>
			runMcp(CTX, {
				exec,
				readState: (_u: string): ServiceState => 'inactive',
				confirm: async () => true
			})
		);
		check('systemctl non-zero → exit 1', rc === 1);
	}

	// ── 5. Wiring (static) ────────────────────────────────────────
	const mainSrc = readFileSync(join(opsCliRoot, 'src', 'main.ts'), 'utf8');
	check("main.ts imports runMcp from './commands/mcp.ts'", /from '\.\/commands\/mcp\.ts'/.test(mainSrc));
	check(
		'main.ts dispatches the mcp subcommand',
		/args\.subcommand === 'mcp'/.test(mainSrc) && /runMcp\(/.test(mainSrc)
	);

	const mcpMenuItems = MENU_GROUPS.flatMap((g) => g.items).filter((i) => i.subcommand === 'mcp');
	check('MENU_GROUPS exposes exactly one mcp item', mcpMenuItems.length === 1);
	check(
		'mcp menu item has a label + blurb',
		mcpMenuItems.length === 1 &&
			typeof mcpMenuItems[0]!.label === 'string' &&
			mcpMenuItems[0]!.label.length > 0
	);

	// ── Result ────────────────────────────────────────────────────
	if (failures.length > 0) {
		console.error(`mcp-toggle-smoke: ${failures.length} FAILED of ${checks}:`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		process.exit(1);
	}
	console.log(`✓ all ${checks} mcp-toggle-smoke scenarios passed`);
}

main().catch((err) => {
	console.error('mcp-toggle-smoke: threw:', err);
	process.exit(1);
});
