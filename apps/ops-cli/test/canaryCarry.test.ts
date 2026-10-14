/**
 * The warrant canary across `morphit-ops upgrade` (v1.21.8): the canary served
 * before the upgrade is served again, byte for byte — never through a link
 * (in the file's name or any folder above it), a hard link, a device, a huge
 * file or something that only claims to be a canary — and the last lines ask
 * for a re-sign only when it runs out soon, or for the key when it is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARY_SERVED_FILES, carryCanaryForward } from '../src/lib/canaryCarry.ts';

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];
const stamp = (ms: number): string => {
	const d = new Date(ms);
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${d.getUTCFullYear()} @ ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
};

/** A canary shaped exactly as generate.sh's `gpg --clearsign` writes it;
 *  `headline` lands in it raw, as the news headline does. */
function canary(validThroughMs: number, headline: Buffer = Buffer.from('Markets calm')): Buffer {
	const head = [
		'-----BEGIN PGP SIGNED MESSAGE-----',
		'Hash: SHA512',
		'',
		'=== MORPHIT CANARY ===',
		'',
		'Morphit operator canary - Example',
		'Instance: https://example.org',
		`Generated: ${stamp(validThroughMs - 14 * 86_400_000)}`,
		`Valid through: ${stamp(validThroughMs)}`,
		'',
		'Headline: '
	].join('\n');
	const tail = [
		'',
		'-----BEGIN PGP SIGNATURE-----',
		'',
		'iQIzBAEBCgAdFiEEe0wdGJ27YQxHO1ntU1JOHxAX65wFAmcAAAAACgkQU1JOHxAX',
		'=1mQb',
		'-----END PGP SIGNATURE-----',
		''
	].join('\n');
	return Buffer.concat([Buffer.from(head), headline, Buffer.from(tail)]);
}
const PUBKEY = [
	'-----BEGIN PGP PUBLIC KEY BLOCK-----',
	'',
	'mQINBGcAAAABEADExample',
	'=abcd',
	'-----END PGP PUBLIC KEY BLOCK-----',
	''
].join('\n');
const DAY = 86_400_000;

let d = '';
let from = '';
let to = '';
const carry = () => carryCanaryForward(from, to, { trustedRoot: d });

/** The state files the upgrade's last lines read, pointed into the test's own
 *  folder: the machine's real ones (a server's web-heal record, say) must not
 *  change what these tests see. */
