/**
 * The installed-box heal that takes the indexer and relay off root,
 * against a simulated box: users and groups, files, the install tree's
 * ownership listing, and systemd services whose process uid follows the unit
 * (User=) and the fallback drop-in — so the assertions are about what would
 * run as whom, not about messages.
 */
import { spawnSync } from 'node:child_process';
import { chownSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	FALLBACK_DROPIN,
	PERMS_HELPER,
	healServicePrivileges,
	matrixBotPostureText,
	parseShow,
	selfHealDeadline,
	treeFindArgs,
	treeFixArgs,
	unitUser,
	type PrivilegeRuntime
} from '../src/lib/unitPrivilegeHeal.ts';

const SYSD = '/etc/systemd/system';
const HELPERS = '/usr/local/lib/morphit';
const INSTALL = '/opt/morphit';
const NEW_INDEXER_UNIT = '[Service]\nUser=morphit-indexer\nGroup=morphit-indexer\n';
const NEW_RELAY_UNIT = '[Service]\nUser=morphit-relay\nGroup=morphit-relay\n';

interface Svc {
	active: boolean;
	pid: number;
	uid: number;
	restarts: number;
	port: number;
	/** The address it listens on ('0.0.0.0' = every address). */
	host: string;
	/** When it was last started (its listener opens `slow` ms later). */
	since: number;
}

class Box {
	t = 0;
	files = new Map<string, string>();
	users = new Map<string, { uid: number; groups: Set<string> }>();
	groups = new Set<string>(['root']);
	treeBad = [`${INSTALL}/node_modules/.bin/tsx`, `${INSTALL}/ops/scripts/morphit-host-monitor.sh`];
	treeStubborn = false;
	svc = new Map<string, Svc>();
	/** Users a service cannot run as (it exits at once). */
	failsAs = new Set<string>();
	/** A service that answers, then crash-loops. */
	flaps = new Set<string>();
	revertTimerActive = false;
	/** Units an operator's own drop-in keeps on root whatever the unit says. */
	pinnedRoot = new Set<string>();
	/** How long a unit takes, after a start, before its port answers. */
	slow = new Map<string, number>();
	restartsDone: string[] = [];
	calls: string[][] = [];
	nextUid = 900;
	nextPid = 100;
	info: string[] = [];
	warn: string[] = [];
	spinners = 0;

