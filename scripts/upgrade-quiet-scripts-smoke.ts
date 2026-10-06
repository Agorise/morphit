/**
 * upgrade-quiet-scripts-smoke.
 *
 * The scripts `morphit-ops upgrade` runs from the NEW release print into the
 * upgrade's output, also when an older upgrader drives it. On the v1.21.0
 * upgrade of morphit.io they added: esbuild's size table (with a ⚠ marker for
 * a bundle that is large by design), the MCP deploy's source/destination and
 * package-count lines, the IPFS gateway check's "frontend container: …" and
 * "nothing to heal" lines, and the indexer library's own structured log lines
 * from the snapshot mirror ("[rpc-quorum] rpc_quorum_outvoted …").
 *
 * This EXECUTES each script the way the upgrade does (output piped, the
 * upgrade's MORPHIT_QUIET_BUILD=1 set) and checks what reaches the operator;
 * and, where a person runs it by hand, that the detail is still there.
 *
 * To watch it fail on the old scripts, run it against a tree that has them.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		failures.push(name);
		console.log(`  ✗ ${name}${detail ? `\n      ${detail.slice(-500)}` : ''}`);
	}
};
const S = mkdtempSync(join(tmpdir(), 'morphit-quiet-scripts-'));
const out = (r: ReturnType<typeof spawnSync>): string => `${r.stdout ?? ''}${r.stderr ?? ''}`;
const stub = (dir: string, name: string, body: string): void => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(dir, name), 0o755);
};

try {
	// ── 1. the IPFS gateway check: nothing to say → says nothing (piped) ──
	{
		const bin = join(S, 'gw-bin');
		stub(bin, 'docker', 'exit 0'); // Docker answers, and runs no frontend container
		const heal = join(REPO, 'ops', 'ipfs', 'morphit-gateway-firewall-heal.sh');
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
		const piped = spawnSync('sh', [heal], { encoding: 'utf8', env, timeout: 60_000 });
		check(
			'gateway check, piped (an upgrade): nothing to heal prints nothing, exit 0',
			piped.status === 0 && out(piped).trim() === '',
			out(piped)
		);
		const tty = spawnSync('script', ['-qec', `sh ${heal}`, '/dev/null'], {
			encoding: 'utf8',
			env,
			timeout: 60_000
		});
		check(
			'gateway check, at a terminal (a hand run): still says why there is nothing to do',
			/no frontend container serving the web build/.test(out(tty)),
			out(tty)
		);
	}

	// ── 2. the MCP deploy, as the upgrade runs it ──
	{
		const bin = join(S, 'mcp-bin');
		stub(bin, 'npm', 'exit 1'); // it must not need npm at all
		const deploy = (quiet: boolean) =>
			spawnSync(
				'bash',
				[
					join(REPO, 'ops/scripts/deploy-mcp.sh'),
					REPO,
					join(S, quiet ? 'mcp-q' : 'mcp-v'),
					'no-such-user-xyz'
				],
				{
					encoding: 'utf8',
					timeout: 240_000,
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH ?? ''}`,
						MORPHIT_QUIET_BUILD: quiet ? '1' : ''
					}
				}
			);
		const q = deploy(true);
		check(
			'MCP deploy in an upgrade: its result line, without the paths and the package count',
			q.status === 0 &&
				/✓ morphit-mcp deployed to /.test(out(q)) &&
				!/morphit-mcp deploy: /.test(out(q)) &&
				!/runtime packages from the locked install/.test(out(q)),
			out(q)
		);
		const v = deploy(false);
		check(
			'MCP deploy by hand: still names the paths and the package count',
			v.status === 0 && /morphit-mcp deploy: /.test(out(v)) && /runtime packages/.test(out(v)),
			out(v)
		);
	}

	// ── 3. the morphit-ops bundle build, as the upgrade runs it ──
	{
		const b = spawnSync('node', [join(REPO, 'apps/ops-cli/scripts/build.mjs')], {
			encoding: 'utf8',
			timeout: 180_000,
			env: { ...process.env, MORPHIT_QUIET_BUILD: '1' }
		});
		const lines = out(b)
			.split('\n')
			.filter((l) => l.trim() !== '');
		check(
			'morphit-ops build in an upgrade: one result line, no size table',
			b.status === 0 && lines.length === 1 && /✓ ops-cli bundled/.test(lines[0] ?? ''),
			out(b)
		);
	}

	// ── 4. the snapshot mirror: the indexer library logs only errors ──
	{
		const repo = join(S, 'mirror-repo');
		stub(join(repo, 'node_modules', '.bin'), 'tsx', 'echo "LOG_LEVEL=$MORPHIT_LOG_LEVEL"');
		const bin = join(S, 'mirror-bin');
		stub(bin, 'ipfs', 'exit 0');
		const env = join(S, 'indexer.env');
		writeFileSync(env, 'MORPHIT_LOG_LEVEL=info\nMORPHIT_CHAIN_ID=x\n');
		const mirror = (extra: Record<string, string>) => {
			const e: Record<string, string | undefined> = {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				MORPHIT_REPO_PATH: repo,
				MORPHIT_INDEXER_ENV: env,
				...extra
			};
			delete e.INVOCATION_ID;
			if (extra.INVOCATION_ID) e.INVOCATION_ID = extra.INVOCATION_ID;
			return spawnSync('bash', [join(REPO, 'ops', 'snapshot-mirror.sh')], {
				encoding: 'utf8',
				timeout: 60_000,
				env: e
			});
		};
		const r = mirror({});
		check(
			'snapshot mirror in an upgrade (piped): runs the indexer code with MORPHIT_LOG_LEVEL=error (its own result lines stay)',
			r.status === 0 && /LOG_LEVEL=error/.test(out(r)),
			out(r)
		);
		const timer = mirror({ INVOCATION_ID: 'abc123' });
		check(
			'snapshot mirror from its weekly timer (a systemd unit): keeps the log level from indexer.env',
			timer.status === 0 && /LOG_LEVEL=info/.test(out(timer)),
			out(timer)
		);
	}
} finally {
	rmSync(S, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`✗ ${failures.length} upgrade-quiet-scripts check(s) failed`);
	process.exit(1);
}
console.log(`✓ all ${pass} upgrade-quiet-scripts checks passed`);
