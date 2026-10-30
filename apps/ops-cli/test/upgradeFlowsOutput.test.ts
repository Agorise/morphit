/**
 * What `morphit-ops upgrade` says when it does NOT install (v1.21.17 audit):
 * the real runUpgrade, in its own process (test/helpers/upgradeFlow.mts), with
 * stand-in system programs, a scratch v1.21.16 install and a signed v1.21.17.
 *
 *  M2  no release source answers / the download fails: raw "fetch failed" with
 *      no conclusion → what was tried in words, "Nothing was changed; this
 *      server still runs v1.21.16", the next step.
 *  M3  run without sudo: verified and downloaded, then "EACCES … rename"; with
 *      --heals ten confusing warnings and exit 0 → said first, nothing done.
 *  L3  Ctrl+C at "Apply upgrade?" said "(no answer on stdin — declining …)".
 *  L4  the question pointed at MORPHIT_AUTO_UPGRADE=1 (useless from the menu;
 *      sudo drops it), and stdin from /dev/null waited 20 s.
 *  L5  "This will: …" did not say it may recreate BunkerWeb, change its
 *      settings and ask Let's Encrypt for a certificate.
 *  L6  the release notes were printed as raw Markdown.
 *  L7  `upgrade --heals` said "Waiting for … to restart on the new version…"
 *      though nothing restarts, and ended with no warning count.
 *  L8  a rollback ended "Rolled back to previous install at …".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPS } from './helpers/pty.ts';

const FLOW = join(OPS, 'test', 'helpers', 'upgradeFlow.mts');
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'upgrade-flow-'));
	dirs.push(d);
	return d;
};

/** One flow; stdin from `input` ('' = /dev/null). */
function flow(
	mode: string,
	env: Record<string, string> = {},
	input: string | null = null
): { out: string; ms: number } {
	const t0 = Date.now();
	const r = spawnSync(process.execPath, ['--import', 'tsx', FLOW, mode, scratch()], {
		cwd: OPS,
		encoding: 'utf8',
		timeout: 150_000,
		env: { ...process.env, ...env },
		...(input === null ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input })
	});
	return {
		out: `${r.stdout ?? ''}${r.stderr ?? ''}`
			.split('\n')
			.filter((l) => !/^gpg:/.test(l))
			.join('\n'),
		ms: Date.now() - t0
	};
}

