/**
 * A stop (Ctrl+C, a closed SSH session) at each later phase of an upgrade
 * (v1.21.18 audit). The real runUpgrade runs in its own process group with
 * stand-in system programs (test/helpers/upgradeFlow.mts); the signal goes to
 * the WHOLE group, as a terminal sends it, while one slow step runs.
 *
 *  H1  during the new release's heal phase (a blocking child): the signal
 *      reached this process's handler only on the next event-loop turn, so the
 *      heals ran AGAIN in this process before the rollback.
 *  M1  while the indexer was watched after its restart: the relay was
 *      restarted too, the upgrade "finished rather than undone" and went on
 *      with every optional step, exit 0.
 *  M1  after every service runs the new release: nothing is undone; what was
 *      skipped is named, with how to do it; exit 130 (129 for SIGHUP).
 *  M2  during the frontend container's rebuild: the docker-compose fallback
 *      build, a restart and the checks ran after the Ctrl+C.
 *  L4  a signal its step's exit beat: "Extract failed" was printed for it.
 *  M3  a rollback named the log of an earlier, non-fatal step that failed.
 *  L3  Ctrl+C at the canary question: "No problem — skipping the canary…".
 *  Exit code: a stopped, rolled-back upgrade exits 130 (Ctrl+C) / 129 (SIGHUP).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPS } from './helpers/pty.ts';

const FLOW = join(OPS, 'test', 'helpers', 'upgradeFlow.mts');
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
// gpg breaks on long home paths: a short scratch folder.
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'up-stop-'));
	dirs.push(d);
	return d;
};
const tagOf = (dir: string): string =>
	(JSON.parse(readFileSync(join(dir, 'morphit', 'release-info.json'), 'utf8')) as { tag: string })
		.tag;
const calls = (dir: string): string => {
	try {
		return readFileSync(join(dir, 'calls.log'), 'utf8');
	} catch {
		return '';
	}
};

/** Run `mode`; once `marker` exists (its slow step runs) — and `o.ready`
 *  holds, when given — send `sig` to the whole process group. Everything
 *  printed, and what was printed after the signal. */
async function stopAt(
	mode: string,
	marker: string,
	sig: NodeJS.Signals,
	o: {
		env?: Record<string, string>;
		onlyThePidInTheMarker?: boolean;
		ready?: (dir: string) => boolean;
	} = {}
): Promise<{ out: string; after: string; dir: string; secs: number }> {
	const dir = scratch();
	// Plain node with tsx's loader, as the installed CLI runs under plain node.
	const child = spawn(process.execPath, ['--import', 'tsx', FLOW, mode, dir], {
		cwd: OPS,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...(o.env ?? {}) }
	});
	let out = '';
	child.stdout.on('data', (b: Buffer) => (out += b));
	child.stderr.on('data', (b: Buffer) => (out += b));
	const closed = new Promise<void>((r) => child.on('close', () => r()));
	// Real processes: poll (vi.waitFor) for the state the stop must arrive in.
	await vi.waitFor(
		() => {
			if (!existsSync(join(dir, marker))) throw new Error(`${marker}: not yet`);
			if (o.ready !== undefined && !o.ready(dir)) throw new Error(`${mode}: not ready yet`);
		},
		{ timeout: 120_000, interval: 50 }
	);
	const at = out.length;
	const sent = Date.now();
	if (o.onlyThePidInTheMarker)
		process.kill(Number(readFileSync(join(dir, marker), 'utf8').trim()), sig);
	else process.kill(-child.pid!, sig);
	await closed;
	const clean = (t: string): string =>
		t
			.split('\n')
			.filter((l) => !/^gpg:/.test(l))
			.join('\n');
	return {
		out: clean(out),
		after: clean(out.slice(at)),
		dir,
		secs: (Date.now() - sent) / 1000
	};
}

