/**
 * Installed-box heal: when this network filters plain Tor, this server's Tor
 * moves onto Tor bridges (Snowflake, obfs4), so its .onion and every read it
 * makes over Tor keep working.
 *
 * WHY (morphitir, 2026-10-09). The server's network sends every torproject.org
 * name to a sinkhole (10.10.34.36) and lets connections to Tor relays open but
 * starves the circuits built over them: the system Tor and a fresh Tor client
 * each loaded 0 of 6 pages, Tor's log named guard after guard "failing an
 * extremely large amount of circuits", and the .onion could not upload its
 * descriptor, so nobody could reach it. Over the Tor Project's built-in bridges
 * a throwaway client loaded pages at once; with the same bridges in
 * /etc/tor/torrc the server's own .onion answered, from inside and from
 * morphit.io.
 *
 * WHERE THE BRIDGES COME FROM. A filtered server cannot ask torproject.org for
 * them, so the release ships the list Tor Browser uses: ops/tor/builtin-bridges.json.
 *
 * WHAT, on this server, only when Tor is running and loads NOTHING (its own
 * .onion, then a page through it, a few tries each):
 *   1. the transport programs are installed (Ubuntu's snowflake-client,
 *      obfs4proxy; Tor's own AppArmor profile already allows both);
 *   2. the bridges are written into /etc/tor/torrc between markers (an earlier
 *      block of ours is replaced), after `tor --verify-config` accepts the file;
 *   3. Tor restarts and must connect (its journal says "Bootstrapped 100%");
 *   4. VERIFY: the .onion or a page loads through it. Otherwise the previous
 *      torrc is put back and Tor restarted on it.
 * A Tor that works is left alone, with two exceptions that change no config:
 *   - on a Tor/I2P-only server the transports are installed over Tor while it
 *     works (once it does not, its package downloads cannot get through);
 *   - on a server on bridges, a separate throwaway Tor client without bridges
 *     (as Tor's own user, at most once a day) checks whether plain Tor works on
 *     this network again; when it does, the bridges come out (proven the same
 *     way). When this server's Tor then does not work without them, they go
 *     back, Tor is proven to work over them again, and plain Tor waits a week.
 * A Tor/I2P-only server uses obfs4 only: Snowflake asks DNS for its front and
 * STUN servers, and that node's egress rule refuses DNS to every user.
 * The torrc is read again before each write: an edit made meanwhile (an
 * operator, Ansible, the PoW heal) is never overwritten or put back over.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import {
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';
import { runAsync } from './spinRun.ts';
import { installAndEnableUnits, type InstallUnitsResult } from './installUnits.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { ROOT_STATE_DIR } from './noFollowFs.ts';

export const TOR_BRIDGES_BEGIN = '# >>> morphit: Tor bridges (this network filters plain Tor) >>>';
export const TOR_BRIDGES_END = '# <<< morphit: Tor bridges <<<';

/** The transports used, in the order they are preferred (Snowflake reached the
 *  Tor network on every try from morphitir; some built-in obfs4 bridges did not). */
export const TOR_TRANSPORTS = [
	{ name: 'snowflake', pkg: 'snowflake-client', exec: '/usr/bin/snowflake-client' },
	{ name: 'obfs4', pkg: 'obfs4proxy', exec: '/usr/bin/obfs4proxy' }
] as const;

/** Where the release ships the list (relative to the install directory). */
export const BUILTIN_BRIDGES_PATH = 'ops/tor/builtin-bridges.json';

/** How long Tor gets to connect after a restart. */
export const TOR_BRIDGES_CONNECT_MS = 5 * 60_000;
/** How long the proof after a restart may take (the .onion is published a
 *  minute or two after Tor connects). */
export const TOR_BRIDGES_PROOF_MS = 5 * 60_000;
/** How long the first check may take (a Tor that works answers in seconds). */
export const TOR_BRIDGES_CHECK_MS = 4 * 60_000;
/** One transport install's limit (a dpkg lock is waited for up to a minute of it). */
export const TOR_BRIDGES_INSTALL_MS = 4 * 60_000;
/** The separate plain Tor client's limit (on a server on bridges). */
export const TOR_BRIDGES_PLAIN_PROBE_MS = 5 * 60_000;
/** It reaches public Tor relays, which a filtering network sees: at most this
 *  often. */
export const TOR_BRIDGES_PLAIN_PROBE_EVERY_MS = 24 * 3_600_000;
/** After this server's Tor did not work without bridges (although the plain
 *  client did), plain Tor is not tried again for this long. */
export const TOR_BRIDGES_PLAIN_BACKOFF_MS = 7 * 24 * 3_600_000;

/** What the heal keeps between runs (epoch ms). */
export interface TorBridgesState {
	readonly lastPlainProbe?: number;
	readonly plainFailedAt?: number;
}
/** Kept at the end of every run: putting the previous torrc back and
 *  restarting Tor on it (up to 2 min), then turning the timer on (systemctl,
 *  up to a minute per call). No attempt starts a wait that would eat it. */