describe('nothing could be fetched (M2)', () => {
	it('no release source answers: what was tried, in words; nothing changed; the next step', () => {
		const { out } = flow('network');
		expect(out).toMatch(
			/Could not reach any place that publishes Morphit releases, so nothing was downloaded/
		);
		expect(out).toMatch(/127\.0\.0\.1:39123: refused the connection/);
		expect(out).not.toMatch(/fetch failed/);
		expect(out).toMatch(/Nothing was changed; this server still runs v1\.21\.16\./);
		expect(out).toMatch(
			/Next: once this server can reach 127\.0\.0\.1:39123 again .*on this server: sudo morphit-ops upgrade/
		);
		expect(out).toMatch(/=== exit code 5/);
	}, 180_000);

	describe('the release is listed but its download fails', () => {
		let server: ChildProcess;
		let port = 0;
		let ca = '';
		beforeAll(async () => {
			const d = scratch();
			ca = join(d, 'c.pem');
			spawnSync('openssl', [
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-days',
				'2',
				'-keyout',
				join(d, 'k.pem'),
				'-out',
				ca,
				'-subj',
				'/CN=127.0.0.1',
				'-addext',
				'subjectAltName=IP:127.0.0.1'
			]);
			const src = join(d, 'srv.mjs');
			writeFileSync(
				src,
				`import https from 'node:https';
import { readFileSync } from 'node:fs';
const s = https.createServer({ key: readFileSync(${JSON.stringify(join(d, 'k.pem'))}), cert: readFileSync(${JSON.stringify(ca)}) }, (req, res) => {
	const base = 'https://127.0.0.1:' + s.address().port;
	if (req.url.startsWith('/api/v1/repos/agorise/morphit/releases/latest')) {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ tag_name: 'v1.21.17', name: 'v1.21.17', body: '**Operators:** read \`this\`.', html_url: base + '/rel', published_at: new Date().toISOString(),
			assets: [ { name: 'morphit-v1.21.17.tar.gz', browser_download_url: base + '/dl/t.tar.gz' }, { name: 'morphit-v1.21.17.tar.gz.sha256', browser_download_url: base + '/dl/t.sha256' } ] }));
		return;
	}
	res.statusCode = 404; res.end('nope');
});
s.listen(0, '127.0.0.1', () => console.log(s.address().port));`
			);
			server = spawn(process.execPath, [src], { stdio: ['ignore', 'pipe', 'inherit'] });
			port = await new Promise<number>((r) =>
				server.stdout!.once('data', (b: Buffer) => r(Number(String(b).trim())))
			);
		});
		afterAll(() => {
			server?.kill();
		});
		it('nothing installed, said in words, with the next step; the notes are plain text (L6)', () => {
			const { out } = flow('download', {
				DL_HOST: `127.0.0.1:${port}`,
				NODE_EXTRA_CA_CERTS: ca
			});
			expect(out).toMatch(
				/v1\.21\.17 is listed, but its download did not complete from any place that publishes it, so nothing was installed/
			);
			expect(out).toMatch(/127\.0\.0\.1:\d+: answered HTTP 404/);
			expect(out).toMatch(/Nothing was changed; this server still runs v1\.21\.16\./);
			expect(out).toMatch(/Next: /);
			// L6: the release notes without their Markdown marks
			expect(out).toMatch(/^ {2}Operators: read this\.$/m);
			expect(out).not.toMatch(/\*\*Operators/);
			expect(out).toMatch(/=== exit code 5/);
		}, 180_000);
	});
});

describe('the confirmation question', () => {
	it('stdin from /dev/null: "no" at once, nothing changed; the hint names --yes, not an environment variable (L4)', () => {
		const { out, ms } = flow('prompt', {}, '');
		expect(out).toMatch(
			/\(To upgrade without this question, e\.g\. from a script: sudo morphit-ops upgrade --yes\)/
		);
		expect(out).not.toMatch(/MORPHIT_AUTO_UPGRADE/);
		expect(out).toMatch(/Not upgraded; nothing was changed\. This server still runs v1\.21\.16\./);
		expect(out).toMatch(/=== exit code 2/);
		// the whole flow (key generation, signing, the check) — but no 20 s wait
		expect(ms).toBeLessThan(15_000);
	}, 60_000);

	it('piped "y": it goes ahead', () => {
		const { out } = flow('prompt', {}, 'y\n');
		expect(out).toMatch(/Backing up /);
	}, 120_000);

	it('where BunkerWeb runs, the question says what it may do there (L5)', () => {
		const { out } = flow('prompt', { FLOW_BUNKERWEB: '1' }, '');
		expect(out).toMatch(
			/on the web firewall \(BunkerWeb\) it may change settings, recreate its containers, and ask Let's Encrypt to add the www address to the certificate/
		);
	}, 60_000);

	it('Ctrl+C at the question (a terminal): "Stopped — you pressed Ctrl+C. Nothing was changed." (L3)', async () => {
		const d = scratch();
		const child = spawn(
			'script',
			['-qec', `${process.execPath} --import tsx ${FLOW} prompt ${d}`, '/dev/null'],
			{ cwd: OPS, stdio: ['pipe', 'pipe', 'pipe'] }
		);
		let out = '';
		child.stdout.on('data', (b: Buffer) => (out += b));
		const closed = new Promise<void>((r) => child.on('close', () => r()));
		await vi.waitFor(
			() => {
				if (!/\[y\/N\]: /.test(out)) throw new Error('no question yet');
			},
			{ timeout: 90_000, interval: 200 }
		);
		child.stdin.write('\x03');
		await closed;
		expect(out).toMatch(/Stopped — you pressed Ctrl\+C\. Nothing was changed\./);
		expect(out).not.toMatch(/no answer on stdin/i);
		expect(out).toMatch(/=== exit code 130/);
		expect(readFileSync(join(d, 'morphit', 'release-info.json'), 'utf8')).toMatch(/v1\.21\.16/);
	}, 120_000);
});