describe('H1: Ctrl+C while the new release’s heal phase runs (a blocking child)', () => {
	it('no heal runs again in this process; the previous install is put back; exit 130', async () => {
		const r = await stopAt('slow-heal', 'heal-started', 'SIGINT');
		expect(r.after).toMatch(/Stopping — you pressed Ctrl\+C\./);
		// The heals (run in this process when the child "failed") print these:
		expect(r.after).not.toMatch(
			/Clock fallback|Indexer memory cap|IPv4 forwarding|other checks found nothing|Web-proxy settings/
		);
		expect(r.after).toMatch(/Not upgraded — this server is back on v1\.21\.16/);
		expect(tagOf(r.dir)).toBe('v1.21.16');
		expect(readdirSync(r.dir).filter((n) => n.startsWith('morphit.bak-'))).toEqual([]);
		expect(r.out).toMatch(/=== exit code 130/);
	}, 200_000);

	it('a heal phase that ends itself on Ctrl+C (exit 130, not by the signal): the same', async () => {
		const r = await stopAt('slow-heal', 'heal-started', 'SIGINT', {
			env: { FLOW_HEAL_TRAPS: '1' }
		});
		expect(r.after).not.toMatch(
			/Clock fallback|Indexer memory cap|IPv4 forwarding|other checks found nothing|Web-proxy settings/
		);
		expect(r.after).toMatch(/Not upgraded — this server is back on v1\.21\.16/);
		expect(tagOf(r.dir)).toBe('v1.21.16');
		expect(r.out).toMatch(/=== exit code 130/);
	}, 200_000);

	it('only the heal phase gets the signal (killed by SIGTERM, not its time limit): a stop too', async () => {
		const r = await stopAt('slow-heal', 'heal-started', 'SIGTERM', { onlyThePidInTheMarker: true });
		expect(r.after).toMatch(/Stopping — it was asked to stop \(SIGTERM\)\./);
		expect(r.after).not.toMatch(
			/Clock fallback|Indexer memory cap|IPv4 forwarding|other checks found nothing|Web-proxy settings/
		);
		expect(tagOf(r.dir)).toBe('v1.21.16');
		expect(r.out).toMatch(/=== exit code 143/);
	}, 200_000);
});

describe('M1: Ctrl+C while the restarted indexer is watched', () => {
	it('the relay is not restarted on the new release; everything is put back; exit 130', async () => {
		// Once the watch has begun: it has asked for the indexer's state.
		const r = await stopAt('slow-restart', 'restart-started', 'SIGINT', {
			ready: (dir) =>
				/systemctl show -p ActiveState --value morphit-indexer\.service/.test(calls(dir))
		});
		expect(r.out).toMatch(/Restarting morphit-indexer\.service…/);
		// Its restart on the NEW release (the rollback's says "on the previous version").
		expect(r.out).not.toMatch(/Restarting morphit-relay\.service…/);
		expect(r.out).not.toMatch(/finished rather than undone/);
		expect(r.out).not.toMatch(/Redeploying the MCP server|Success — your Morphit server/);
		expect(r.after).toMatch(/Not upgraded — this server is back on v1\.21\.16/);
		expect(r.after).toMatch(/Why: you pressed Ctrl\+C\./);
		expect(tagOf(r.dir)).toBe('v1.21.16');
		expect(r.out).toMatch(/=== exit code 130/);
	}, 200_000);
});

describe('M1: a stop after every service runs the new release', () => {
	it('Ctrl+C during the MCP update: nothing undone, what was skipped is named with how; exit 130', async () => {
		const r = await stopAt('slow-mcp', 'mcp-started', 'SIGINT');
		expect(tagOf(r.dir)).toBe('v1.21.17');
		expect(r.after).toMatch(
			/Stopping — you pressed Ctrl\+C\. The upgrade itself is done \(every service runs v1\.21\.17\), so nothing is undone/
		);
		expect(r.after).toMatch(
			/✓ Upgraded — this server runs v1\.21\.17 \(stopped before the last steps\)/
		);
		expect(r.after).toMatch(
			/Stopped: you pressed Ctrl\+C\. Every service had restarted on v1\.21\.17 \(checked\), so nothing was undone\./
		);
		expect(r.after).toMatch(
			/• the MCP server's update to v1\.21\.17 .*on this server: sudo bash \S+\/ops\/scripts\/deploy-mcp\.sh \S+ \/opt\/morphit-mcp morphit-mcp && sudo systemctl try-restart morphit-mcp/
		);
		expect(r.after).toMatch(/Not done \(or cut short\) because it was stopped:/);
		// The step the stop cut short says nothing of its own beyond that.
		expect(r.after).not.toMatch(/could not be put in place/);
		expect(r.after).not.toMatch(/Rolling back|Not upgraded|Success — your Morphit server/);
		expect(r.after).not.toMatch(/Matrix alert bot|Seeding|snapshot mirror/);
		expect(r.out).toMatch(/=== exit code 130/);
	}, 200_000);

	it('the SSH session drops there: the same, exit 129, and the lines are kept in a file', async () => {
		const r = await stopAt('slow-mcp', 'mcp-started', 'SIGHUP');
		expect(tagOf(r.dir)).toBe('v1.21.17');
		const note = readdirSync(join(r.dir, 'steplogs')).find((n) => n.startsWith('upgrade-stopped-'));
		expect(note).toBeDefined();
		expect(readFileSync(join(r.dir, 'steplogs', note!), 'utf8')).toMatch(
			/Stopped: the connection to this server closed .*nothing was undone/
		);
		expect(r.out).toMatch(/=== exit code 129/);
	}, 200_000);
});