export const TOR_BRIDGES_END_RESERVE_MS = 7 * 60_000;
/** The heal's longest run: the first check (4 min), two installs (8), up to
 *  two attempts of restart (2), connect (5) and proof (5), and the reserve
 *  (a working Tor on bridges: the check, the installs, the plain client (5)
 *  and one attempt). Every wait is cut to what is left of it. */
export const TOR_BRIDGES_HEAL_MAX_MS = 45 * 60_000;

/** A bridge line we use: "<transport> <ip>:<port> <40-hex fingerprint> …". */
const BRIDGE_RE = /^(snowflake|obfs4) \d{1,3}(?:\.\d{1,3}){3}:\d{1,5} [0-9A-F]{40}(?: \S+)*$/;

/** A Snowflake line that lists `fronts=a,b` but no `front=` gets `front=a`:
 *  Ubuntu's snowflake-client (2.5.1) reads only `front=`, and without it asks
 *  the broker with no domain fronting, which a network that filters Tor
 *  blocks. Newer clients read both. PURE. */
function withFront(line: string): string {
	if (!line.startsWith('snowflake ')) return line;
	const words = line.split(' ');
	if (words.some((w) => w.startsWith('front='))) return line;
	const first = words
		.find((w) => w.startsWith('fronts='))
		?.slice('fronts='.length)
		.split(',')
		.find((f) => /^[a-z0-9.-]+$/i.test(f));
	return first === undefined ? line : `${line} front=${first}`;
}

/**
 * The usable bridge lines in a bridge list, whatever its layout (the Tor
 * Project's moat answer and Tor Browser's pt_config.json both work): every
 * string that is a Snowflake or obfs4 bridge line, once, Snowflake first
 * (each Snowflake line with a `front=`). PURE.
 */
export function bridgeLinesFrom(list: unknown): string[] {
	const seen: string[] = [];
	const walk = (x: unknown): void => {
		if (Array.isArray(x)) x.forEach(walk);
		else if (x !== null && typeof x === 'object') Object.values(x).forEach(walk);
		else if (typeof x === 'string') {
			const s = x.trim();
			if (!BRIDGE_RE.test(s)) return;
			const line = withFront(s);
			if (!seen.includes(line)) seen.push(line);
		}
	};
	walk(list);
	const rank = (s: string): number => TOR_TRANSPORTS.findIndex((t) => s.startsWith(`${t.name} `));
	return seen
		.map((s, i) => [s, i] as const)
		.sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
		.map(([s]) => s);
}

/** Is our bridges block in this torrc? PURE. */
export function hasBridgesBlock(torrc: string): boolean {
	return torrc.split('\n').some((l) => l === TOR_BRIDGES_BEGIN);
}

/** The torrc with our block (re)written at its end: an earlier block of ours is
 *  dropped, everything else is kept as it is. PURE. */
export function withBridges(torrc: string, lines: readonly string[]): string {
	const kept: string[] = [];
	let skip = false;
	for (const l of torrc.split('\n')) {
		if (l === TOR_BRIDGES_BEGIN) skip = true;
		if (!skip) kept.push(l);
		if (l === TOR_BRIDGES_END) skip = false;
	}
	while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
	const used = TOR_TRANSPORTS.filter((t) => lines.some((l) => l.startsWith(`${t.name} `)));
	return [
		...kept,
		TOR_BRIDGES_BEGIN,
		'UseBridges 1',
		...used.map((t) => `ClientTransportPlugin ${t.name} exec ${t.exec}`),
		...lines.map((l) => `Bridge ${l}`),
		TOR_BRIDGES_END,
		''
	].join('\n');
}

/** The torrc without our block: plain Tor again. PURE. */
export function withoutBridges(torrc: string): string {
	const kept: string[] = [];
	let skip = false;
	for (const l of torrc.split('\n')) {
		if (l === TOR_BRIDGES_BEGIN) skip = true;
		if (!skip) kept.push(l);
		if (l === TOR_BRIDGES_END) skip = false;
	}
	while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
	return [...kept, ''].join('\n');
}

