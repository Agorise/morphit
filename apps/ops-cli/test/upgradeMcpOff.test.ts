/**
 * The MCP server and the upgrade (v1.21.17 audit, D-H3). Menu 17 turns the MCP
 * off with `systemctl disable --now morphit-mcp`; the upgrade only checked that
 * the unit file exists, then restarted it and said "Started morphit-mcp (it was
 * not previously active)" — undoing the operator's choice at every upgrade.
 * And a Type=simple unit's restart "succeeds" even when it crashes at once.
 * The real step runs with a stand-in systemctl and deploy script.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stub } from './helpers/pty.ts';

const saved = { PATH: process.env.PATH, SD: process.env.MORPHIT_SYSTEMD_DIR };
const dirs: string[] = [];
afterEach(() => {
	process.env.PATH = saved.PATH;
	if (saved.SD === undefined) delete process.env.MORPHIT_SYSTEMD_DIR;
	else process.env.MORPHIT_SYSTEMD_DIR = saved.SD;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** `enabled`: what is-enabled says; `activeAfterStart`: whether it runs once started. */
async function step(enabled: string, activeAfterStart: boolean) {
	const d = mkdtempSync(join(tmpdir(), 'mcp-off-'));
	dirs.push(d);
	const bin = join(d, 'bin');
	mkdirSync(bin);
	const calls = join(d, 'calls');
	writeFileSync(calls, '');
	const started = join(d, 'started');
	stub(
		bin,
		'systemctl',
		[
			`echo "$*" >> '${calls}'`,
			'case "$1" in',
			`  is-enabled) echo ${enabled}; [ ${enabled} = enabled ] ;;`,
			`  is-active) [ -f '${started}' ] && [ ${activeAfterStart ? 1 : 0} = 1 ] ;;`,
			`  start|restart) : > '${started}' ;;`,
			'  *) exit 0 ;;',
			'esac'
		].join('\n')
	);
	process.env.PATH = `${bin}:${saved.PATH}`;
	process.env.MORPHIT_SYSTEMD_DIR = join(d, 'systemd');
	mkdirSync(join(d, 'systemd'));
	writeFileSync(join(d, 'systemd', 'morphit-mcp.service'), '[Service]\n');
	const install = join(d, 'opt');
	mkdirSync(join(install, 'ops', 'scripts'), { recursive: true });
	const deploy = join(install, 'ops', 'scripts', 'deploy-mcp.sh');
	writeFileSync(deploy, `echo "deploy $*" >> '${calls}'\necho "✓ morphit-mcp deployed to $2"\n`);
	chmodSync(deploy, 0o755);
	vi.resetModules();
	const { redeployMcpOnUpgrade } = await import('../src/commands/upgrade.ts');
	let out = '';
	const grab = (c: unknown): boolean => ((out += String(c)), true);
	vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
	vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
	const ok = await redeployMcpOnUpgrade(install, { settleMs: 10 });
	vi.restoreAllMocks();
	return { ok, out, calls: readFileSync(calls, 'utf8') };
}

describe('the MCP server on upgrade', () => {
	it('turned off in menu 17: its new code is put in place, and it is NOT started', async () => {
		const r = await step('disabled', true);
		expect(r.calls).toMatch(/^deploy /m);
		expect(r.calls).not.toMatch(/^(start|restart) morphit-mcp/m);
		expect(r.out).toMatch(/stays off as you set it/);
		expect(r.out).not.toMatch(/Started morphit-mcp/);
		// one line for the deploy, not the script's own as well
		expect(r.out).not.toMatch(/✓ morphit-mcp deployed to/);
		expect(r.ok).toBe(true);
	});
	it('on, but it stops again right after starting: a warning, never "started"', async () => {
		const r = await step('enabled', false);
		expect(r.calls).toMatch(/^start morphit-mcp\.service/m);
		expect(r.out).toMatch(/stopped again right after it was started.*journalctl -u morphit-mcp/);
		expect(r.ok).toBe(false);
	});
});