	constructor() {
		this.files.set(`${SYSD}/morphit-indexer.service`, NEW_INDEXER_UNIT);
		this.files.set(`${SYSD}/morphit-relay.service`, NEW_RELAY_UNIT);
		this.files.set(`${INSTALL}/ops/scripts/${PERMS_HELPER}`, '#!/bin/sh\n# helper v2\n');
		this.files.set('/etc/morphit/indexer.env', 'MORPHIT_INDEXER_LISTEN_PORT=8081\n');
		this.files.set('/etc/morphit/relay.env', 'MORPHIT_RELAY_LISTEN_PORT="8080"\n');
		// running as root, as before this release
		this.svc.set('morphit-indexer.service', {
			active: true,
			pid: 10,
			uid: 0,
			restarts: 0,
			port: 8081,
			host: '127.0.0.1',
			since: 0
		});
		this.svc.set('morphit-relay.service', {
			active: true,
			pid: 11,
			uid: 0,
			restarts: 0,
			port: 8080,
			host: '127.0.0.1',
			since: 0
		});
	}
	userOfUnit(unit: string): string {
		const drop = this.files.get(`${SYSD}/${unit}.d/${FALLBACK_DROPIN}`);
		if (drop && /User=root/.test(drop)) return 'root';
		return unitUser(this.files.get(`${SYSD}/${unit}`) ?? '');
	}
	start(unit: string): void {
		const s = this.svc.get(unit)!;
		const user = this.userOfUnit(unit);
		const uid = user === 'root' || this.pinnedRoot.has(unit) ? 0 : this.users.get(user)?.uid;
		s.restarts = 0;
		if (uid === undefined || this.failsAs.has(user)) {
			s.active = false;
			s.pid = 0;
			return;
		}
		s.active = true;
		s.pid = this.nextPid++;
		s.uid = uid;
		s.since = this.t;
	}
	readonly rt: PrivilegeRuntime = {
		now: () => this.t,
		sleep: async (ms) => {
			this.t += ms;
			for (const u of this.flaps) {
				const s = this.svc.get(u)!;
				if (s.active && this.userOfUnit(u) !== 'root') {
					s.pid = this.nextPid++;
					s.restarts++;
				}
			}
		},
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, d) => (this.files.set(p, d), true),
		removeFile: (p) => (this.files.delete(p), true),
		uidOf: (u) => this.users.get(u)?.uid ?? null,
		groupExists: (g) => this.groups.has(g),
		groupsOf: (u) => [...(this.users.get(u)?.groups ?? [])],
		procUid: (pid) => [...this.svc.values()].find((s) => s.active && s.pid === pid)?.uid ?? null,
		httpAnswers: async (url) => {
			this.t += 100;
			const m = /^http:\/\/\[?([^\]/]+?)\]?:(\d+)\//.exec(url);
			const host = m?.[1] ?? '';
			const port = Number(m?.[2]);
			return [...this.svc.entries()].some(
				([u, s]) =>
					s.active &&
					s.port === port &&
					(s.host === host || (s.host === '0.0.0.0' && /^127\./.test(host))) &&
					this.t - s.since >= (this.slow.get(u) ?? 0)
			);
		},
		run: (cmd, args) => {
			this.calls.push([cmd, ...args]);
			this.t += 200;
			if (cmd === 'groupadd') {
				this.groups.add(args[args.length - 1]!);
				return { ok: true, out: '' };
			}
			if (cmd === 'useradd') {
				const name = args[args.length - 1]!;
				const gi = args.indexOf('--groups');
				this.users.set(name, {
					uid: this.nextUid++,
					groups: new Set([
						args[args.indexOf('--gid') + 1]!,
						...(gi >= 0 ? args[gi + 1]!.split(',') : [])
					])
				});
				return { ok: true, out: '' };
			}
			if (cmd === 'usermod') {
				this.users.get(args[args.length - 1]!)?.groups.add(args[args.indexOf('--groups') + 1]!);
				return { ok: true, out: '' };
			}
			if (cmd === 'test') return { ok: this.files.has(args[1]!), out: '' };
			if (cmd === 'rm') {
				this.files.delete(args[args.length - 1]!);
				return { ok: true, out: '' };
			}
			if (cmd === 'find') {
				if (args.includes('-exec')) {
					if (!this.treeStubborn) this.treeBad = [];
					return { ok: true, out: '' };
				}
				return { ok: true, out: this.treeBad.join('\n') };
			}
			if (cmd === 'systemctl') {
				if (args[0] === 'restart') {
					this.restartsDone.push(args[1]!);
					this.start(args[1]!);
					return { ok: this.svc.get(args[1]!)!.active, out: '' };
				}
				if (args[0] === 'is-active') return { ok: this.revertTimerActive, out: '' };
				if (args[0] === 'show') {
					const s = this.svc.get(args[1]!)!;
					return {
						ok: true,
						out: `ActiveState=${s.active ? 'active' : 'failed'}\nMainPID=${s.pid}\nNRestarts=${s.restarts}\n`
					};
				}
				return { ok: true, out: '' };
			}
			return { ok: true, out: '' };
		}
	};
	run(extra: { budgetMs?: number; deadlineAt?: number } = {}) {
		return healServicePrivileges(
			{
				info: (m) => this.info.push(m),
				warn: (m) => this.warn.push(m),
				spinner: () => {
					this.spinners++;
					return () => {};
				}
			},
			{ installDir: INSTALL, systemdDir: SYSD, helperDir: HELPERS, runtime: this.rt, ...extra }
		);
	}
	uidRunning(unit: string): number | null {
		const s = this.svc.get(unit)!;
		return s.active ? s.uid : null;
	}
}