export interface TorBridgesRuntime {
	readTorrc(): string | null;
	writeTorrc(text: string): boolean;
	/** `tor --verify-config` on this text, as the service runs it. */
	verifies(text: string): { ok: boolean; out: string };
	torActive(): boolean;
	/** This server's .onion, or null when it hosts none. */
	onion(): string | null;
	/** One request through this server's Tor: the HTTP status, 0 for none. */
	status(url: string, timeoutMs: number): Promise<number>;
	installed(pkg: string): boolean;
	/** apt-get install; `overTor`: only through Tor (a Tor/I2P-only server). */
	install(pkg: string, overTor: boolean): Promise<boolean>;
	restartTor(): Promise<boolean>;
	/** Has Tor said "Bootstrapped 100%" since `sinceMs` (epoch ms)? */
	connectedSince(sinceMs: number): Promise<boolean> | boolean;
	/** Tor/I2P-only node: nothing may be fetched over clearnet (apt included). */
	hiddenOnly(): boolean;
	/** The release's bridge list (parsed JSON), or null. */
	bridgeList(): unknown;
	/** Does a separate Tor client WITHOUT bridges load anything on this
	 *  network, by `until` (epoch ms)? (plainTorProbe) */
	plainTorWorks(until: number): Promise<boolean>;
	readState(): TorBridgesState;
	writeState(s: TorBridgesState): void;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/** A page whose answer says Tor carried the request (no state, no account). */
export const TOR_CHECK_URL = 'https://check.torproject.org/api/ip';

/** Does Tor load anything? The server's own .onion first (what visitors and
 *  peers use: any HTTP answer from it means Tor carried the request there and
 *  back), then a page through it; a few tries, stopping at the first. */
async function torLoads(rt: TorBridgesRuntime, until: number): Promise<boolean> {
	const onion = rt.onion();
	const fits = (ms: number): boolean => rt.now() + ms <= until;
	for (let first = true; fits(45_000); first = false) {
		if (!first) await rt.sleep(15_000);
		if (onion !== null && fits(90_000) && (await rt.status(`http://${onion}/`, 90_000)) >= 100)
			return true;
		if (fits(45_000) && (await rt.status(TOR_CHECK_URL, 45_000)) === 200) return true;
	}
	return false;
}

const label = 'Tor bridges';

type Attempt =
	| 'works'
	| 'no-connect'
	| 'nothing-loads'
	| 'rejected'
	| 'unwritable'
	| 'changed'
	| 'no-time';

function outcomeText(kind: 'bridges' | 'plain', r: Attempt): string {
	return `${kind === 'bridges' ? 'over the bridges' : 'without bridges'}: ${
		r === 'no-connect'
			? 'Tor did not connect'
			: r === 'nothing-loads'
				? 'Tor connected but nothing loaded'
				: r === 'rejected'
					? 'Tor did not accept the config'
					: r === 'unwritable'
						? 'could not write /etc/tor/torrc'
						: r === 'changed'
							? '/etc/tor/torrc was changed by something else during this check'
							: 'no time left to try'
	}`;
}

const HIDDEN_ONLY_ADVICE =
	'On a computer that can reach your distribution: apt-get download obfs4proxy; copy the .deb file to this server; on this server: sudo apt-get install ./obfs4proxy_*.deb, then: sudo morphit-ops upgrade --tor-bridges';

export async function healTorBridges(
	ctx: HealCtx,
	opts: { runtime?: TorBridgesRuntime } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime();
	const before = rt.readTorrc();
	if (before === null || !rt.torActive())
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: `${label}: Tor is not running on this server.`
		};
	const bridged = hasBridgesBlock(before);
	const start = rt.now();
	/** No wait may run past this: the reserve keeps the put-back and the timer. */
	const end = start + TOR_BRIDGES_HEAL_MAX_MS - TOR_BRIDGES_END_RESERVE_MS;
	let stop = ctx.spinner('Checking that Tor on this server loads its .onion…');
	let works: boolean;
	try {
		works = await torLoads(rt, Math.min(end, start + TOR_BRIDGES_CHECK_MS));
	} finally {
		stop();
	}
	const hidden = rt.hiddenOnly();
	// A Tor/I2P-only server: obfs4 only (no DNS for Snowflake there).
	const lines = bridgeLinesFrom(rt.bridgeList()).filter((l) => !hidden || l.startsWith('obfs4 '));
	const missing = TOR_TRANSPORTS.filter(
		(t) => lines.some((l) => l.startsWith(`${t.name} `)) && !rt.installed(t.pkg)
	);
	/** Install what is missing; the packages still not installed after. */
	const installMissing = async (overTor: boolean): Promise<string[]> => {
		const failed: string[] = [];
		for (const t of missing) {
			if (rt.now() + 60_000 > end) {
				failed.push(t.pkg);
				continue;
			}
			stop = ctx.spinner(
				`Installing ${t.pkg} (a Tor bridge transport)${overTor ? ' over Tor' : ''}…`
			);
			try {
				await rt.install(t.pkg, overTor);
			} finally {
				stop();
			}
			if (!rt.installed(t.pkg)) failed.push(t.pkg);
		}
		return failed;
	};

	let current = before;
	let restarted = false;
	let changedElsewhere = false;
	const attempt = async (text: string, kind: 'bridges' | 'plain'): Promise<Attempt> => {
		if (rt.now() + 60_000 > end) return 'no-time';
		const v = rt.verifies(text);
		if (!v.ok) {
			ctx.warn(
				`${label}: Tor did not accept the torrc ${kind === 'bridges' ? 'with bridges' : 'without bridges'} (${
					v.out
						.split('\n')
						.find((l) => /warn|err/i.test(l))
						?.trim() ?? 'verify-config failed'
				}).`
			);
			return 'rejected';
		}
		if (text !== current) {
			// Never over an edit made since this run read it.
			if (rt.readTorrc() !== current) {
				changedElsewhere = true;
				return 'changed';
			}
			if (!rt.writeTorrc(text)) return 'unwritable';
			current = text;
		}
		return restartAndProve(kind);
	};

