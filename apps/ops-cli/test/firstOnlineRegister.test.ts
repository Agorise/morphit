/**
 * When first-online cannot list the instance, its log says why.
 *
 * It ran `morphit-ops register --non-interactive` with all output thrown away,
 * then logged a generic list of possible causes. On 2026-10-12 a VPS that should
 * have listed itself did not, and nothing on the box said why.
 *
 * The real script runs here against stand-in commands (curl, npm, systemctl,
 * logger) on PATH and temporary paths for everything it touches.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../../../ops/first-online/morphit-first-online.sh', import.meta.url)
	.pathname;

function box(
	registerOut: string | Buffer,
	registerRc: number,
	opts: { rpcDone?: boolean; lang?: string } = {}
) {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-first-online-'));
	const bin = join(dir, 'bin');
	const ops = join(dir, 'opt');
	const state = join(dir, 'state');
	const le = join(dir, 'le');
	const log = join(dir, 'journal.log');
	for (const d of [bin, ops, join(ops, 'apps/web/build'), state, join(le, 'vigilante.trading')])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(le, 'vigilante.trading/fullchain.pem'), 'x');
	writeFileSync(join(ops, 'apps/web/build/canary.txt'), 'x');
	if (opts.rpcDone !== false) writeFileSync(join(state, 'rpc.done'), '');
	writeFileSync(join(ops, 'morphit.env'), 'MORPHIT_RELAY_ACCOUNT=vigil-relay\n');
	writeFileSync(join(ops, 'morphit.config.env'), 'MORPHIT_INSTANCE_NAME="Vigilante Trading"\n');
	const env = join(dir, 'first-online.env');
	writeFileSync(
		env,
		`MORPHIT_DOMAIN=vigilante.trading\nMORPHIT_AUTO_REGISTER=yes\nMORPHIT_OPS_DIR=${ops}\n`
	);
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub('curl', 'exit 0');
	stub('systemctl', `printf '%s\\n' "$*" >> '${join(dir, 'systemctl.log')}'`);
	stub('logger', `shift 2; [ "$1" = "--" ] && shift; printf '%s\\n' "$*" >> '${log}'`);
	if (typeof registerOut === 'string')
		stub('npm', `printf '%s\\n' '${registerOut.replace(/'/g, `'\\''`)}'; exit ${registerRc}`);
	else {
		// Raw bytes (a NUL, a lone 8-bit byte): a shell string cannot carry them.
		writeFileSync(join(dir, 'register.out'), registerOut);
		stub('npm', `cat '${join(dir, 'register.out')}'; exit ${registerRc}`);
	}
	const r = spawnSync('sh', [SCRIPT], {
		encoding: 'utf8',
		env: {
			PATH: `${bin}:/usr/bin:/bin`,
			MORPHIT_FIRST_ONLINE_STATE_DIR: state,
			MORPHIT_FIRST_ONLINE_ENV: env,
			MORPHIT_FIRST_ONLINE_LE_LIVE: le,
			MORPHIT_FIRST_ONLINE_RELAY_ENV: join(dir, 'none'),
			MORPHIT_FIRST_ONLINE_INDEXER_ENV: join(dir, 'none'),
			...(opts.lang ? { LANG: opts.lang } : {})
		}
	});
	return {
		rc: r.status,
		log: existsSync(log) ? readFileSync(log, 'utf8') : '',
		logBytes: existsSync(log) ? readFileSync(log) : Buffer.alloc(0),
		registered: existsSync(join(state, 'register.done')),
		systemctl: existsSync(join(dir, 'systemctl.log'))
			? readFileSync(join(dir, 'systemctl.log'), 'utf8').trim().split('\n')
			: []
	};
}

describe('first-online listing', () => {
	it('a failed registration logs the reason register gave', () => {
		const why = '✗ Failed to load relay account key: passphrase file "/x" is empty';
		const b = box(`Morphit register\n  Account: @vigil-relay\n${why}`, 1);
		expect(b.rc).toBe(0);
		expect(b.registered).toBe(false);
		expect(b.log).toContain('passphrase file "/x" is empty');
	});

	it('terminal control codes in that output never reach the log', () => {
		const b = box('\u001b[2J\u001b[31mboom\u001b[0m', 1);
		expect(b.log).toContain('boom');
		expect(b.log).not.toContain('\u001b');
		// The whole sequence goes, not only its ESC byte.
		expect(b.log).not.toContain('[31m');
	});

	it('8-bit control codes (CSI, OSC as UTF-8), BEL and CR are dropped; a long line is cut', () => {
		const b = box(`x\u009b2Jy\u009d0;evil\u0007z\rw ${'A'.repeat(20_000)}`, 1);
		// The control bytes go; what they carried stays as plain text.
		expect(b.log).toMatch(/register: x2Jy0;evilzw A+/);
		expect(b.log).not.toMatch(/[\u0080-\u009f\u0007\r]/);
		for (const line of b.log.split('\n')) expect(line.length).toBeLessThan(400);
	});

	it('raw bytes: no 8-bit control byte reaches the log, and a NUL or a bad byte hides no ✗ line', () => {
		const out = Buffer.concat([
			Buffer.from('\u2717 bad \u0000 key\n', 'utf8'),
			Buffer.from('line1 '),
			Buffer.from([0x9b]),
			Buffer.from('2J tail \xff\n', 'latin1'),
			// A long line whose cut falls inside a 2-byte character.
			Buffer.from(`${'A'.repeat(299)}\u00e9\u00e9\n`, 'utf8'),
			// The ✗ line is more than 4 lines from the end: only grep finds it.
			Buffer.from('a\nb\nc\nd\n')
		]);
		for (const lang of [undefined, 'C.UTF-8']) {
			const b = box(out, 1, { lang });
			// Before: grep called the output binary and dropped the ✗ line, and
			// the raw 0x9b (a terminal CSI) went into the journal.
			expect(b.log, String(lang)).toMatch(/register: ✗ bad +key/);
			expect([...b.logBytes].filter((x) => x === 0x9b || x === 0x00 || x === 0xff)).toEqual([]);
			expect(b.logBytes.toString('utf8')).not.toContain('\ufffd');
			expect(b.log).toContain('register: d');
		}
	});

	it('a bad byte between the halves of an 8-bit control code does not let it through', () => {
		for (const bytes of [
			[0x78, 0xc2, 0xc2, 0x85, 0x9b, 0x32, 0x4a, 0x79, 0x0a],
			[0x78, 0xc2, 0x1b, 0x5b, 0x30, 0x6d, 0x9b, 0x32, 0x4a, 0x0a]
		]) {
			const b = box(Buffer.from(bytes), 1);
			expect(
				[...b.logBytes].filter((x) => x === 0x9b || x === 0x85),
				JSON.stringify(bytes)
			).toEqual([]);
		}
	});

	it('a line cut at 300 bytes never ends in half a character', () => {
		const b = box(Buffer.from(`${'A'.repeat(299)}\u00e9\u00e9\n`, 'utf8'), 1);
		expect(b.log).toMatch(/register: A{299}\n/);
		expect(b.logBytes.toString('utf8')).not.toContain('\ufffd');
	});

	it('a ✗ line far from the end is logged too, and a line is logged once', () => {
		const out = [
			'Morphit register',
			'✗ Indexer at http://127.0.0.1:8081 did not answer',
			...Array.from({ length: 8 }, (_, i) => `step ${i}`),
			'✗ Not registered'
		].join('\n');
		const b = box(out, 1);
		expect(b.log).toContain('register: ✗ Indexer at http://127.0.0.1:8081 did not answer');
		// In the ✗ lines and in the last lines: once.
		expect(b.log.match(/register: ✗ Not registered/g)).toHaveLength(1);
		expect(b.log).toContain('register: step 7');
		expect(b.log).not.toContain('register: step 2');
	});

	it('a successful registration is marked done', () => {
		const b = box('Registration broadcast successfully.', 0);
		expect(b.registered).toBe(true);
		expect(b.log).toContain('on-chain registration complete');
	});

	it('the first-online nudge never STARTS a stopped unit (the indexer may be stopped for a restore)', () => {
		const b = box('ok', 0, { rpcDone: false });
		expect(b.systemctl).toContain('try-restart morphit-indexer.service');
		expect(b.systemctl).toContain('try-restart morphit-relay.service');
		expect(b.systemctl.some((l) => /^restart /.test(l))).toBe(false);
	});
});
