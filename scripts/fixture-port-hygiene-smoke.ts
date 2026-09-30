#!/usr/bin/env tsx
/**
 * scripts/fixture-port-hygiene-smoke.ts (v1.20.0)
 *
 * Test fixtures must never test against NOTHING.
 *
 * WHY THIS EXISTS. On 2026-09-29 CI's smoke job failed fast-sync-execution-smoke
 * with seven checks at once ("NOTHING traversed the proxy", "the snapshot body
 * was never fetched"). Nothing was wrong with fast-sync. The harness started its
 * proxy stubs on FIXED ports inside the kernel's ephemeral range (45951-45953);
 * on a busy runner one of them was already held by another socket, and the stubs
 * printed "stubs-ready" BEFORE listening, then died. The harness saw "ready" and
 * went on to test against nothing. A day earlier tor-only-os-smoke failed the
 * same way (random port in the ephemeral range, a readiness wait that gave up
 * silently).
 *
 * Checks:
 *   1. hidden-proxy-stubs.mjs asked for port 0 announces three REAL ports, and
 *      all three accept a connection at that moment.
 *   2. With a port already taken, it announces `stubs-failed`, exits non-zero,
 *      and never says `stubs-ready`.
 *   3. No fixture (ops/test, smoke scripts) hard-codes a port inside the Linux
 *      ephemeral range (32768-60999) — pick port 0 or a port below 32768.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const STUBS = join(ROOT, 'ops', 'test', 'lib', 'hidden-proxy-stubs.mjs');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}`);
		if (detail) console.log(`      ${detail}`);
	}
};

/** Run the stubs until they print a verdict line (or exit, or 20 s pass). */
function runStubs(
	ports: [string, string, string]
): Promise<{ out: string; code: number | null; kill: () => void }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [STUBS, ...ports, '/dev/null'], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let settled = false;
		const done = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ out, code, kill: () => child.kill() });
		};
		const timer = setTimeout(() => done(null), 20_000);
		child.stdout.on('data', (d) => {
			out += String(d);
			// The old stubs said "ready" first and died a moment later: wait a
			// little so that death is seen too.
			if (/^stubs-(ready|failed)/m.test(out)) setTimeout(() => done(child.exitCode), 1_000);
		});
		child.stderr.on('data', (d) => (out += String(d)));
		child.on('exit', (code) => done(code));
	});
}

const canConnect = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const s = connect(port, '127.0.0.1');
		s.once('connect', () => {
			s.destroy();
			resolve(true);
		});
		s.once('error', () => resolve(false));
	});

async function main(): Promise<void> {
	console.log('── fixture port hygiene ───────────────────────────────────');

	// 1. port 0 → three real, listening ports
	{
		const r = await runStubs(['0', '0', '0']);
		const m = /^stubs-ready (\d+) (\d+) (\d+)$/m.exec(r.out);
		const ports = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
		const live = ports.length === 3 ? await Promise.all(ports.map(canConnect)) : [];
		r.kill();
		check(
			'proxy stubs on port 0 announce three real ports, all listening',
			ports.length === 3 && ports.every((p) => p > 0) && live.every(Boolean),
			`output: ${JSON.stringify(r.out.slice(0, 200))}`
		);
	}

	// 2. a taken port → stubs-failed, non-zero, never "ready"
	{
		const holder: Server = createServer();
		await new Promise<void>((res) => holder.listen(0, '127.0.0.1', () => res()));
		const taken = String((holder.address() as { port: number }).port);
		const r = await runStubs(['0', taken, '0']);
		r.kill();
		holder.close();
		check(
			'a taken port makes the stubs say stubs-failed and exit non-zero — never stubs-ready',
			/^stubs-failed /m.test(r.out) &&
				!/^stubs-ready/m.test(r.out) &&
				r.code !== 0 &&
				r.code !== null,
			`exit ${r.code}; output: ${JSON.stringify(r.out.slice(0, 300))}`
		);
	}

	// 3. no hard-coded ports inside the ephemeral range in fixture code
	{
		const EPH = '(?:3276[89]|327[7-9]\\d|32[89]\\d{2}|3[3-9]\\d{3}|[45]\\d{4}|60\\d{3})';
		const RE = new RegExp(
			`(?:127\\.0\\.0\\.1|localhost):${EPH}\\b|\\.listen\\(\\s*${EPH}\\b|\\bPORT=${EPH}\\b|hidden-proxy-stubs\\.mjs"?\\s*\\\\?\\s*${EPH}\\b`,
			'g'
		);
		const files: string[] = [];
		const walk = (dir: string): void => {
			for (const name of readdirSync(dir)) {
				if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
				const p = join(dir, name);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|mjs|js|sh)$/.test(name)) files.push(p);
			}
		};
		walk(join(ROOT, 'ops', 'test'));
		walk(join(ROOT, 'scripts'));
		for (const top of ['apps', 'packages']) {
			for (const ws of readdirSync(join(ROOT, top))) {
				const d = join(ROOT, top, ws, 'scripts');
				try {
					if (statSync(d).isDirectory()) walk(d);
				} catch {
					/* no scripts dir */
				}
			}
		}
		const hits: string[] = [];
		for (const f of files) {
			if (f === join(ROOT, 'scripts', 'fixture-port-hygiene-smoke.ts')) continue;
			const text = readFileSync(f, 'utf8');
			for (const m of text.matchAll(RE)) {
				const line = text.slice(0, m.index).split('\n').length;
				hits.push(`${relative(ROOT, f)}:${line} ${m[0]}`);
			}
		}
		check(
			`no fixture hard-codes a port in the ephemeral range 32768-60999 (${files.length} files scanned)`,
			files.length > 500 && hits.length === 0,
			hits.length > 0
				? `use port 0 (kernel's pick) or one below 32768:\n      ${hits.slice(0, 10).join('\n      ')}`
				: `only ${files.length} files scanned — the walk is broken`
		);
	}

	console.log('');
	if (fail > 0) {
		console.log(`✗ ${fail} of ${pass + fail} fixture-port checks failed`);
		process.exit(1);
	}
	console.log(`✓ all ${pass} fixture-port hygiene checks passed`);
}

void main();