	/** Restart Tor on the torrc in place, wait for it to connect, and prove
	 *  the .onion (or a page) loads through it. */
	async function restartAndProve(
		kind: 'bridges' | 'plain'
	): Promise<'works' | 'no-connect' | 'nothing-loads'> {
		const since = rt.now();
		stop = ctx.spinner(
			kind === 'bridges'
				? 'Restarting Tor over bridges and waiting for it to connect (up to 5 minutes)…'
				: 'Restarting Tor without bridges and waiting for it to connect (up to 5 minutes)…'
		);
		let connected = false;
		try {
			restarted = true;
			await rt.restartTor();
			const until = Math.min(end, since + TOR_BRIDGES_CONNECT_MS);
			while (rt.now() + 5_000 <= until) {
				await rt.sleep(5_000);
				if (await rt.connectedSince(since)) {
					connected = true;
					break;
				}
			}
		} finally {
			stop();
		}
		if (!connected) return 'no-connect';
		stop = ctx.spinner('Checking that the .onion loads (Tor publishes it in a minute or two)…');
		try {
			return (await torLoads(rt, Math.min(end, rt.now() + TOR_BRIDGES_PROOF_MS)))
				? 'works'
				: 'nothing-loads';
		} finally {
			stop();
		}
	}

	/** Nothing worked: the torrc this run found goes back (unless something
	 *  else changed it meanwhile), and Tor restarts on it. */
	const finish = async (outcomes: string[], notes: string): Promise<HealResult> => {
		const what = outcomes.join('; ');
		if (!restarted && current === before)
			return {
				strategy: 'left-alone',
				verified: false,
				detail: changedElsewhere
					? `${label}: Tor on this server loads nothing (${what}), so it was left as it is; the next check (within 6 hours) looks again. On this server: sudo journalctl -u tor@default -n 50${notes}`
					: `${label}: Tor on this server loads nothing (${what}), so nothing was changed. On this server: sudo journalctl -u tor@default -n 50${notes}`
			};
		let restored = true;
		let changed = false;
		if (current !== before) {
			if (rt.readTorrc() !== current) changed = true;
			else restored = rt.writeTorrc(before);
		}
		if (changed)
			return {
				strategy: 'left-alone',
				verified: false,
				detail: `${label}: Tor on this server loads nothing (${what}), and /etc/tor/torrc was changed by something else during this check, so it was not put back: it holds that change. On this server: sudo journalctl -u tor@default -n 50, and compare /etc/tor/torrc with /etc/tor/torrc.bak-before-bridges${notes}`
			};
		if (restored && restarted) await rt.restartTor();
		return {
			strategy: 'reverted',
			verified: false,
			detail: restored
				? `${label}: Tor on this server loads nothing (${what}), so /etc/tor/torrc is as it was. On this server: sudo journalctl -u tor@default -n 50${notes}`
				: `${label}: Tor on this server loads nothing (${what}), and /etc/tor/torrc could not be put back as it was: it now holds the last config tried. On this server: sudo journalctl -u tor@default -n 50, and compare /etc/tor/torrc with /etc/tor/torrc.bak-before-bridges${notes}`
		};
	};

	/** Tor worked over bridges, plain Tor did not work as this server's Tor:
	 *  the bridges go back (unless something else changed the torrc), Tor is
	 *  proven to work over them again, and plain Tor waits a week. */
	const keepBridges = async (
		r: Attempt,
		notes: string,
		state: TorBridgesState
	): Promise<HealResult> => {
		const why = outcomeText('plain', r);
		// Nothing was written or restarted (Tor refused the plain config, the
		// torrc changed meanwhile, or no time was left): the bridges are as
		// they were, and Tor works over them.
		if (!restarted && current === before) {
			if (r === 'rejected')
				rt.writeState({ ...state, lastPlainProbe: rt.now(), plainFailedAt: rt.now() });
			return {
				strategy: 'already',
				verified: true,
				routine: false,
				detail: `${label}: Tor works on this server over bridges. A separate Tor client loaded through plain Tor, but the bridges stay (${why}).${notes}`
			};
		}
		rt.writeState({ ...state, lastPlainProbe: rt.now(), plainFailedAt: rt.now() });
		const head = `${label}: a separate Tor client loaded through plain Tor, but this server's Tor did not work without bridges (${why})`;
		if (current !== before) {
			if (rt.readTorrc() !== current)
				return {
					strategy: 'left-alone',
					verified: false,
					detail: `${head}, and /etc/tor/torrc was changed by something else during this check, so it was not put back: it holds that change. On this server: sudo journalctl -u tor@default -n 50, and compare /etc/tor/torrc with /etc/tor/torrc.bak-before-bridges${notes}`
				};
			if (!rt.writeTorrc(before))
				return {
					strategy: 'reverted',
					verified: false,
					detail: `${head}, and /etc/tor/torrc could not be put back with its bridges: it now holds the config without them. On this server: sudo journalctl -u tor@default -n 50, and compare /etc/tor/torrc with /etc/tor/torrc.bak-before-bridges${notes}`
				};
			current = before;
		}
		const back = restarted ? await restartAndProve('bridges') : 'works';
		return back === 'works'
			? {
					strategy: 'already',
					verified: true,
					routine: false,
					detail: `${head}, so the bridges stay; Tor works over them again (checked through Tor). Plain Tor is tried again in a week.${notes}`
				}
			: {
					strategy: 'reverted',
					verified: false,
					detail: `${head}; the bridges are back in /etc/tor/torrc, but Tor ${back === 'no-connect' ? 'did not connect over them yet' : 'connected over them and loaded nothing yet'}. The next check (within 6 hours) looks again. On this server: sudo journalctl -u tor@default -n 50${notes}`
				};
	};

