/**
 * upgrade-mcp-reachability — cp449.
 *
 * `morphit-ops upgrade` redeploys + restarts the MCP server (its own vendored
 * tree at /opt/morphit-mcp), but until now nothing confirmed the restarted
 * service actually came back up. cp449 adds a post-restart reachability probe.
 *
 * The subtlety this smoke pins is a REAL deployment fact: the MCP binds
 * `MORPHIT_MCP_HTTP_HOST:MORPHIT_MCP_HTTP_PORT`, and on the canonical BunkerWeb
 * VPS `/etc/morphit/mcp.env` sets `MORPHIT_MCP_HTTP_HOST=172.18.0.1` (the Docker
 * bridge gateway) so the WAF/reverse-proxy can reach it. A probe that assumed
 * loopback (127.0.0.1) would FALSE-NEGATIVE on that box. So the probe must read
 * the CONFIGURED bind from mcp.env, and this smoke proves the resolver does.
 *
 *   1. resolveMcpHttpBind — defaults to 127.0.0.1:8124 (the systemd unit
 *      defaults) with no env file; honors host-only, host+port, quotes,
 *      comments, an invalid port (kept at default), and last-write-wins.
 *   2. buildMcpHealthUrl — IPv4 and bracketed-IPv6 forms.
 *   3. classifyMcpHealth — 200+{status:'ok'} → ok; wrong status/body → not ok.
 *   4. WIRING — the probe is called after the MCP restart, is NON-FATAL (warn,
 *      not rollback), is gated inside the unit-installed block, and its failure
 *      message points at journalctl + the mcp.env bind (naming the 172.18.0.1
 *      Docker-bridge/BunkerWeb case).
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import {
	resolveMcpHttpBind,
	buildMcpHealthUrl,
	classifyMcpHealth,
	mcpEnvFile
} from '../src/commands/upgrade.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failures++;
	}
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const upgradeSrc = readFileSync(
	join(repoRoot, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts'),
	'utf8'
);

// Temp dir for mcp.env fixtures.
const dir = mkdtempSync(join(tmpdir(), 'mcp-reach-'));
function writeEnv(contents: string): string {
	const p = join(dir, `mcp-${Math.random().toString(36).slice(2)}.env`);
	writeFileSync(p, contents);
	return p;
}

try {
	// ─── 1. resolveMcpHttpBind ─────────────────────────────────────────────
	const missing = join(dir, 'does-not-exist.env');
	const d0 = resolveMcpHttpBind(missing);
	check(
		'no env file → unit defaults 127.0.0.1:8124',
		d0.host === '127.0.0.1' && d0.port === 8124,
		JSON.stringify(d0)
	);

	const d1 = resolveMcpHttpBind(writeEnv('MORPHIT_MCP_HTTP_HOST=172.18.0.1\n'));
	check(
		'host-only (172.18.0.1) → host set, port default 8124',
		d1.host === '172.18.0.1' && d1.port === 8124,
		JSON.stringify(d1)
	);

	const d2 = resolveMcpHttpBind(
		writeEnv('# MCP bridge bind\nMORPHIT_MCP_HTTP_HOST="172.18.0.1"\nMORPHIT_MCP_HTTP_PORT=8200\n')
	);
	check(
		'quoted host + explicit port, comment ignored',
		d2.host === '172.18.0.1' && d2.port === 8200,
		JSON.stringify(d2)
	);

	const d3 = resolveMcpHttpBind(writeEnv('MORPHIT_MCP_HTTP_PORT=not-a-number\n'));
	check('invalid port kept at default 8124', d3.port === 8124, JSON.stringify(d3));

	const d4 = resolveMcpHttpBind(writeEnv('MORPHIT_MCP_HTTP_PORT=70000\n'));
	check('out-of-range port kept at default 8124', d4.port === 8124, JSON.stringify(d4));

	const d5 = resolveMcpHttpBind(
		writeEnv('MORPHIT_MCP_HTTP_HOST=127.0.0.1\nMORPHIT_MCP_HTTP_HOST=172.18.0.1\n')
	);
	check('last assignment wins (set -a semantics)', d5.host === '172.18.0.1', JSON.stringify(d5));

	// mcpEnvFile honors MORPHIT_ETC_DIR
	const prevEtc = process.env.MORPHIT_ETC_DIR;
	process.env.MORPHIT_ETC_DIR = '/tmp/etc-morphit-test';
	check(
		'mcpEnvFile honors MORPHIT_ETC_DIR',
		mcpEnvFile() === join('/tmp/etc-morphit-test', 'mcp.env'),
		mcpEnvFile()
	);
	if (prevEtc === undefined) delete process.env.MORPHIT_ETC_DIR;
	else process.env.MORPHIT_ETC_DIR = prevEtc;

	// ─── 2. buildMcpHealthUrl ──────────────────────────────────────────────
	check(
		'IPv4 health URL',
		buildMcpHealthUrl('172.18.0.1', 8124) === 'http://172.18.0.1:8124/health',
		buildMcpHealthUrl('172.18.0.1', 8124)
	);
	check(
		'IPv6 health URL is bracketed',
		buildMcpHealthUrl('::1', 8124) === 'http://[::1]:8124/health',
		buildMcpHealthUrl('::1', 8124)
	);

	// ─── 3. classifyMcpHealth ──────────────────────────────────────────────
	check('200 + {status:ok} → ok', classifyMcpHealth(200, '{"status":"ok","transport":"http"}') === 'ok');
	check('200 + wrong status field → bad_body', classifyMcpHealth(200, '{"status":"degraded"}') === 'bad_body');
	check('500 → bad_status', classifyMcpHealth(500, '{"status":"ok"}') === 'bad_status');
	check('200 + non-JSON → bad_body', classifyMcpHealth(200, '<html>oops</html>') === 'bad_body');

	// ─── 4. WIRING (upgrade.ts) ────────────────────────────────────────────
	check(
		'upgrade calls resolveMcpHttpBind(mcpEnvFile())',
		/resolveMcpHttpBind\(\s*mcpEnvFile\(\)\s*\)/.test(upgradeSrc)
	);
	check('upgrade awaits probeMcpHealth', /await\s+probeMcpHealth\(/.test(upgradeSrc));
	// The probe lives inside the MCP-unit-installed block AND after the restart.
	const mcpBlockIdx = upgradeSrc.indexOf('morphit-mcp.service');
	const probeIdx = upgradeSrc.indexOf('await probeMcpHealth('); // the CALL site, not the def
	const restartIdx = upgradeSrc.indexOf("['restart', 'morphit-mcp.service']");
	check(
		'probe is wired after the MCP restart',
		restartIdx !== -1 && probeIdx !== -1 && probeIdx > restartIdx
	);
	check('probe is under the MCP block (unit-installed gate)', mcpBlockIdx !== -1 && probeIdx > mcpBlockIdx);
	// Failure path is a warn (non-fatal), NOT a rollback.
	const afterProbe = upgradeSrc.slice(probeIdx, probeIdx + 900);
	check(
		'unreachable path warns (non-fatal), does not roll back',
		/probe\.reachable/.test(afterProbe) &&
			/warn\(/.test(afterProbe) &&
			!/rollback\(/.test(afterProbe)
	);
	check(
		'failure guidance names journalctl + the mcp.env bind + the 172.18.0.1 bridge case',
		/journalctl -u morphit-mcp/.test(afterProbe) &&
			/MORPHIT_MCP_HTTP_HOST/.test(afterProbe) &&
			/172\.18\.0\.1/.test(afterProbe)
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

const scenarios = 18;
console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} upgrade-mcp-reachability scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} upgrade-mcp-reachability scenarios failed`);
	process.exit(1);
}
