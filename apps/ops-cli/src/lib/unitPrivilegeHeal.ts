/**
 * Installed-box heal: the indexer and the relay stop running as root, and the
 * install tree stops being writable by anyone but root.
 *
 * WHY. Older installs ran both services as uid 0 out of an install tree the
 * Ansible role had chowned to the `morphit` service user — who could then
 * replace a file a root unit sources or runs (the env files, tsx, the monitor
 * scripts) and be root at the next restart; and any exploit of the
 * internet-facing indexer was root at once. This release's units run them as
 * `morphit-indexer` / `morphit-relay` (no capabilities, read-only system) and
 * the role keeps the tree root-owned. `morphit-ops upgrade` refreshes the unit
 * files but cannot create users or take the tree back; this heal does, then
 * proves it.
 *
 * WHAT IT DOES, in order (each step read back before the next):
 *  1. the users and groups the units name exist (morphit, morphit-indexer,
 *     morphit-relay — the last two in the morphit group, to read config);
 *  2. the root pre-start helper the units call is installed, root-owned;
 *  3. nothing in the install tree is owned by, or writable for, anyone but
 *     root — except apps/web/build and apps/web/static, static files served to
 *     visitors that no root unit runs (an older upgrade hands both to the
 *     operator's canary user);
 *  4. each RUNNING service is restarted and watched, in its own window: active,
 *     its process's real uid is the service user's, its health answers on the
 *     address it is configured to listen on (MORPHIT_*_LISTEN_HOST / _PORT),
 *     and it is still the same process a few seconds later.
 * FALLBACK. Only a service that is down, crash-looping or running as someone
 * else afterwards goes back on root: a drop-in (90-morphit-run-as-root.conf)
 * with the new unit's other limits, a restart, a check again, and the reason
 * said once, calmly, with the journal command. The next upgrade removes the
 * drop-in and tries again. A service running as its user that has not answered
 * yet stays as its user, reported as unconfirmed. When there is no time left
 * to check a service, nothing is changed for it: it starts as its user at its
 * next restart, and the next upgrade checks it.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { configuredIndexerBase } from '../init/hiddenUpgradeLocalIndexer.ts';
import { SELF_HEAL_CHILD_TIMEOUT_MS } from './proxyConfigHeal.ts';
import { envFlagOn, homeserverRoute } from './matrixRoute.ts';

export const SERVICE_GROUP = 'morphit';
export const FALLBACK_DROPIN = '90-morphit-run-as-root.conf';
export const PERMS_HELPER = 'morphit-service-perms.sh';

export interface ServiceSpec {
	readonly unit: string;
	readonly user: string;
	/** The helper's argument (ops/scripts/morphit-service-perms.sh). */
	readonly role: 'indexer' | 'relay';
	/** The env files the unit sources, in order (last wins). */
	readonly envFiles: readonly string[];
	readonly portKey: string;
	readonly defaultPort: number;
	/** Where it listens (empty / 0.0.0.0 / :: = every address, probed on loopback). */
	readonly hostKey: string;
}

export const SERVICES: readonly ServiceSpec[] = [
	{
		unit: 'morphit-indexer.service',
		user: 'morphit-indexer',
		role: 'indexer',
		envFiles: [
			'/opt/morphit/morphit.env',
			'/opt/morphit/morphit.config.env',
			'/etc/morphit/indexer.env'
		],
		portKey: 'MORPHIT_INDEXER_LISTEN_PORT',
		defaultPort: 8081,
		hostKey: 'MORPHIT_INDEXER_LISTEN_HOST'
	},
	{
		unit: 'morphit-relay.service',
		user: 'morphit-relay',
		role: 'relay',
		envFiles: [
			'/opt/morphit/morphit.env',
			'/opt/morphit/morphit.config.env',
			'/etc/morphit/relay.env',
			'/etc/morphit/relay-vapid.env'
		],
		portKey: 'MORPHIT_RELAY_LISTEN_PORT',
		defaultPort: 8080,
		hostKey: 'MORPHIT_RELAY_LISTEN_HOST'
	}
];