	if (works) {
		let notes = '';
		let routine = true;
		// A Tor/I2P-only server: the transports now, over the Tor that works.
		if (hidden && missing.length > 0) {
			const failed = await installMissing(true);
			routine = false;
			notes =
				failed.length === 0
					? ` The bridge transports (${missing.map((t) => t.pkg).join(', ')}) were installed over Tor while it works, so this Tor/I2P-only server can move onto bridges if its network starts filtering Tor.`
					: ` The bridge transports (${failed.join(', ')}) could not be installed over Tor now; the next check tries again.`;
		}
		const state = rt.readState();
		const due =
			(state.lastPlainProbe === undefined ||
				rt.now() - state.lastPlainProbe >= TOR_BRIDGES_PLAIN_PROBE_EVERY_MS) &&
			(state.plainFailedAt === undefined ||
				rt.now() - state.plainFailedAt >= TOR_BRIDGES_PLAIN_BACKOFF_MS);
		if (bridged && due) {
			stop = ctx.spinner(
				'Checking whether plain Tor works on this network again (a separate Tor client, up to 5 minutes)…'
			);
			let plain = false;
			try {
				plain = await rt.plainTorWorks(Math.min(end, rt.now() + TOR_BRIDGES_PLAIN_PROBE_MS));
			} finally {
				stop();
			}
			rt.writeState({ ...state, lastPlainProbe: rt.now() });
			if (plain) {
				const r = await attempt(withoutBridges(before), 'plain');
				if (r === 'works')
					return {
						strategy: 'bridges-removed',
						verified: true,
						detail: `${label}: plain Tor works on this network again (a separate Tor client loaded through it), so the bridges were taken out of /etc/tor/torrc; the .onion loads (checked through Tor).${notes}`
					};
				return keepBridges(r, notes, state);
			}
		}
		return {
			strategy: 'already',
			verified: true,
			routine,
			detail: `${label}: Tor works on this server${bridged ? ' (over bridges)' : ''}.${notes}`
		};
	}

	// What to try, in order. A server already on bridges that loads nothing
	// (bridges rotated away, a run killed before its proof, or a network that
	// stopped filtering) gets the release's list again, then plain Tor; one
	// that is not gets the bridges. A Tor/I2P-only server installs nothing now:
	// its package downloads go through the Tor that does not work.
	const notInstalled = hidden ? missing.map((t) => t.pkg) : await installMissing(false);
	const usable = lines.filter((l) =>
		TOR_TRANSPORTS.some((t) => l.startsWith(`${t.name} `) && rt.installed(t.pkg))
	);
	const tries: Array<{ text: string; kind: 'bridges' | 'plain' }> = [];
	if (usable.length > 0) tries.push({ text: withBridges(before, usable), kind: 'bridges' });
	if (bridged) tries.push({ text: withoutBridges(before), kind: 'plain' });
	if (tries.length === 0) {
		const why =
			lines.length === 0
				? `this release's bridge list (${BUILTIN_BRIDGES_PATH}) has no usable bridge`
				: hidden
					? `the bridge transports (${notInstalled.join(', ')}) are not installed, and this Tor/I2P-only server fetches nothing over clearnet`
					: `neither bridge transport (${notInstalled.join(', ')}) could be installed`;
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `${label}: Tor on this server loads nothing, and ${why}, so nothing was changed. ${
				hidden && lines.length > 0
					? HIDDEN_ONLY_ADVICE
					: 'On this server: sudo apt-get install snowflake-client obfs4proxy, then: sudo morphit-ops upgrade --tor-bridges'
			}`
		};
	}

	const outcomes: string[] = [];
	for (const t of tries) {
		const r = await attempt(t.text, t.kind);
		if (r === 'works') {
			if (t.kind === 'plain')
				return {
					strategy: 'bridges-removed',
					verified: true,
					detail: `${label}: Tor loaded nothing over its bridges but works without them, so the bridges were taken out of /etc/tor/torrc; the .onion loads (checked through Tor).`
				};
			const kinds = TOR_TRANSPORTS.filter((x) => usable.some((l) => l.startsWith(`${x.name} `)))
				.map((x) => x.name)
				.join(' and ');
			return {
				strategy: bridged ? 'refreshed' : 'applied',
				verified: true,
				detail: `${label}: this network filters plain Tor, so Tor now connects through ${kinds} bridges; the .onion loads again (checked through Tor). The first torrc is kept as /etc/tor/torrc.bak-before-bridges.`
			};
		}
		outcomes.push(outcomeText(t.kind, r));
		if (r === 'changed') break;
	}
	return finish(outcomes, '');
}

/** The check between upgrades (ops/systemd): half an hour after the timer
 *  starts, then every 6 hours. */