describe('the indexer and relay come off root on an installed box', () => {
	it('creates the users, takes the tree back, restarts both and SEES them run as their users', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out.strategy).toBe('applied');
		expect(out.verified).toBe(true);
		const idx = b.users.get('morphit-indexer')!;
		const rel = b.users.get('morphit-relay')!;
		expect(idx.uid).not.toBe(0);
		expect([...idx.groups]).toContain('morphit');
		expect([...rel.groups]).toContain('morphit');
		expect(b.uidRunning('morphit-indexer.service')).toBe(idx.uid);
		expect(b.uidRunning('morphit-relay.service')).toBe(rel.uid);
		expect(b.treeBad).toEqual([]);
		expect(b.files.get(`${HELPERS}/${PERMS_HELPER}`)).toBe(
			b.files.get(`${INSTALL}/ops/scripts/${PERMS_HELPER}`)
		);
		// the tree fix is the one checked against a real tree below
		const fixes = b.calls.filter((c) => c[0] === 'find' && c.includes('-exec'));
		expect(fixes.length).toBe(2);
		expect(fixes.map((f) => f.slice(1))).toEqual(treeFixArgs(INSTALL));
	});

	it('a second run changes nothing and restarts nothing', async () => {
		const b = new Box();
		await b.run();
		const before = b.restartsDone.length;
		const again = await b.run();
		expect(again.strategy).toBe('already');
		expect(again.verified).toBe(true);
		expect(b.restartsDone.length).toBe(before);
	});

	it('a relay that cannot run as its user goes back on root (checked), says why, and is retried next time', async () => {
		const b = new Box();
		b.failsAs.add('morphit-relay');
		const out = await b.run();
		expect(out.strategy).toBe('fallback-root');
		expect(out.verified).toBe(false);
		expect(b.uidRunning('morphit-relay.service')).toBe(0);
		expect(b.uidRunning('morphit-indexer.service')).toBe(b.users.get('morphit-indexer')!.uid);
		expect(b.files.get(`${SYSD}/morphit-relay.service.d/${FALLBACK_DROPIN}`)).toMatch(
			/^User=root$/m
		);
		expect(out.detail).toContain('journalctl -u morphit-relay.service');
		// fixed later: the next run removes the drop-in and switches it
		b.failsAs.clear();
		const next = await b.run();
		expect(next.verified).toBe(true);
		expect(b.files.has(`${SYSD}/morphit-relay.service.d/${FALLBACK_DROPIN}`)).toBe(false);
		expect(b.uidRunning('morphit-relay.service')).toBe(b.users.get('morphit-relay')!.uid);
	});

	it('a service that answers and then keeps restarting is not taken as switched', async () => {
		const b = new Box();
		b.flaps.add('morphit-indexer.service');
		const out = await b.run();
		expect(out.strategy).toBe('fallback-root');
		expect(b.uidRunning('morphit-indexer.service')).toBe(0);
	});

	it('a service still running as root after the restart (an operator drop-in) is not reported as switched', async () => {
		const b = new Box();
		b.pinnedRoot.add('morphit-indexer.service');
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.strategy).toBe('fallback-root');
		expect(out.detail).toMatch(/morphit-indexer still runs as root \(its process runs as uid 0\)/);
	});

	it('a tree that cannot be taken back: the services stay on root rather than run from it', async () => {
		const b = new Box();
		b.treeStubborn = true;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.uidRunning('morphit-indexer.service')).toBe(0);
		expect(out.detail).toMatch(/still changeable by another user/);
	});

	it('no time left to check: nothing is restarted and nothing is put on root (it starts as its user at its next restart)', async () => {
		const b = new Box();
		const out = await b.run({ budgetMs: 30_000 });
		expect(out.verified).toBe(false);
		expect(b.restartsDone).toEqual([]);
		expect(b.files.has(`${SYSD}/morphit-indexer.service.d/${FALLBACK_DROPIN}`)).toBe(false);
		expect(b.files.has(`${SYSD}/morphit-relay.service.d/${FALLBACK_DROPIN}`)).toBe(false);
	});

	it('inside the self-heal child it stops before the child is killed, whatever its own budget', async () => {
		const b = new Box();
		const out = await b.run({ deadlineAt: b.rt.now() + 30_000 });
		expect(out.verified).toBe(false);
		expect(b.restartsDone).toEqual([]);
		expect(b.files.has(`${SYSD}/morphit-indexer.service.d/${FALLBACK_DROPIN}`)).toBe(false);
		expect(b.files.has(`${SYSD}/morphit-relay.service.d/${FALLBACK_DROPIN}`)).toBe(false);
	});

	it('the child deadline: before the 300 s kill, leaving time for the heals after it; none when run directly', () => {
		const now = 1_000_000;
		const child = ['node', 'upgrade.js', '__post-upgrade-selfheal'];
		// the child started 100 s ago: it is killed at now + 200 s
		const d = selfHealDeadline(child, 100, now)!;
		expect(d).toBeLessThan(now + 200_000);
		expect(d).toBeGreaterThan(now + 60_000);
		// started 290 s ago: nothing left (the deadline is already past)
		expect(selfHealDeadline(child, 290, now)!).toBeLessThanOrEqual(now);
		expect(selfHealDeadline(['node', 'upgrade.js'], 100, now)).toBeUndefined();
	});

	it('services listening only on the Docker bridge address are checked THERE, and switched', async () => {
		const b = new Box();
		b.files.set(
			'/etc/morphit/indexer.env',
			'MORPHIT_INDEXER_LISTEN_HOST=172.20.0.1\nMORPHIT_INDEXER_LISTEN_PORT=8081\n'
		);
		b.files.set(
			'/etc/morphit/relay.env',
			'MORPHIT_RELAY_LISTEN_HOST=172.20.0.1\nMORPHIT_RELAY_LISTEN_PORT=8080\n'
		);
		for (const s of b.svc.values()) s.host = '172.20.0.1';
		const out = await b.run();
		expect(out.strategy).toBe('applied');
		expect(out.verified).toBe(true);
		expect(b.uidRunning('morphit-indexer.service')).toBe(b.users.get('morphit-indexer')!.uid);
		expect(b.uidRunning('morphit-relay.service')).toBe(b.users.get('morphit-relay')!.uid);
	});

	it('an indexer that takes 60 s to listen is switched, and the relay is still checked after it', async () => {
		const b = new Box();
		b.slow.set('morphit-indexer.service', 60_000);
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.restartsDone).toEqual(['morphit-indexer.service', 'morphit-relay.service']);
		expect(b.uidRunning('morphit-indexer.service')).toBe(b.users.get('morphit-indexer')!.uid);
		expect(b.uidRunning('morphit-relay.service')).toBe(b.users.get('morphit-relay')!.uid);
	});

	it('a service up as its user but not answering within its window stays as its user (never back to root), unconfirmed', async () => {
		const b = new Box();
		b.slow.set('morphit-relay.service', 10 * 60_000);
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.files.has(`${SYSD}/morphit-relay.service.d/${FALLBACK_DROPIN}`)).toBe(false);
		expect(b.uidRunning('morphit-relay.service')).toBe(b.users.get('morphit-relay')!.uid);
		expect(b.uidRunning('morphit-indexer.service')).toBe(b.users.get('morphit-indexer')!.uid);
	});

	it('a unit that is not this release’s (still User=root) is left alone', async () => {
		const b = new Box();
		b.files.set(`${SYSD}/morphit-relay.service`, '[Service]\nUser=root\n');
		b.files.delete(`${SYSD}/morphit-indexer.service`);
		const out = await b.run();
		expect(out.strategy).toBe('skipped');
		expect(b.restartsDone).toEqual([]);
		expect(b.users.size).toBe(0);
	});

	it('a service that is not running is prepared, not started', async () => {
		const b = new Box();
		b.svc.get('morphit-relay.service')!.active = false;
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.restartsDone).toEqual(['morphit-indexer.service']);
		expect(b.users.has('morphit-relay')).toBe(true);
	});

	it("removes a guided install's leftover root-run safety net from the service user's home — not while its timer is pending", async () => {
		const dir = '/var/lib/morphit/reachability-revert';
		const b = new Box();
		b.files.set(dir, '');
		b.revertTimerActive = true;
		await b.run();
		expect(b.files.has(dir)).toBe(true);
		b.revertTimerActive = false;
		const out = await b.run();
		expect(b.files.has(dir)).toBe(false);
		expect(out.detail).toMatch(/removed a leftover install safety-net script/);
	});

	it("gives the indexer the Matrix bot's posture without the bot's token", async () => {
		const b = new Box();
		b.files.set(
			'/etc/morphit/matrix-bot.env',
			'MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\nMORPHIT_MATRIX_BOT_ACCESS_TOKEN=syt_SECRET\nMORPHIT_MATRIX_BOT_ALERT_MXID=@op:matrix.org\n'
		);
		await b.run();
		const p = b.files.get('/etc/morphit/matrix-bot.posture')!;
		expect(p).toMatch(/^MORPHIT_MATRIX_BOT_ALERT_MXID=configured$/m);
		expect(p).toMatch(/^MORPHIT_MATRIX_BOT_HOMESERVER=https:\/\/matrix\.org$/m);
		expect(p).not.toMatch(/syt_SECRET|@op:/);
		expect(b.calls).toContainEqual(['chgrp', 'morphit', '/etc/morphit/matrix-bot.posture']);
	});

	it('a tor-only bot that refuses a clearnet homeserver does not run: the posture says so', () => {
		const env = (hs: string, socks = 'socks5h://127.0.0.1:9050') =>
			`MORPHIT_MATRIX_BOT_HOMESERVER=${hs}\nMORPHIT_MATRIX_BOT_ALERT_MXID=@op:x\nMORPHIT_MATRIX_BOT_TOR_ONLY=1\nMORPHIT_MATRIX_BOT_SOCKS_PROXY=${socks}\n`;
		expect(matrixBotPostureText(env('https://matrix.org'))).toMatch(
			/^MORPHIT_MATRIX_BOT_ALERT_MXID=$/m
		);
		const onion = `http://${'a'.repeat(56)}.onion`;
		expect(matrixBotPostureText(env(onion))).toMatch(/^MORPHIT_MATRIX_BOT_ALERT_MXID=configured$/m);
		expect(matrixBotPostureText(env(onion, ''))).toMatch(/^MORPHIT_MATRIX_BOT_ALERT_MXID=$/m);
		expect(matrixBotPostureText(env('http://127.0.0.1:8008'))).toMatch(
			/^MORPHIT_MATRIX_BOT_ALERT_MXID=configured$/m
		);
	});

	it('parses systemctl show and User=', () => {
		expect(parseShow('ActiveState=active\nMainPID=42\nNRestarts=3\n')).toEqual({
			active: true,
			mainPid: 42,
			restarts: 3
		});
		expect(unitUser('[Service]\nUser=a\nUser=b\n')).toBe('b');
		expect(unitUser('[Service]\n')).toBe('root');
	});
});