const STATE_ENV = [
	'MORPHIT_UPGRADE_WARNINGS_FILE',
	'MORPHIT_UPGRADE_QUESTIONS_FILE',
	'MORPHIT_WEB_HEAL_STATE',
	'MORPHIT_WEB_HEAL_LOG',
	'MORPHIT_AFTER_RESTART_LOG',
	'MORPHIT_STEP_LOG_DIR'
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	d = mkdtempSync(join(tmpdir(), 'canary-carry-'));
	from = join(d, 'old', 'apps', 'web', 'build');
	to = join(d, 'new-build');
	mkdirSync(from, { recursive: true });
	mkdirSync(to);
	for (const k of STATE_ENV) savedEnv[k] = process.env[k];
	process.env.MORPHIT_UPGRADE_WARNINGS_FILE = join(d, 'upgrade-warnings');
	process.env.MORPHIT_UPGRADE_QUESTIONS_FILE = join(d, 'upgrade-questions');
	process.env.MORPHIT_WEB_HEAL_STATE = join(d, 'web-heal.json');
	process.env.MORPHIT_WEB_HEAL_LOG = join(d, 'web-heal.log');
	process.env.MORPHIT_AFTER_RESTART_LOG = join(d, 'after-upgrade-heal.log');
	process.env.MORPHIT_STEP_LOG_DIR = join(d, 'step-logs');
});
afterEach(() => {
	rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
	for (const k of STATE_ENV) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe('carryCanaryForward', () => {
	it('puts the signed canary and its public key back, byte for byte, readable by the web server', () => {
		const valid = Date.UTC(2026, 9, 27, 22, 21, 17);
		writeFileSync(join(from, 'canary.txt'), canary(valid));
		writeFileSync(join(from, 'pgp_keys.asc'), PUBKEY);
		chmodSync(join(from, 'canary.txt'), 0o600);
		const r = carry();
		expect(r.carried).toEqual(['canary.txt', 'pgp_keys.asc']);
		expect(r.skipped).toEqual([]);
		expect(readFileSync(join(to, 'canary.txt')).equals(canary(valid))).toBe(true);
		expect(readFileSync(join(to, 'pgp_keys.asc'), 'utf8')).toBe(PUBKEY);
		expect(statSync(join(to, 'canary.txt')).mode & 0o777).toBe(0o644);
		expect(r.validThrough).toBe('27 October, 2026 @ 22:21:17 UTC');
		expect(r.validThroughMs).toBe(valid);
	});

	it('a canary with bytes that are not UTF-8 (a Latin-1 headline) is copied unchanged — its signature still holds', () => {
		const bytes = canary(Date.UTC(2026, 9, 27), Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0xed]));
		writeFileSync(join(from, 'canary.txt'), bytes);
		expect(carry().carried).toEqual(['canary.txt']);
		expect(readFileSync(join(to, 'canary.txt')).equals(bytes)).toBe(true);
	});

	it('readable by the web server even when root runs with a strict umask (077)', () => {
		writeFileSync(join(from, 'canary.txt'), canary(Date.UTC(2026, 9, 27)));
		const old = process.umask(0o077);
		try {
			expect(carry().carried).toEqual(['canary.txt']);
		} finally {
			process.umask(old);
		}
		expect(statSync(join(to, 'canary.txt')).mode & 0o777).toBe(0o644);
	});

	it('a signed message that is not a Morphit canary is not copied', () => {
		const other = Buffer.from(
			canary(Date.UTC(2026, 9, 27))
				.toString('latin1')
				.replace('=== MORPHIT CANARY ===', 'Hello'),
			'latin1'
		);
		writeFileSync(join(from, 'canary.txt'), other);
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(r.skipped).toEqual([{ name: 'canary.txt', why: 'it is not a signed canary' }]);
	});

	it('a key block with a line that is neither an armor header nor base64 is not copied', () => {
		const odd = PUBKEY.replace(
			'-----BEGIN PGP PUBLIC KEY BLOCK-----\n',
			'-----BEGIN PGP PUBLIC KEY BLOCK-----\n<script>alert(1)</script>\n'
		);
		writeFileSync(join(from, 'pgp_keys.asc'), odd);
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(r.skipped).toEqual([{ name: 'pgp_keys.asc', why: 'it is not a public key' }]);
	});

	it('nothing there before: nothing carried, nothing to report', () => {
		expect(carry()).toMatchObject({
			carried: [],
			skipped: [],
			validThrough: null
		});
	});

	it('never follows a link in the file name — a planted link to a root-only file is not copied out', () => {
		const secret = join(d, 'secret');
		// Even a target that LOOKS like a canary: the link itself is refused.
		writeFileSync(secret, canary(Date.now() + 9 * DAY));
		symlinkSync(secret, join(from, 'canary.txt'));
		symlinkSync('/etc/passwd', join(from, 'pgp_keys.asc'));
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(r.skipped.map((s) => s.why)).toEqual(['it is a link', 'it is a link']);
		expect(existsSync(join(to, 'canary.txt'))).toBe(false);
		expect(existsSync(join(to, 'pgp_keys.asc'))).toBe(false);
	});

	it('never through a linked folder above it — the old build folder swapped for a link to a root-only folder', () => {
		const rootOnly = join(d, 'root-only');
		mkdirSync(rootOnly, { mode: 0o700 });
		writeFileSync(join(rootOnly, 'pgp_keys.asc'), PUBKEY, { mode: 0o600 });
		rmSync(from, { recursive: true });
		symlinkSync(rootOnly, from);
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(r.skipped).toEqual([
			{ name: 'pgp_keys.asc', why: 'the old served folder is reached through a link' }
		]);
		// …or a folder further up (the install belongs to the uploader).
		rmSync(from);
		const web = join(d, 'old', 'apps', 'web');
		rmSync(web, { recursive: true });
		mkdirSync(join(rootOnly, 'build'));
		writeFileSync(join(rootOnly, 'build', 'pgp_keys.asc'), PUBKEY, { mode: 0o600 });
		symlinkSync(rootOnly, web);
		expect(carry().carried).toEqual([]);
	});

	it('a hard link (a second name for a root-only file) is not copied', () => {
		const secret = join(d, 'secret.asc');
		writeFileSync(secret, PUBKEY, { mode: 0o600 });
		linkSync(secret, join(from, 'pgp_keys.asc'));
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(r.skipped).toEqual([{ name: 'pgp_keys.asc', why: 'it has other names (a hard link)' }]);
	});

	it('a hard link removed the instant after the file is opened (a race) is still not copied', () => {
		const secret = join(d, 'secret.asc');
		writeFileSync(secret, PUBKEY, { mode: 0o600 });
		const planted = join(from, 'pgp_keys.asc');
		linkSync(secret, planted);
		// The attacker drops the planted name between the open and the checks
		// (the link count is then 1 again).
		const r = carryCanaryForward(from, to, {
			trustedRoot: d,
			_beforeChecks: () => unlinkSync(planted)
		});
		expect(r.carried).toEqual([]);
		expect(r.skipped).toEqual([{ name: 'pgp_keys.asc', why: 'it is reached through a link' }]);
		expect(existsSync(join(to, 'pgp_keys.asc'))).toBe(false);
	});

	it('a FIFO in its place does not hang the upgrade, and is not copied', () => {
		expect(spawnSync('mkfifo', [join(from, 'canary.txt')]).status).toBe(0);
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(r.skipped).toEqual([{ name: 'canary.txt', why: 'not a regular file' }]);
	});

	it('only a whole signed Morphit canary and whole PUBLIC key blocks are copied', () => {
		writeFileSync(join(from, 'canary.txt'), 'root:x:0:0:root:/root:/bin/bash\n');
		writeFileSync(
			join(from, 'pgp_keys.asc'),
			'-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQ\n'
		);
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(r.skipped.map((s) => s.why)).toEqual([
			'it is not a signed canary',
			'it is not a public key'
		]);
		const bad = [
			// a key's first line, then anything
			['pgp_keys.asc', '-----BEGIN PGP PUBLIC KEY BLOCK-----\nhunter2\n'],
			// a real block with something after it
			['pgp_keys.asc', `${PUBKEY}password=hunter2\n`],
			// the unsigned template
			['canary.txt', '=== MORPHIT CANARY ===\nValid through: {{VALID_THROUGH_ISO}}\n'],
			// a canary's head with no signature
			[
				'canary.txt',
				'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n=== MORPHIT CANARY ===\nsecret\n'
			],
			// a signature followed by something else
			['canary.txt', `${canary(Date.now()).toString()}trailing secret\n`],
			// something else before the signed message
			['canary.txt', `leading secret\n${canary(Date.now()).toString()}`],
			// a signature that never ends
			[
				'canary.txt',
				canary(Date.now())
					.toString()
					.replace(/=1mQb\n-----END PGP SIGNATURE-----\n$/, 'AAAA\n')
			],
			// only blank lines
			['pgp_keys.asc', '\n  \n\n'],
			// a key block with a line that is not base64 inside it
			[
				'pgp_keys.asc',
				'-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQIN\nroot:x:0:0:root:/root\n=abcd\n-----END PGP PUBLIC KEY BLOCK-----\n'
			],
			// no blank line between the BEGIN line and the body
			[
				'pgp_keys.asc',
				'-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQIN\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----\n'
			]
		];
		for (const [name, text] of bad) {
			rmSync(join(from, 'canary.txt'), { force: true });
			rmSync(join(from, 'pgp_keys.asc'), { force: true });
			writeFileSync(join(from, name!), text!);
			expect(carry().carried, text).toEqual([]);
		}
		// Two public key blocks (a key and its successor) are a public key file.
		rmSync(join(from, 'canary.txt'), { force: true });
		writeFileSync(join(from, 'pgp_keys.asc'), `${PUBKEY}\n${PUBKEY}`);
		expect(carry().carried).toEqual(['pgp_keys.asc']);
	});

	it('a file too large to be a canary is not read', () => {
		const max = CANARY_SERVED_FILES.find((f) => f.name === 'canary.txt')!.maxBytes;
		writeFileSync(join(from, 'canary.txt'), Buffer.concat([canary(Date.now()), Buffer.alloc(max)]));
		const r = carry();
		expect(r.skipped).toEqual([{ name: 'canary.txt', why: `larger than ${max} bytes` }]);
	});

	it('a public key with many signatures (300 kB) is still a public key', () => {
		const body = Array.from({ length: 5000 }, () => 'A'.repeat(64)).join('\n');
		const big = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${body}\n=abcd\n-----END PGP PUBLIC KEY BLOCK-----\n`;
		writeFileSync(join(from, 'pgp_keys.asc'), big);
		expect(carry().carried).toEqual(['pgp_keys.asc']);
	});

	it('a file the new install already has is left alone', () => {
		writeFileSync(join(from, 'canary.txt'), canary(Date.now() + 9 * DAY));
		writeFileSync(join(to, 'canary.txt'), 'NEW');
		const r = carry();
		expect(r.carried).toEqual([]);
		expect(readFileSync(join(to, 'canary.txt'), 'utf8')).toBe('NEW');
	});

	it('a crafted key file (millions of "=" lines) is skipped, never thrown on, and the canary still carried', () => {
		writeFileSync(join(from, 'canary.txt'), canary(Date.now() + 9 * DAY));
		const crafted = `-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: x\n\n${'=\n'.repeat(4_000_000)}`;
		writeFileSync(join(from, 'pgp_keys.asc'), crafted);
		const t0 = Date.now();
		const r = carry();
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(r.carried).toEqual(['canary.txt']);
		expect(r.skipped).toEqual([{ name: 'pgp_keys.asc', why: 'it is not a public key' }]);
	});

	it('what real gpg writes is accepted: CRLF line ends, Version/Comment armor headers', () => {
		const crlf = Buffer.from(
			canary(Date.UTC(2026, 9, 27))
				.toString('latin1')
				.replace(/\n/g, '\r\n'),
			'latin1'
		);
		writeFileSync(join(from, 'canary.txt'), crlf);
		writeFileSync(
			join(from, 'pgp_keys.asc'),
			PUBKEY.replace('-----\n\n', '-----\nVersion: GnuPG v2\nComment: example\n\n')
		);
		expect(carry().carried).toEqual(['canary.txt', 'pgp_keys.asc']);
		expect(readFileSync(join(to, 'canary.txt')).equals(crlf)).toBe(true);
	});

	it('a write that fails leaves nothing behind in the served folder', async () => {
		writeFileSync(join(from, 'canary.txt'), canary(Date.now() + 9 * DAY));
		writeFileSync(join(from, 'pgp_keys.asc'), PUBKEY);
		vi.resetModules();
		vi.doMock('node:fs', async () => {
			const real = await vi.importActual<typeof import('node:fs')>('node:fs');
			return {
				...real,
				renameSync: () => {
					throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
				}
			};
		});
		try {
			const m = await import('../src/lib/canaryCarry.ts');
			const r = m.carryCanaryForward(from, to, { trustedRoot: d });
			expect(r.carried).toEqual([]);
			expect(r.skipped.map((s) => s.why)).toEqual([
				'could not write it (ENOSPC)',
				'could not write it (ENOSPC)'
			]);
			expect(readdirSync(to)).toEqual([]);
		} finally {
			vi.doUnmock('node:fs');
			vi.resetModules();
		}
	});
});

// Each case imports upgrade.ts afresh (a few seconds on a busy box).
describe("the upgrade's words about a carried canary", { timeout: 60_000 }, () => {
	type Up = typeof import('../src/commands/upgrade.ts');
	async function fresh(): Promise<Up> {
		vi.resetModules();
		return await import('../src/commands/upgrade.ts');
	}
	async function said(fn: () => unknown): Promise<string> {
		let out = '';
		const grab = (c: unknown): boolean => {
			out += String(c);
			return true;
		};
		vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
		vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
		await fn();
		vi.restoreAllMocks();
		return out;
	}
	const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
	const summary = (up: Up): string[] =>
		up.upgradeSummaryLines(
			up.gatherUpgradeSummary(
				{
					from: 'v1.21.7',
					to: 'v1.21.8',
					backupDir: '/opt/morphit.bak-1',
					schemaChanged: false,
					canaryCleared: false,
					frontendVerified: true,
					startedMs: NOW,
					healChildRan: false
				},
				{ isActive: () => false, unitExists: () => false }
			)
		);
	const carried = (validMs: number, skipped: { name: string; why: string }[] = []) => ({
		validThrough: Number.isFinite(validMs) ? stamp(validMs) : null,
		validThroughMs: validMs,
		skipped
	});

	it('a canary with days to run: served again, nothing left to do', async () => {
		const up = await fresh();
		const out = await said(() => up.reportCarriedCanary(carried(NOW + 13 * DAY), NOW, () => false));
		expect(out).toMatch(
			/the one you signed before the upgrade is served again, unchanged \(valid through 27 October, 2026/
		);
		const last = summary(up).join('\n');
		expect(last).not.toMatch(/canary/i);
		expect(last).toMatch(/Nothing else to do/);
	});

	it('one that runs out within days: the last lines ask for a re-sign, where it is signed', async () => {
		const up = await fresh();
		await said(() => up.reportCarriedCanary(carried(NOW + 2 * DAY), NOW, () => false));
		expect(summary(up).join('\n')).toMatch(
			/Re-sign the warrant canary \(the one served again runs out on 16 October, 2026 @ 12:00:00 UTC\) on the computer that holds its key: bash ~\/\.morphit\/update-canary\.sh/
		);
		const up2 = await fresh();
		await said(() =>
			up2.reportCarriedCanary(carried(NOW + 2 * DAY), NOW, (u) => u === 'morphit-canary.timer')
		);
		expect(summary(up2).join('\n')).toMatch(
			/on this server: sudo systemctl start morphit-canary\.service/
		);
	});

	it('one that ran out, or has no date: named as such, never called current', async () => {
		const up = await fresh();
		const out = await said(() => up.reportCarriedCanary(carried(NOW - DAY), NOW, () => false));
		expect(out).toMatch(/but it ran out on 13 October, 2026/);
		expect(out).not.toMatch(/✓/);
		expect(summary(up).join('\n')).toMatch(
			/Re-sign the warrant canary \(the one served again ran out on/
		);
		const up2 = await fresh();
		await said(() => up2.reportCarriedCanary(carried(NaN), NOW, () => false));
		expect(summary(up2).join('\n')).toMatch(/has no readable "Valid through" date/);
	});

	it('the canary put back without its public key: the last lines ask for the key, never "Nothing else to do"', async () => {
		const up = await fresh();
		await said(() =>
			up.reportCarriedCanary(
				carried(NOW + 13 * DAY, [{ name: 'pgp_keys.asc', why: 'larger than 8388608 bytes' }]),
				NOW,
				() => false
			)
		);
		const last = summary(up).join('\n');
		expect(last).toMatch(
			/Publish the warrant canary's public key again \(\/pgp_keys\.asc was not put back: larger than 8388608 bytes\) on the computer that holds its key/
		);
		expect(last).not.toMatch(/Nothing else to do/);
	});

	it('a public key the new install already has: nothing to publish again', async () => {
		const up = await fresh();
		await said(() =>
			up.reportCarriedCanary(
				carried(NOW + 13 * DAY, [{ name: 'pgp_keys.asc', why: 'the new install already has one' }]),
				NOW,
				() => false
			)
		);
		expect(summary(up).join('\n')).not.toMatch(/public key/);
	});

	it('after a same-server refresh replaced it, the put-back canary is not reported; otherwise it is', async () => {
		const up = await fresh();
		const c = {
			carried: ['canary.txt'],
			skipped: [],
			validThrough: stamp(NOW + 2 * DAY),
			validThroughMs: NOW + 2 * DAY
		};
		const quiet = await said(() => up.afterCanaryRefresh(c, true, NOW, () => false));
		expect(quiet).toBe('');
		expect(summary(up).join('\n')).not.toMatch(/canary/i);
		const up2 = await fresh();
		const loud = await said(() => up2.afterCanaryRefresh(c, false, NOW, () => false));
		expect(loud).toMatch(/served again, unchanged, but it runs out on/);
	});

	it('the canary is called cleared only when there was one, nothing re-signed it, and it was not put back', async () => {
		const up = await fresh();
		const put = (names: string[]) => ({
			carried: names,
			skipped: [],
			validThrough: stamp(NOW + 2 * DAY),
			validThroughMs: NOW + 2 * DAY
		});
		// [autoRefreshed, hadCanary, carried] → cleared
		const cases: [boolean, boolean, ReturnType<typeof put> | null, boolean][] = [
			[false, true, null, true],
			[false, true, put([]), true],
			[false, true, put(['pgp_keys.asc']), true],
			[false, true, put(['canary.txt']), false],
			[false, true, put(['canary.txt', 'pgp_keys.asc']), false],
			[true, true, null, false],
			[true, true, put(['canary.txt']), false],
			[false, false, null, false],
			[false, false, put(['canary.txt']), false]
		];
		for (const [auto, had, carried, want] of cases)
			expect(
				up.canaryClearedByUpgrade(auto, had, carried),
				JSON.stringify([auto, had, carried])
			).toBe(want);
	});

	it('the old install is the trusted root: a link anywhere inside it stops the carry', async () => {
		const up = await fresh();
		const backup = join(d, 'morphit.bak-1');
		const elsewhere = join(d, 'elsewhere');
		mkdirSync(join(elsewhere, 'web', 'build'), { recursive: true });
		writeFileSync(join(elsewhere, 'web', 'build', 'canary.txt'), canary(NOW + 13 * DAY));
		mkdirSync(backup);
		symlinkSync(elsewhere, join(backup, 'apps'));
		const install = join(d, 'morphit');
		mkdirSync(join(install, 'apps', 'web', 'build'), { recursive: true });
		let r: ReturnType<Up['carryOldCanary']> = null;
		const out = await said(() => {
			r = up.carryOldCanary(backup, install);
		});
		expect(r!.carried).toEqual([]);
		expect(out).toMatch(
			/canary\.txt from before the upgrade was not put back: the old served folder is reached through a link/
		);
		expect(existsSync(join(install, 'apps', 'web', 'build', 'canary.txt'))).toBe(false);
	});
});