export const TOR_BRIDGES_UNITS = [
	'morphit-tor-bridges.service',
	'morphit-tor-bridges.timer'
] as const;
export const TOR_BRIDGES_TIMER = 'morphit-tor-bridges.timer';
/** One run at a time: the timer's and an upgrade's would both restart Tor. */
export const TOR_BRIDGES_LOCK = '/run/morphit-tor-bridges.lock';

/** Take the lock: a directory holding the owner's pid, put in place with one
 *  rename (so it never exists without its pid). A lock whose owner is gone, or
 *  older than the longest run, is moved aside with one rename and replaced; a
 *  lock found aside that is not the one seen stale (another run took it over
 *  in between) is moved back, and this run waits. */
export function takeTorBridgesLock(
	path: string,
	now: number = Date.now(),
	hooks: { readonly beforeMoveAside?: () => void } = {}
): boolean {
	const own = (): boolean => {
		let tmp = '';
		try {
			tmp = mkdtempSync(`${path}.new-`);
			writeFileSync(join(tmp, 'pid'), String(process.pid));
			renameSync(tmp, path); // fails when a lock is there (a non-empty directory)
			return true;
		} catch {
			if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
			return false;
		}
	};
	if (own()) return true;
	const pidIn = (dir: string): string | null => {
		try {
			return readFileSync(join(dir, 'pid'), 'utf8').trim();
		} catch {
			return null;
		}
	};
	const seen = pidIn(path);
	let stale = true;
	try {
		const pid = Number(seen ?? '');
		const age = now - statSync(path).mtimeMs;
		let alive = false;
		try {
			if (Number.isInteger(pid) && pid > 0) {
				process.kill(pid, 0);
				alive = true;
			}
		} catch {
			alive = false;
		}
		stale = !alive || age > TOR_BRIDGES_HEAL_MAX_MS + 5 * 60_000;
	} catch {
		stale = true;
	}
	if (!stale) return false;
	hooks.beforeMoveAside?.();
	const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
	try {
		renameSync(path, aside);
	} catch {
		return false; // another run moved it first
	}
	// Another run may have taken the stale lock over between the check and the
	// move: then this moved ITS lock, which goes back, and this run waits.
	if (pidIn(aside) !== seen) {
		try {
			renameSync(aside, path);
		} catch {
			rmSync(aside, { recursive: true, force: true });
		}
		return false;
	}
	rmSync(aside, { recursive: true, force: true });
	return own();
}

/** Release the lock only when it is still ours. */
export function releaseTorBridgesLock(path: string): void {
	try {
		if (readFileSync(join(path, 'pid'), 'utf8').trim() === String(process.pid))
			rmSync(path, { recursive: true, force: true });
	} catch {
		/* not there, or not ours */
	}
}

/** The real entry `morphit-ops upgrade` (its after-restart checks) and
 *  `morphit-ops upgrade --tor-bridges` (the timer) call: the repair, then the
 *  check between upgrades is installed and turned on — after the repair, so the
 *  timer's first run never overlaps it. */
export async function heal(
	ctx: HealCtx,
	installDir: string,
	deps: {
		readonly runtime?: TorBridgesRuntime;
		readonly lockPath?: string;
		readonly torPresent?: () => boolean;
		readonly installTimer?: () => InstallUnitsResult;
	} = {}
): Promise<HealResult> {
	const lock = deps.lockPath ?? TOR_BRIDGES_LOCK;
	if (!takeTorBridgesLock(lock))
		return {
			strategy: 'busy',
			verified: true,
			routine: true,
			detail: `${label}: another check is running on this server now; it does the same.`
		};
	let r: HealResult;
	try {
		r = await healTorBridges(ctx, { runtime: deps.runtime ?? realRuntime(installDir) });
	} finally {
		releaseTorBridgesLock(lock);
	}
	if (!(deps.torPresent ?? (() => existsSync(TORRC)))()) return r;
	const inst = (
		deps.installTimer ??
		(() =>
			installAndEnableUnits({
				templateDir: join(installDir, 'ops', 'systemd'),
				systemdDir: process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system',
				units: TOR_BRIDGES_UNITS,
				timer: TOR_BRIDGES_TIMER,
				noSystemd: process.env.MORPHIT_HEAL_NO_SYSTEMD === '1'
			}))
	)();
	if (!inst.ok)
		return {
			...r,
			routine: false,
			detail: `${r.detail} The same check between upgrades could not be turned on (${inst.detail ?? 'unknown reason'}); on this server: sudo systemctl enable --now ${TOR_BRIDGES_TIMER}`
		};
	if (inst.written.length > 0)
		return {
			...r,
			routine: false,
			detail: `${r.detail} This check now also runs between upgrades (half an hour after the server starts, then every 6 hours).`
		};
	return r;
}

const TORRC = '/etc/tor/torrc';
const DEFAULTS = '/usr/share/tor/tor-service-defaults-torrc';
const UNIT = 'tor@default.service';
const ONION_RE = /^[a-z2-7]{56}\.onion$/;
const TOR_BRIDGES_STATE = join(ROOT_STATE_DIR, 'tor-bridges.json');

/** Tor's own user (debian-tor; `tor` elsewhere), or null. On a Tor-only node
 *  only that user (and i2pd's) may leave the box, root included. */