describe('a rollback ends with a plain conclusion (L8)', () => {
	it('back on v1.21.16, where, why, and where the failed step’s full output is', () => {
		const { out } = flow('rollback');
		expect(out).toMatch(/✗ Not upgraded — this server is back on v1\.21\.16/);
		expect(out).toMatch(/The previous install is back in \S+morphit\./);
		expect(out).toMatch(
			/Why: the upgrade failed \(.+\)\. The step's full output, on this server: sudo cat \S+\.log/
		);
		expect(out).toMatch(/To try again later, on this server: sudo morphit-ops upgrade/);
		expect(out).not.toMatch(/Rolled back to previous install at/);
		expect(out).toMatch(/=== exit code 3/);
	}, 180_000);
});

describe('a whole upgrade (a self-contained release) says only what matters (L1)', () => {
	it('no line for the prebuilt frontend; the last word says it worked', () => {
		const { out } = flow('happy');
		expect(out).not.toMatch(/Using the prebuilt web frontend/);
		expect(out).toMatch(/✓ Success — your Morphit server is now running v1\.21\.17/);
		expect(out).toMatch(/=== exit code 0/);
	}, 180_000);
});

describe('without sudo (M3)', () => {
	const asNobody = (args: string): { out: string; status: number | null } => {
		const r = spawnSync(
			'su',
			[
				'-s',
				'/bin/sh',
				'nobody',
				'-c',
				`cd ${OPS} && HOME=/tmp NO_COLOR=1 ${process.execPath} --import tsx src/main.ts upgrade ${args}`
			],
			{ encoding: 'utf8', timeout: 90_000, env: { PATH: process.env.PATH ?? '' } }
		);
		return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
	};
	const root = process.getuid?.() === 0 && spawnSync('id', ['nobody']).status === 0;
	it.runIf(root)(
		'an upgrade: said first, nothing verified, downloaded or changed',
		() => {
			const r = asNobody('');
			expect(r.out).toMatch(
				/This needs the root account .*so nothing was done\. Run it with sudo: sudo morphit-ops upgrade\n/
			);
			expect(r.out).not.toMatch(/Downloading|Integrity|EACCES|Backing up/);
			expect(r.status).toBe(1);
		},
		120_000
	);
	it.runIf(root)(
		'--heals: the same, with its own command, and not exit 0',
		() => {
			const r = asNobody('--heals');
			expect(r.out).toMatch(/Run it with sudo: sudo morphit-ops upgrade --heals/);
			expect(r.out).not.toMatch(/\[WARN\]/);
			expect(r.status).toBe(1);
		},
		120_000
	);
});

describe('`upgrade --heals` (L7)', () => {
	it('waits for no restart, and ends with its warnings counted', async () => {
		vi.resetModules();
		const { runHealsAgain } = await import('../src/commands/upgrade.ts');
		const { warn } = await import('../src/render/term.ts');
		let out = '';
		const grab = (c: unknown): boolean => ((out += String(c)), true);
		vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
		vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
		let rc = -1;
		try {
			rc = await runHealsAgain({
				steps: () => [['a heal', () => warn('something to fix; on this server: sudo true')]],
				afterSteps: () => [['an after-restart check', async () => undefined]]
			});
		} finally {
			vi.restoreAllMocks();
		}
		expect(out).not.toMatch(/Waiting for .* to restart/);
		expect(out).toMatch(/Done, with one warning above \(the lines marked ⚠ or \[WARN\]\)/);
		expect(rc).toBe(1);
	});
});
