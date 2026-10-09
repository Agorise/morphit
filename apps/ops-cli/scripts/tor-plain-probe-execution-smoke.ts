/**
 * tor-plain-probe-execution-smoke (v1.21.4)
 *
 * The Tor bridges repair checks, on a server whose Tor runs over bridges,
 * whether plain Tor works on its network again, with a separate throwaway Tor
 * client (plainTorProbe in apps/ops-cli/src/lib/torBridgesHeal.ts). This runs
 * that client for real (the `tor` binary on this machine) and pins:
 *   1. it stops at its time limit, and leaves no directory or process behind;
 *   2. as root it runs as Tor's own user (debian-tor): on a Tor-only node the
 *      egress rule lets only that user out, root included;
 *   3. it ends by itself when the process that started it is killed hard (no
 *      clean-up runs): Tor's __OwningControllerProcess.
 * Without a `tor` binary (or not as root) the checks that need it are skipped
 * and said so; the user lookup is checked everywhere.
 *
 * Real processes are watched here, with real waits, which is why this is an
 * execution smoke rather than a unit test.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { plainTorProbe, torProbeUser } from '../src/lib/torBridgesHeal.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const HEAL = join(REPO, 'apps', 'ops-cli', 'src', 'lib', 'torBridgesHeal.ts');
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The plain Tor clients running now: a `tor` whose data directory is a
 *  probe's (never a shell whose command line merely names one). */
function plainTorClients(uid?: number): string[] {
	const out = spawnSync('ps', ['-eo', 'pid=,uid=,comm=,args='], { encoding: 'utf8' }).stdout ?? '';
	return out
		.split('\n')
		.map((l) => l.trim().split(/\s+/))
		.filter(
			(f) =>
				f[2] === 'tor' &&
				(uid === undefined || f[1] === String(uid)) &&
				f.slice(3).join(' ').includes('/morphit-plain-tor-')
		)
		.map((f) => f[0]!);
}
const probeDirs = (): string[] =>
	readdirSync(tmpdir()).filter((f) => f.startsWith('morphit-plain-tor-'));

// The user lookup (everywhere).
{
	const d = mkdtempSync(join(tmpdir(), 'morphit-passwd-'));
	try {
		writeFileSync(
			join(d, 'passwd'),
			'root:x:0:0:root:/root:/bin/bash\ndebian-tor:x:103:105::/var/lib/tor:/bin/false\n'
		);
		const u = torProbeUser(join(d, 'passwd'));
		check("Tor's own user is read from passwd", u?.uid === 103 && u?.gid === 105);
		writeFileSync(join(d, 'passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
		check(
			'no Tor user: none (the client then runs as this process)',
			torProbeUser(join(d, 'passwd')) === null
		);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

const haveTor = spawnSync('tor', ['--version']).status === 0;
const root = process.getuid?.() === 0;
if (!haveTor) console.log('  · no tor binary here: the runs below are skipped');
else {
	// 1. Its time limit, and nothing left behind.
	{
		const before = probeDirs();
		const t0 = Date.now();
		await plainTorProbe({ until: Date.now() + 35_000, onion: null });
		const took = Date.now() - t0;
		check(
			'it stops at its time limit (plus one request and the kill)',
			took < 50_000,
			`${took} ms`
		);
		check(
			'its directory is removed',
			JSON.stringify(probeDirs()) === JSON.stringify(before),
			probeDirs().join(', ')
		);
		check('its Tor client is gone', plainTorClients().length === 0, plainTorClients().join(', '));
	}

	// 2 + 3. As Tor's user, and ending with its owner.
	const user = torProbeUser();
	if (!root || user === null)
		console.log('  · not root, or no Tor user: the user and owner checks are skipped');
	else {
		const before = probeDirs();
		const dir = mkdtempSync(join(tmpdir(), 'morphit-probe-run-'));
		const script = join(dir, 'run.mts');
		writeFileSync(
			script,
			`import { plainTorProbe } from ${JSON.stringify(HEAL)};\n` +
				'await plainTorProbe({ until: Date.now() + 120_000, onion: null });\n'
		);
		const child = spawn(join(REPO, 'node_modules', '.bin', 'tsx'), [script], {
			stdio: 'ignore',
			detached: true
		});
		let pids: string[] = [];
		for (let i = 0; i < 40 && pids.length === 0; i++) {
			await sleep(250);
			pids = plainTorClients(user.uid);
		}
		check(`it runs as Tor's own user (uid ${user.uid})`, pids.length > 0, 'no such Tor client');
		if (pids.length > 0) {
			// Only the process that started it dies, at once: the client itself is
			// not signalled, and no clean-up runs.
			const ppid = /^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pids[0]}/status`, 'utf8'))?.[1];
			if (ppid !== undefined) process.kill(Number(ppid), 'SIGKILL');
			let left = pids;
			for (let i = 0; i < 160 && left.length > 0; i++) {
				await sleep(250);
				left = plainTorClients(user.uid);
			}
			check(
				'it ends by itself when the process that started it is killed',
				left.length === 0,
				left.join(', ')
			);
		}
		try {
			process.kill(-child.pid!, 'SIGKILL');
		} catch {
			/* already gone */
		}
		for (const p of plainTorClients()) {
			try {
				process.kill(Number(p), 'SIGKILL');
			} catch {
				/* gone */
			}
		}
		rmSync(dirname(script), { recursive: true, force: true });
		for (const f of probeDirs())
			if (!before.includes(f)) rmSync(join(tmpdir(), f), { recursive: true, force: true });
	}
}

if (fail > 0) {
	console.log(`✗ ${fail} of ${pass + fail} tor plain-probe execution checks failed`);
	process.exit(1);
}
console.log(`✓ all ${pass} tor plain-probe execution checks passed`);