/** `User=` of a unit's text (last one wins), or 'root' when unset. PURE. */
export function unitUser(text: string): string {
	let user = 'root';
	for (const line of text.split('\n')) {
		const m = /^\s*User=(.*)$/.exec(line);
		if (m) user = m[1]!.trim() || 'root';
	}
	return user;
}

/** The last `KEY=value` for `key` across env texts (quotes removed). PURE. */
export function envValue(texts: readonly (string | null)[], key: string): string | null {
	let out: string | null = null;
	for (const t of texts) {
		if (t === null) continue;
		for (const line of t.split('\n')) {
			const m = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`).exec(line);
			if (m) out = m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2');
		}
	}
	return out;
}

/** The Matrix bot's secret-free posture (ops/ansible/roles/matrix_bot/
 *  templates/matrix-bot.posture.j2), from its env file. PURE. */
export function matrixBotPostureText(botEnv: string): string {
	const hs = envValue([botEnv], 'MORPHIT_MATRIX_BOT_HOMESERVER') ?? '';
	// On a tor-only node the bot refuses a homeserver it could reach only over
	// clearnet (it does not start), so it makes no clearnet contact: say so.
	const torOnly = envFlagOn(envValue([botEnv], 'MORPHIT_MATRIX_BOT_TOR_ONLY') ?? '');
	const socks = (envValue([botEnv], 'MORPHIT_MATRIX_BOT_SOCKS_PROXY') ?? '').trim() !== '';
	const route = homeserverRoute(hs);
	const refused = torOnly && !(route === 'loopback' || (route === 'onion' && socks));
	const mxid = refused ? '' : (envValue([botEnv], 'MORPHIT_MATRIX_BOT_ALERT_MXID') ?? '');
	return (
		'# Written by `morphit-ops upgrade` from matrix-bot.env — NO secret in here.\n' +
		'# Whether the Matrix alert bot runs and which homeserver it talks to, for the\n' +
		"# indexer's clearnet check (the indexer cannot read matrix-bot.env).\n" +
		`MORPHIT_MATRIX_BOT_ALERT_MXID=${mxid.trim() === '' ? '' : 'configured'}\n` +
		`MORPHIT_MATRIX_BOT_HOMESERVER=${hs.replace(/[\r\n]/g, '')}\n`
	);
}

/** The text of the root fallback drop-in. PURE. */
export function fallbackDropin(reason: string): string {
	return (
		'# Written by `morphit-ops upgrade`: this service did not come up as its own\n' +
		`# unprivileged user (${reason.replace(/\n/g, ' ')}),\n` +
		"# so it runs as root again — with the unit's other limits — until the next\n" +
		'# upgrade removes this file and tries again.\n' +
		'[Service]\nUser=root\nGroup=root\nSupplementaryGroups=\n'
	);
}

export interface ShowState {
	readonly active: boolean;
	readonly mainPid: number;
	readonly restarts: number;
}

/** `systemctl show -p ActiveState -p MainPID -p NRestarts` output. PURE. */
export function parseShow(out: string): ShowState {
	const get = (k: string): string => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
	return {
		active: get('ActiveState') === 'active',
		mainPid: Number(get('MainPID')) || 0,
		restarts: Number(get('NRestarts')) || 0
	};
}

export interface PrivilegeRuntime {
	now(): number;
	sleep(ms: number): Promise<void>;
	readFile(path: string): string | null;
	/** Write atomically (temp + rename), root-owned, with `mode`; false on failure. */
	writeFile(path: string, data: string, mode: number): boolean;
	removeFile(path: string): boolean;
	uidOf(user: string): number | null;
	groupExists(group: string): boolean;
	/** Groups `user` is in (names). */
	groupsOf(user: string): readonly string[];
	/** groupadd/useradd/usermod/systemctl/find/chown/chmod/runuser …; ok = exit 0. */
	run(cmd: string, args: readonly string[], timeoutMs: number): { ok: boolean; out: string };
	/** The real uid of a process, from /proc/<pid>/status; null if gone. */
	procUid(pid: number): number | null;
	/** Does anything answer HTTP at this URL (any status)? */
	httpAnswers(url: string, timeoutMs: number): Promise<boolean>;
}

export interface PrivilegeHealOpts {
	readonly installDir: string;
	readonly systemdDir?: string;
	readonly helperDir?: string;
	readonly runtime?: PrivilegeRuntime;
	/** This heal's own ceiling (default 180 s). */
	readonly budgetMs?: number;
	/** An absolute time (rt.now()) it must be done by, whatever the budget:
	 *  inside the self-heal child, before the child is killed. */
	readonly deadlineAt?: number;
	/** How long a restarted service gets to answer (default 45 s). */
	readonly serviceWaitMs?: number;
	/** How long it must then stay the same process (default 5 s). */
	readonly settleMs?: number;
	readonly pollMs?: number;
	/** Where an older guided install left its reachability safety net. */
	readonly revertDir?: string;
	readonly matrixBotEnv?: string;
	readonly matrixBotPosture?: string;
}

const T = 20_000;

/** Static files served to visitors, which no root unit runs: an older upgrade
 *  (step 9b1) hands both to the operator's canary user, so they are left as
 *  they are. */
export const SERVED_DIRS = ['apps/web/build', 'apps/web/static'] as const;

/** `( -path <served> -o … ) -prune -o`: skip the served directories. */
const pruneServed = (tree: string): string[] => [
	'(',
	...SERVED_DIRS.flatMap((d, i) => [...(i > 0 ? ['-o'] : []), '-path', join(tree, d)]),
	')',
	'-prune',
	'-o'
];

/** Paths in `tree` someone other than root owns or may write (bounded list). */
export function treeFindArgs(tree: string): string[] {
	return [
		tree,
		...pruneServed(tree),
		'(',
		'!',
		'-user',
		'root',
		'-o',
		'!',
		'-type',
		'l',
		'-perm',
		'/022',
		')',
		'-print'
	];
}

/** The two `find` runs that take the tree back: owner root, no group/other write. */
export function treeFixArgs(tree: string): string[][] {
	const p = [tree, ...pruneServed(tree)];
	return [
		[...p, '!', '-user', 'root', '-exec', 'chown', '-h', 'root:root', '{}', '+'],
		[...p, '!', '-type', 'l', '-perm', '/022', '-exec', 'chmod', 'go-w', '{}', '+']
	];
}

export async function healServicePrivileges(
	ctx: HealCtx,
	opts: PrivilegeHealOpts
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime();
	const sysd = opts.systemdDir ?? '/etc/systemd/system';
	const helperDir = opts.helperDir ?? '/usr/local/lib/morphit';
	// It runs inside the upgrade's self-heal child (killed at 300 s, with the
	// other heals after it), so the whole heal stays within 180 s, and within
	// what the child has left (deadlineAt).
	const end = Math.min(rt.now() + (opts.budgetMs ?? 180_000), opts.deadlineAt ?? Infinity);
	// Each service gets its own window — up to 120 s, as an indexer can take a
	// minute or more to listen (a database migration, Tor still starting) — while
	// keeping MIN_WINDOW_MS for each service after it.
	const waitMax = opts.serviceWaitMs ?? 120_000;
	const MIN_WINDOW_MS = 40_000;
	const settleMs = opts.settleMs ?? 5_000;
	const pollMs = opts.pollMs ?? 2_000;
	const notes: string[] = [];

	// Which services this box has with this release's (unprivileged) unit.
	const todo = SERVICES.filter((s) => {
		const text = rt.readFile(join(sysd, s.unit));
		if (text === null) return false;
		if (unitUser(text) !== s.user) {
			notes.push(
				`${s.unit} is not this release's unit (it runs as ${unitUser(text)}), so it was left as it is`
			);
			return false;
		}
		return true;
	});
	if (todo.length === 0)
		return {
			strategy: 'skipped',
			verified: true,
			routine: notes.length === 0,
			detail: notes.length
				? `Service users: ${notes.join('; ')}.`
				: 'Service users: no indexer or relay unit on this server.'
		};

	// ── 1. users and groups ──
	let stop = ctx.spinner('Checking the indexer and relay service users…');
	const userProblems: string[] = [];
	try {
		if (!rt.groupExists(SERVICE_GROUP)) rt.run('groupadd', ['--system', SERVICE_GROUP], T);
		if (!rt.groupExists(SERVICE_GROUP))
			userProblems.push(`group ${SERVICE_GROUP} could not be created`);
		for (const s of todo) {
			if (!rt.groupExists(s.user)) rt.run('groupadd', ['--system', s.user], T);
			if (rt.uidOf(s.user) === null)
				rt.run(
					'useradd',
					[
						'--system',
						'--gid',
						s.user,
						'--groups',
						SERVICE_GROUP,
						'--no-create-home',
						'--home-dir',
						'/nonexistent',
						'--shell',
						'/usr/sbin/nologin',
						s.user
					],
					T
				);
			else if (!rt.groupsOf(s.user).includes(SERVICE_GROUP))
				rt.run('usermod', ['--append', '--groups', SERVICE_GROUP, s.user], T);
			const uid = rt.uidOf(s.user);
			if (uid === null || uid === 0 || !rt.groupsOf(s.user).includes(SERVICE_GROUP))
				userProblems.push(`user ${s.user} could not be set up`);
		}
	} finally {
		stop();
	}

	// ── 2. the pre-start helper ──
	// A checkout elsewhere than /opt/morphit: the same path rewrite the units got.
	const here = (p: string): string =>
		opts.installDir === '/opt/morphit' ? p : p.split('/opt/morphit').join(opts.installDir);
	const raw = rt.readFile(join(opts.installDir, 'ops/scripts', PERMS_HELPER));
	const helperSrc = raw === null ? null : here(raw);
	const helperDst = join(helperDir, PERMS_HELPER);
	let helperOk = helperSrc !== null && rt.readFile(helperDst) === helperSrc;
	if (helperSrc !== null && !helperOk) {
		helperOk = rt.writeFile(helperDst, helperSrc, 0o755) && rt.readFile(helperDst) === helperSrc;
		if (!helperOk) userProblems.push(`${helperDst} could not be installed`);
	}

	// ── 3. the install tree ──
	stop = ctx.spinner(`Checking that only root can change ${opts.installDir}…`);
	let treeLeft: string[] = [];
	let treeFixed = 0;
	try {
		const list = (): string[] =>
			rt.run('find', treeFindArgs(opts.installDir), 120_000).out.split('\n').filter(Boolean);
		const before = list();
		if (before.length > 0) {
			for (const args of treeFixArgs(opts.installDir)) rt.run('find', args, 300_000);
			treeLeft = list();
			treeFixed = before.length - treeLeft.length;
		}
	} finally {
		stop();
	}
	// The Matrix bot's posture, for the indexer's clearnet check: the indexer
	// can no longer read matrix-bot.env (it holds the bot's token), so it gets
	// the two facts it needs, without the secret, in a file it can read.
	const botEnv = rt.readFile(opts.matrixBotEnv ?? '/etc/morphit/matrix-bot.env');
	if (botEnv !== null) {
		const posturePath = opts.matrixBotPosture ?? '/etc/morphit/matrix-bot.posture';
		const want = matrixBotPostureText(botEnv);
		if (rt.readFile(posturePath) !== want) {
			const ok =
				rt.writeFile(posturePath, want, 0o640) &&
				rt.run('chgrp', [SERVICE_GROUP, posturePath], T).ok &&
				rt.readFile(posturePath) === want;
			if (!ok)
				notes.push(
					`${posturePath} could not be written, so the indexer reports the Matrix bot's route as unknown`
				);
		}
	}

	// A guided install's reachability safety net (run as root by a transient
	// timer) used to be left under the service user's home; with no timer
	// pending it is only a root-run script someone else could edit.
	const revertDir = opts.revertDir ?? '/var/lib/morphit/reachability-revert';
	if (
		rt.run('test', ['-e', revertDir], T).ok &&
		!rt.run('systemctl', ['is-active', '--quiet', 'morphit-reachability-revert.timer'], T).ok
	) {
		rt.run('rm', ['-rf', '--one-file-system', '--', revertDir], T);
		notes.push(
			rt.run('test', ['-e', revertDir], T).ok
				? `a leftover ${revertDir} could not be removed; remove it on this server with: sudo rm -rf ${revertDir}`
				: `removed a leftover install safety-net script (${revertDir})`
		);
	}
	if (treeLeft.length > 0)
		userProblems.push(
			`${treeLeft.length} path(s) in ${opts.installDir} are still changeable by another user (first: ${treeLeft[0]})`
		);

	// ── 4. restart and watch each running service ──
	const results: Array<{
		s: ServiceSpec;
		how: 'already' | 'switched' | 'fallback' | 'idle' | 'deferred' | 'unconfirmed';
		ok: boolean;
		why?: string;
	}> = [];
	const reload = (): void => void rt.run('systemctl', ['daemon-reload'], 60_000);
	for (const [i, s] of todo.entries()) {
		const after = todo.length - i - 1;
		const waitMs = Math.min(waitMax, end - rt.now() - settleMs - after * MIN_WINDOW_MS);
		const dropin = join(sysd, `${s.unit}.d`, FALLBACK_DROPIN);
		const uid = rt.uidOf(s.user);
		const envTexts = s.envFiles.map((f) => rt.readFile(here(f)));
		const port = Number(envValue(envTexts, s.portKey)) || s.defaultPort;
		// Its configured listen address: a bind to one address (the Docker
		// bridge, say) answers only there; a wildcard bind on loopback.
		const base =
			configuredIndexerBase({
				readable: true,
				rpcEndpoints: undefined,
				listenHost: envValue(envTexts, s.hostKey) ?? undefined,
				listenPort: String(port)
			}) ?? `http://127.0.0.1:${port}`;
		const url = `${base}/v1/health`;
		const show = (): ShowState =>
			parseShow(
				rt.run(
					'systemctl',
					['show', s.unit, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'NRestarts'],
					T
				).out
			);
		const hadDropin = rt.readFile(dropin) !== null;
		const cur = show();
		// Already right: running as its user, with no fallback in place.
		if (!hadDropin && cur.active && uid !== null && rt.procUid(cur.mainPid) === uid) {
			results.push({ s, how: 'already', ok: true });
			continue;
		}
		if (!cur.active) {
			// Not running here. It starts as its user when started — or, when
			// the user could not be set up, as root (so it can still start).
			if (userProblems.length > 0) {
				const wrote = rt.writeFile(dropin, fallbackDropin(userProblems.join('; ')), 0o644);
				reload();
				results.push({ s, how: 'fallback', ok: wrote, why: userProblems.join('; ') });
			} else {
				if (hadDropin) {
					rt.removeFile(dropin);
					reload();
				}
				results.push({ s, how: 'idle', ok: true });
			}
			continue;
		}
		const fallBack = async (why: string, restart: boolean): Promise<void> => {
			const wrote = rt.writeFile(dropin, fallbackDropin(why), 0o644);
			reload();
			let ok = wrote;
			if (restart && wrote) {
				rt.run('systemctl', ['restart', s.unit], 90_000);
				ok = await watch(0);
			}
			results.push({ s, how: 'fallback', ok, why });
		};
		/** Up as `wantUid`: active, that uid, answering, and still the same process. */
		const watch = async (wantUid: number): Promise<boolean> => {
			const st = ctx.spinner(`Waiting for ${s.unit} to answer on ${base}…`);
			try {
				const until = rt.now() + waitMs;
				while (rt.now() < until) {
					const a = show();
					if (
						a.active &&
						a.mainPid > 0 &&
						rt.procUid(a.mainPid) === wantUid &&
						(await rt.httpAnswers(url, 5_000))
					) {
						await rt.sleep(settleMs);
						const b = show();
						return b.active && b.mainPid === a.mainPid && b.restarts === a.restarts;
					}
					await rt.sleep(pollMs);
				}
				return false;
			} finally {
				st();
			}
		};
		if (userProblems.length > 0) {
			await fallBack(userProblems.join('; '), true);
			continue;
		}
		if (waitMs < Math.min(waitMax, MIN_WINDOW_MS)) {
			// Not switched now, and NOT put on root: a later restart starts it
			// as its user (the unit says so), and the next upgrade checks it.
			results.push({
				s,
				how: 'deferred',
				ok: false,
				why: 'no time was left in this upgrade to check it'
			});
			continue;
		}
		if (hadDropin) {
			rt.removeFile(dropin);
			reload();
		}
		const before = show().restarts;
		const restarted = rt.run('systemctl', ['restart', s.unit], 90_000).ok;
		if (restarted && uid !== null && (await watch(uid))) {
			results.push({ s, how: 'switched', ok: true });
			continue;
		}
		const st = show();
		const seen = rt.procUid(st.mainPid);
		// Running as its user, not restarting, just not answering yet (slow, or
		// a listener the probe cannot reach): it stays as its user. Only a
		// service that is down, crash-looping or running as someone else goes
		// back on root.
		if (st.active && uid !== null && seen === uid && st.restarts === before) {
			results.push({
				s,
				how: 'unconfirmed',
				ok: false,
				why: `nothing answered on ${base} within ${Math.round(waitMs / 1000)} s`
			});
			continue;
		}
		await fallBack(
			!st.active
				? 'it did not stay running'
				: seen !== uid
					? `its process runs as uid ${seen ?? 'unknown'}`
					: `nothing answered on port ${port}`,
			true
		);
	}

	// ── report ──
	const parts: string[] = [];
	for (const r of results) {
		const name = r.s.unit.replace(/\.service$/, '');
		if (r.how === 'already') parts.push(`${name} runs as ${r.s.user} (checked)`);
		else if (r.how === 'switched')
			parts.push(`${name} now runs as ${r.s.user} (checked: its process, its port)`);
		else if (r.how === 'idle')
			parts.push(`${name} is not running here; it will start as ${r.s.user}`);
		else if (r.how === 'deferred')
			parts.push(
				`${name} was not switched in this upgrade (${r.why}); it starts as ${r.s.user} at its next restart, and the next upgrade checks it`
			);
		else if (r.how === 'unconfirmed')
			parts.push(
				`${name} runs as ${r.s.user} (its process was checked), but ${r.why}; on this server check it with: sudo systemctl status ${r.s.unit}`
			);
		else
			parts.push(
				`${name} still runs as root (${r.why}); see \`sudo journalctl -u ${r.s.unit} -n 50\` on this server — the next upgrade tries again${r.ok ? '' : `. Whether it answers as root was not confirmed; on this server check: sudo systemctl status ${r.s.unit}`}`
			);
	}
	if (treeFixed > 0) parts.push(`${treeFixed} path(s) in ${opts.installDir} are root-only again`);
	parts.push(...notes);
	const fellBack = results.some((r) => r.how === 'fallback');
	const allOk = results.every((r) => r.ok) && userProblems.length === 0;
	const pending = results.some((r) => r.how === 'deferred' || r.how === 'unconfirmed');
	return {
		strategy: fellBack
			? 'fallback-root'
			: pending
				? 'partial'
				: results.every((r) => r.how === 'already') && treeFixed === 0
					? 'already'
					: 'applied',
		verified: allOk && !fellBack,
		detail: `Service users: ${parts.join('; ')}.`
	};
}

/** The real entry `morphit-ops upgrade` calls (see lib/healTypes.ts). */
/** Kept for the heals that run after this one in the self-heal child. */
const AFTER_HEALS_MS = 60_000;

/** Inside the re-exec'd self-heal child (killed SELF_HEAL_CHILD_TIMEOUT_MS
 *  after it starts), the time this heal must be done by: 20 s before the kill,
 *  less what the heals after it need. Run directly, there is no kill to beat
 *  (undefined). PURE. */
export function selfHealDeadline(
	argv: readonly string[],
	uptimeS: number,
	nowMs: number
): number | undefined {
	if (!argv.includes('__post-upgrade-selfheal')) return undefined;
	return nowMs - uptimeS * 1000 + SELF_HEAL_CHILD_TIMEOUT_MS - 20_000 - AFTER_HEALS_MS;
}

export async function heal(ctx: HealCtx): Promise<HealResult> {
	const installDir =
		/^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '')?.[1] ??
		((process.env.MORPHIT_INSTALL_DIR ?? '').trim() || '/opt/morphit');
	let real = installDir;
	try {
		real = realpathSync(installDir);
	} catch {
		/* keep the given path */
	}
	return healServicePrivileges(ctx, {
		installDir: real,
		deadlineAt: selfHealDeadline(process.argv, process.uptime(), Date.now())
	});
}