describe('the install tree is taken back to root, except what the upgrade hands to the canary user (real find)', () => {
	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	const tree = (): { dir: string; owned: (p: string) => number } => {
		const dir = mkdtempSync(join(tmpdir(), 'upriv-tree-'));
		for (const f of [
			'node_modules/.bin/tsx',
			'apps/web/build/index.html',
			'apps/web/static/favicon.png',
			'apps/indexer/src/main.ts'
		]) {
			mkdirSync(join(dir, f, '..'), { recursive: true });
			writeFileSync(join(dir, f), 'x');
		}
		// the canary user's served files, and one file someone else took over
		for (const p of [
			'apps/web/build',
			'apps/web/build/index.html',
			'apps/web/static',
			'apps/web/static/favicon.png',
			'node_modules/.bin/tsx'
		])
			chownSync(join(dir, p), 4321, 4321);
		return { dir, owned: (p) => statSync(join(dir, p)).uid };
	};
	it.skipIf(!asRoot)(
		"apps/web/static (the canary user's, as apps/web/build) is neither listed nor re-rooted",
		() => {
			const { dir, owned } = tree();
			const listed = spawnSync('find', treeFindArgs(dir), { encoding: 'utf8' })
				.stdout.split('\n')
				.filter(Boolean);
			expect(listed).toEqual([join(dir, 'node_modules/.bin/tsx')]);
			for (const args of treeFixArgs(dir)) spawnSync('find', args);
			expect(owned('node_modules/.bin/tsx')).toBe(0);
			expect(owned('apps/web/static/favicon.png')).toBe(4321);
			expect(owned('apps/web/build/index.html')).toBe(4321);
			rmSync(dir, { recursive: true, force: true });
		}
	);
});