export function torProbeUser(passwd = '/etc/passwd'): { uid: number; gid: number } | null {
	try {
		const rows = readFileSync(passwd, 'utf8').split('\n');
		for (const name of ['debian-tor', 'tor', '_tor']) {
			const f = rows.find((r) => r.startsWith(`${name}:`))?.split(':');
			const uid = Number(f?.[2]);
			const gid = Number(f?.[3]);
			if (f && Number.isInteger(uid) && Number.isInteger(gid) && uid > 0) return { uid, gid };
		}
	} catch {
		/* no passwd */
	}
	return null;
}

/** `tor --verify-config` on this torrc text, as the service runs it (its
 *  defaults file, no daemon). */
export function verifyTorrc(text: string): { ok: boolean; out: string } {
	const d = mkdtempSync(join(tmpdir(), 'torrc-'));
	try {
		writeFileSync(join(d, 'torrc'), text);
		const r = spawnSync(
			'tor',
			[
				'--defaults-torrc',
				DEFAULTS,
				'-f',
				join(d, 'torrc'),
				'--RunAsDaemon',
				'0',
				'--verify-config'
			],
			{ encoding: 'utf8', timeout: 30_000 }
		);
		return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

/** This server's .onion: its own service (`morphit`) first, else the first
 *  other service with a hostname; null when it hosts none. */
export function onionHostname(dir = '/var/lib/tor'): string | null {
	const read = (sub: string): string | null => {
		try {
			const h = readFileSync(join(dir, sub, 'hostname'), 'utf8').trim();
			return ONION_RE.test(h) ? h : null;
		} catch {
			return null;
		}
	};
	const own = read('morphit');
	if (own !== null) return own;
	try {
		for (const sub of readdirSync(dir).sort()) {
			const h = read(sub);
			if (h !== null) return h;
		}
	} catch {
		/* no Tor data directory */
	}
	return null;
}

/** One request through a Tor SOCKS port: the HTTP status, 0 for none. */
async function curlStatus(socks: string, url: string, timeoutMs: number): Promise<number> {
	const r = await runAsync(
		'curl',
		[
			'-s',
			'-o',
			'/dev/null',
			'--proto',
			'=http,https',
			'-m',
			String(Math.max(1, Math.ceil(timeoutMs / 1000))),
			'--socks5-hostname',
			socks,
			'-w',
			'%{http_code}',
			url
		],
		{ timeoutMs: timeoutMs + 10_000 }
	);
	const code = Number(r.stdout.trim());
	return Number.isInteger(code) ? code : 0;
}

/** apt-get's arguments for one transport: a dpkg lock held by something else
 *  is waited for (a minute) rather than failing; `overTor` sends every
 *  download through Tor's SOCKS port (a Tor/I2P-only server). PURE. */
export function aptInstallArgs(pkg: string, overTor: boolean, socks: string): string[] {
	const proxy = `socks5h://apt-transport-tor@${socks}`;
	return [
		...(overTor
			? ['-o', `Acquire::http::Proxy=${proxy}`, '-o', `Acquire::https::Proxy=${proxy}`]
			: []),
		'-o',
		'DPkg::Lock::Timeout=60',
		'install',
		'-y',
		'--no-install-recommends',
		pkg
	];
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const a = srv.address();
			const port = typeof a === 'object' && a !== null ? a.port : 0;
			srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
		});
	});
}

/**
 * Does Tor WITHOUT bridges work on this network now? A separate, throwaway
 * Tor client (its own empty config, data directory and SOCKS port; the
 * server's Tor is not touched) must connect and then load the .onion or a
 * page, by `until`. The client is killed and its directory removed after.
 * Never throws.
 */