// ─── runtime ────────────────────────────────────────────────────────────

function sh(cmd: string, args: readonly string[], timeoutMs: number): { ok: boolean; out: string } {
	try {
		const r = spawnSync(cmd, args as string[], {
			encoding: 'utf8',
			timeout: timeoutMs,
			maxBuffer: 64 * 1024 * 1024
		});
		return { ok: r.status === 0, out: `${r.stdout ?? ''}` };
	} catch {
		return { ok: false, out: '' };
	}
}

export function realRuntime(): PrivilegeRuntime {
	return {
		now: () => Date.now(),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		readFile: (p) => {
			try {
				return readFileSync(p, 'utf8');
			} catch {
				return null;
			}
		},
		writeFile: (p, data, mode) => {
			const tmp = `${p}.tmp-${process.pid}`;
			try {
				const dir = dirname(p);
				if (!existsSync(dir)) sh('mkdir', ['-p', '-m', '0755', dir], T);
				if (existsSync(p) && lstatSync(p).isSymbolicLink()) return false;
				const fd = openSync(tmp, 'wx', mode);
				try {
					writeSync(fd, data);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				chmodSync(tmp, mode);
				renameSync(tmp, p);
				return true;
			} catch {
				try {
					unlinkSync(tmp);
				} catch {
					/* nothing to clean */
				}
				return false;
			}
		},
		removeFile: (p) => {
			try {
				rmSync(p, { force: true });
				return true;
			} catch {
				return false;
			}
		},
		uidOf: (u) => {
			const r = sh('getent', ['passwd', u], T);
			const f = r.ok ? r.out.trim().split(':') : [];
			return f.length >= 3 && /^\d+$/.test(f[2]!) ? Number(f[2]) : null;
		},
		groupExists: (g) => sh('getent', ['group', g], T).ok,
		groupsOf: (u) => {
			const r = sh('id', ['-nG', u], T);
			return r.ok ? r.out.trim().split(/\s+/) : [];
		},
		run: sh,
		procUid: (pid) => {
			if (!(pid > 0)) return null;
			try {
				const m = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
				return m ? Number(m[1]) : null;
			} catch {
				return null;
			}
		},
		httpAnswers: async (url, timeoutMs) => {
			try {
				await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
				return true;
			} catch {
				return false;
			}
		}
	};
}