describe('M2: Ctrl+C while the frontend container is rebuilt', () => {
	it('no second build way, no restart, no checks: the previous install is put back; exit 130', async () => {
		const r = await stopAt('slow-frontend', 'compose-started', 'SIGINT');
		expect(calls(r.dir)).not.toMatch(/docker-compose /);
		expect(r.after).not.toMatch(
			/falling back to a restart|Checking the site serves the new frontend/
		);
		expect(r.after).toMatch(/Not upgraded — this server is back on v1\.21\.16/);
		expect(tagOf(r.dir)).toBe('v1.21.16');
		expect(r.out).toMatch(/=== exit code 130/);
	}, 200_000);
});

/** One whole flow in its own process; everything it printed. */
function flow(mode: string): { out: string; dir: string } {
	const dir = scratch();
	const r = spawnSync(process.execPath, ['--import', 'tsx', FLOW, mode, dir], {
		cwd: OPS,
		encoding: 'utf8',
		timeout: 180_000,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	return {
		out: `${r.stdout ?? ''}${r.stderr ?? ''}`
			.split('\n')
			.filter((l) => !/^gpg:/.test(l))
			.join('\n'),
		dir
	};
}

describe('L4: a signal that arrives just after its step ended', () => {
	it('is a stop, not "Extract failed"; exit 129', () => {
		const { out, dir } = flow('late-signal');
		expect(out).not.toMatch(/Extract failed/);
		expect(out).toMatch(/Why: the connection to this server closed/);
		expect(tagOf(dir)).toBe('v1.21.16');
		expect(out).toMatch(/=== exit code 129/);
	}, 200_000);
});

describe('M3: a rollback names only the log of the step that made it fail', () => {
	it('an earlier non-fatal build failure is not named as the reason’s output', () => {
		const { out } = flow('step-log');
		// The non-fatal step did fail, and said where its output is.
		expect(out).toMatch(/Could not rebuild morphit-ops's dist bundle/);
		expect(out).toMatch(
			/Why: the upgrade failed \(morphit-indexer\.service failed to come up after the upgrade restart\)\.\n/
		);
		expect(out).not.toMatch(/The step's full output/);
		expect(out).toMatch(/=== exit code 3/);
	}, 200_000);
});

describe('L3: Ctrl+C at the canary question (a terminal)', () => {
	const seen = existsSync('/var/lib/morphit/canary-seen');
	it.skipIf(seen)(
		'says nothing about skipping the canary; the stop puts the previous install back',
		async () => {
			const d = scratch();
			const child = spawn(
				'script',
				['-qec', `${process.execPath} --import tsx ${FLOW} canary-prompt ${d}`, '/dev/null'],
				{ cwd: OPS, stdio: ['pipe', 'pipe', 'pipe'] }
			);
			let out = '';
			child.stdout.on('data', (b: Buffer) => (out += b));
			const closed = new Promise<void>((r) => child.on('close', () => r()));
			await vi.waitFor(
				() => {
					if (!/\[y\/N\]: /.test(out)) throw new Error('no question yet');
				},
				{ timeout: 120_000, interval: 200 }
			);
			child.stdin.write('y\r');
			await vi.waitFor(
				() => {
					if (!/Set one up now, right here on this box\?[\s\S]*\[y\/N\]: /.test(out))
						throw new Error('no canary question yet');
				},
				{ timeout: 120_000, interval: 200 }
			);
			child.stdin.write('\x03');
			await closed;
			expect(out).toMatch(/Stopping — you pressed Ctrl\+C\./);
			expect(out).not.toMatch(/No problem — skipping the canary/);
			expect(out).toMatch(/Not upgraded — this server is back on v1\.21\.16/);
			expect(out).toMatch(/=== exit code 130/);
		},
		240_000
	);
});