export async function plainTorProbe(o: {
	readonly until: number;
	readonly onion: string | null;
}): Promise<boolean> {
	if (Date.now() + 30_000 > o.until) return false;
	// A run killed hard (no clean-up) leaves its directory: gone after an hour.
	try {
		for (const f of readdirSync(tmpdir())) {
			const old = join(tmpdir(), f);
			if (f.startsWith('morphit-plain-tor-') && Date.now() - statSync(old).mtimeMs > 3_600_000)
				rmSync(old, { recursive: true, force: true });
		}
	} catch {
		/* nothing to tidy */
	}
	const d = mkdtempSync(join(tmpdir(), 'morphit-plain-tor-'));
	let child: ChildProcess | null = null;
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	try {
		const port = await freePort();
		const rc = join(d, 'torrc');
		writeFileSync(rc, '', { mode: 0o644 });
		// As Tor's own user when this runs as root: a Tor-only node's egress
		// rule lets only that user out, and no reason to run Tor as root.
		const user = process.getuid?.() === 0 ? torProbeUser() : null;
		if (user !== null) chownSync(d, user.uid, user.gid);
		child = spawn(
			'tor',
			[
				'-f',
				rc,
				'--defaults-torrc',
				rc,
				'--DataDirectory',
				join(d, 'data'),
				'--SocksPort',
				`127.0.0.1:${port}`,
				'--ControlPort',
				'0',
				'--ORPort',
				'0',
				'--DNSPort',
				'0',
				'--Log',
				`notice file ${join(d, 'log')}`,
				'--RunAsDaemon',
				'0',
				// It exits by itself when this process is gone, however that
				// happens (a hard kill skips the clean-up below).
				'__OwningControllerProcess',
				String(process.pid)
			],
			{ stdio: 'ignore', ...(user !== null ? { uid: user.uid, gid: user.gid } : {}) }
		);
		child.on('error', () => undefined);
		let up = false;
		while (Date.now() + 2_000 <= o.until) {
			await sleep(2_000);
			let log = '';
			try {
				log = readFileSync(join(d, 'log'), 'utf8');
			} catch {
				/* not written yet */
			}
			if (/Bootstrapped 100%/.test(log)) {
				up = true;
				break;
			}
			if (child.exitCode !== null || child.signalCode !== null) break;
		}
		if (!up) return false;
		const socks = `127.0.0.1:${port}`;
		for (let i = 0; i < 3 && Date.now() + 15_000 <= o.until; i++) {
			if (
				o.onion !== null &&
				(await curlStatus(socks, `http://${o.onion}/`, Math.min(90_000, o.until - Date.now()))) >=
					100
			)
				return true;
			if (Date.now() + 15_000 > o.until) break;
			if ((await curlStatus(socks, TOR_CHECK_URL, Math.min(45_000, o.until - Date.now()))) === 200)
				return true;
		}
		return false;
	} catch {
		return false;
	} finally {
		if (child !== null && child.exitCode === null && child.signalCode === null) {
			const c = child;
			const gone = new Promise<void>((r) => c.once('exit', () => r()));
			c.kill('SIGKILL');
			await Promise.race([gone, sleep(5_000)]);
		}
		rmSync(d, { recursive: true, force: true });
	}
}

function realRuntime(installDir = '/opt/morphit'): TorBridgesRuntime {
	return {
		readTorrc: () => {
			try {
				return readFileSync(TORRC, 'utf8');
			} catch {
				return null;
			}
		},
		writeTorrc: (t) => {
			// Its own name: another writer (the PoW heal) never shares it.
			const tmp = `${TORRC}.morphit-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
			try {
				// The first original is kept once, never overwritten.
				try {
					writeFileSync(`${TORRC}.bak-before-bridges`, readFileSync(TORRC), { flag: 'wx' });
				} catch {
					/* already kept */
				}
				writeFileSync(tmp, t, { mode: 0o644 });
				keepOwnerAndMode(TORRC, tmp);
				renameSync(tmp, TORRC);
				return true;
			} catch {
				rmSync(tmp, { force: true });
				return false;
			}
		},
		verifies: verifyTorrc,
		torActive: () => spawnSync('systemctl', ['is-active', '--quiet', UNIT]).status === 0,
		onion: () => onionHostname(),
		status: (url, timeoutMs) => curlStatus(torSocksFromEnv(), url, timeoutMs),
		installed: (pkg) =>
			/install ok installed/.test(
				spawnSync('dpkg-query', ['-W', '-f=${Status}', pkg], { encoding: 'utf8' }).stdout ?? ''
			),
		install: async (pkg, overTor) =>
			(
				await runAsync('apt-get', aptInstallArgs(pkg, overTor, torSocksFromEnv()), {
					timeoutMs: TOR_BRIDGES_INSTALL_MS,
					env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
				})
			).status === 0,
		restartTor: async () =>
			(await runAsync('systemctl', ['restart', UNIT], { timeoutMs: 120_000 })).status === 0,
		connectedSince: async (sinceMs) => {
			const r = await runAsync(
				'journalctl',
				['-u', UNIT, '--since', `@${Math.floor(sinceMs / 1000)}`, '--no-pager', '-o', 'cat'],
				{ timeoutMs: 20_000 }
			);
			return /Bootstrapped 100%/.test(r.stdout);
		},
		hiddenOnly: () => isHiddenOnlyNode(),
		bridgeList: () => {
			try {
				return JSON.parse(readFileSync(join(installDir, BUILTIN_BRIDGES_PATH), 'utf8'));
			} catch {
				return null;
			}
		},
		plainTorWorks: (until) => plainTorProbe({ until, onion: onionHostname() }),
		readState: () => {
			try {
				const j = JSON.parse(readFileSync(TOR_BRIDGES_STATE, 'utf8')) as Record<string, unknown>;
				const n = (v: unknown): number | undefined =>
					typeof v === 'number' && Number.isFinite(v) ? v : undefined;
				return { lastPlainProbe: n(j.lastPlainProbe), plainFailedAt: n(j.plainFailedAt) };
			} catch {
				return {};
			}
		},
		writeState: (st) => {
			try {
				mkdirSync(ROOT_STATE_DIR, { recursive: true, mode: 0o700 });
				const tmp = `${TOR_BRIDGES_STATE}.tmp-${process.pid}`;
				writeFileSync(tmp, `${JSON.stringify(st)}\n`, { mode: 0o600 });
				renameSync(tmp, TOR_BRIDGES_STATE);
			} catch {
				/* the next run probes again: harmless */
			}
		},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: () => Date.now()
	};
}
