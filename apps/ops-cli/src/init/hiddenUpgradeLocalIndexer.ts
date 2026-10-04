/**
 * hiddenUpgradeLocalIndexer — which local address is THIS node's indexer, and
 * is the process answering there really it?
 *
 * WHAT WAS WRONG. `morphit-ops upgrade` runs as root, and before every upgrade
 * it asked plain HTTP on 127.0.0.1, then 172.18.0.1, then 172.17.0.1, port 8081,
 * taking the FIRST address that answered as this node's indexer. That answer
 * decided whether the node is hidden-only, which SHA-256 and IPNS name the
 * release must match, and which peers to download it from. Nothing checked who
 * was listening. Any unprivileged local process (the ipfs user, morphit-mcp,
 * the matrix bot, an operator login) that got to 127.0.0.1:8081 first — easy
 * while the indexer is down or crash-looping, exactly when an operator runs an
 * upgrade — could claim "hidden-only" and hand root a tarball of its choosing,
 * whose build steps and re-exec then ran as root. A clearnet node was diverted
 * onto that path too, skipping its signature and primary-hash checks.
 *
 * WHAT THIS MODULE DOES INSTEAD.
 *   1. Hidden-only is decided from the ROOT-OWNED config the indexer itself
 *      runs with (an empty clearnet RPC pool), never from an HTTP answer. Only
 *      when that config cannot be read (the release monitor runs as an
 *      unprivileged user and indexer.env is 0640 root) is the indexer asked —
 *      and then only after step 3 has authenticated it.
 *   2. Only the address the indexer is CONFIGURED to listen on is asked
 *      (MORPHIT_INDEXER_LISTEN_HOST / _PORT, from the same config). The old
 *      three-address list is a fallback only when nothing is configured, and
 *      the first address with a listener is the answer: we never move on to
 *      the next address after one has something listening.
 *   3. The listener is authenticated before a single byte is sent to it:
 *        - as root: the socket must belong to a process in the
 *          morphit-indexer.service cgroup (/proc/net/tcp inode → the process
 *          holding it → /proc/<pid>/cgroup);
 *        - unprivileged (the release monitor): the socket must be owned by the
 *          same user as morphit-indexer.service's main process (root on every
 *          installed box), which no unprivileged process can fake.
 *      Anything else fails closed with a calm, specific message. A box that
 *      runs its indexer outside systemd sets MORPHIT_UPGRADE_TRUST_LOCAL_INDEXER=1
 *      (documented in docs/OPERATIONS.md) to skip only the ownership check.
 */
import {
	accessSync,
	constants,
	existsSync,
	readFileSync,
	readdirSync,
	readlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEffectiveEnv } from '../lib/relayHiddenHeal.ts';

/** The systemd unit whose process must own the indexer's listening socket. */
export const INDEXER_UNIT = 'morphit-indexer.service';

/** The documented escape hatch for installs that do not run the indexer under
 *  systemd. It skips the ownership check only; the configured address, the
 *  "first listener wins" rule and every hash check stay in force. */
export const TRUST_LOCAL_INDEXER_ENV = 'MORPHIT_UPGRADE_TRUST_LOCAL_INDEXER';

/** Used ONLY when the config names no listen address (loopback first, then the
 *  docker bridges — morphit.io binds 172.18.0.1, morphitlat 127.0.0.1). */
export const FALLBACK_INDEXER_BASES: readonly string[] = [
	'http://127.0.0.1:8081',
	'http://172.18.0.1:8081',
	'http://172.17.0.1:8081'
];

/** The files `morphit-indexer.service` sources, in its order, with the install
 *  dir and /etc/morphit relocatable (tests; a non-default install dir). */
export function indexerUnitEnvFiles(installDir: string, etcDir: string): string[] {
	return [
		join(installDir, 'morphit.env'),
		join(installDir, 'morphit.config.env'),
		join(etcDir, 'indexer.env')
	];
}

// ─── reading the root-owned config ──────────────────────────────────────────

export interface IndexerConfigView {
	/** False when a config file exists but this user cannot read it. */
	readonly readable: boolean;
	/** MORPHIT_INDEXER_RPC_ENDPOINTS as the unit sees it; undefined = unset. */
	readonly rpcEndpoints: string | undefined;
	readonly listenHost: string | undefined;
	readonly listenPort: string | undefined;
}

const canRead = (p: string): boolean => {
	try {
		accessSync(p, constants.R_OK);
		return true;
	} catch {
		return false;
	}
};

/** Read the indexer's effective config the way its unit does (sourced by bash,
 *  in order, last assignment wins). Never throws. */
export function readIndexerConfig(files: readonly string[]): IndexerConfigView {
	const present = files.filter((f) => existsSync(f));
	if (present.some((f) => !canRead(f))) {
		return {
			readable: false,
			rpcEndpoints: undefined,
			listenHost: undefined,
			listenPort: undefined
		};
	}
	try {
		const env = readEffectiveEnv(present, [
			'MORPHIT_INDEXER_RPC_ENDPOINTS',
			'MORPHIT_INDEXER_LISTEN_HOST',
			'MORPHIT_INDEXER_LISTEN_PORT'
		]);
		return {
			readable: true,
			rpcEndpoints: env.get('MORPHIT_INDEXER_RPC_ENDPOINTS'),
			listenHost: env.get('MORPHIT_INDEXER_LISTEN_HOST'),
			listenPort: env.get('MORPHIT_INDEXER_LISTEN_PORT')
		};
	} catch {
		return {
			readable: false,
			rpcEndpoints: undefined,
			listenHost: undefined,
			listenPort: undefined
		};
	}
}

/** The single base URL the config names, or null when it names none. A
 *  wildcard bind is reached on loopback. */
export function configuredIndexerBase(cfg: IndexerConfigView): string | null {
	const rawHost = (cfg.listenHost ?? '').trim();
	const rawPort = (cfg.listenPort ?? '').trim();
	if (rawHost === '' && rawPort === '') return null;
	const port = rawPort === '' ? 8081 : Number(rawPort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	let host = rawHost === '' || rawHost === '0.0.0.0' ? '127.0.0.1' : rawHost;
	if (host === '::' || host === '[::]') host = '::1';
	if (host === 'localhost') host = '127.0.0.1';
	const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	return `http://${shown}:${port}`;
}

// ─── who is listening ───────────────────────────────────────────────────────

export interface TcpListener {
	/** Local address as 4 (IPv4) or 16 (IPv6) bytes. */
	readonly addr: readonly number[];
	readonly port: number;
	readonly uid: number;
	readonly inode: string;
}

/** Parse /proc/net/tcp or tcp6 text into its LISTEN rows. PURE. */
export function parseProcNetTcp(text: string): TcpListener[] {
	const out: TcpListener[] = [];
	for (const line of text.split('\n').slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10 || f[3] !== '0A') continue; // 0A = TCP_LISTEN
		const [hexAddr, hexPort] = (f[1] ?? '').split(':');
		if (!hexAddr || !hexPort) continue;
		const addr: number[] = [];
		// The kernel prints each 32-bit word in host (little-endian) order.
		for (let w = 0; w < hexAddr.length; w += 8) {
			const word = hexAddr.slice(w, w + 8);
			for (let b = 3; b >= 0; b--) addr.push(parseInt(word.slice(b * 2, b * 2 + 2), 16));
		}
		out.push({ addr, port: parseInt(hexPort, 16), uid: Number(f[7]), inode: f[9] ?? '' });
	}
	return out;
}

/** An IP literal as bytes, or null for anything that is not one. PURE. */
export function ipBytes(host: string): number[] | null {
	const h = host.replace(/^\[|\]$/g, '');
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (v4) {
		const b = v4.slice(1).map(Number);
		return b.every((x) => x <= 255) ? b : null;
	}
	if (!h.includes(':')) return null;
	const [headRaw, tailRaw, extra] = h.split('::');
	if (extra !== undefined) return null;
	const words = (s: string | undefined): number[] | null => {
		if (s === undefined || s === '') return [];
		const out: number[] = [];
		for (const part of s.split(':')) {
			if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
			const n = parseInt(part, 16);
			out.push(n >> 8, n & 255);
		}
		return out;
	};
	const head = words(headRaw);
	const tail = words(tailRaw);
	if (head === null || tail === null) return null;
	if (tailRaw === undefined) return head.length === 16 ? head : null;
	const fill = 16 - head.length - tail.length;
	if (fill < 0) return null;
	return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

const same = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);
const isZero = (a: readonly number[]): boolean => a.every((x) => x === 0);
/** ::ffff:a.b.c.d → a.b.c.d; anything else unchanged. */
const unmapV4 = (a: readonly number[]): readonly number[] =>
	a.length === 16 && isZero(a.slice(0, 10)) && a[10] === 255 && a[11] === 255 ? a.slice(12) : a;

/** The listeners a connection to host:port would reach: an exact bind wins
 *  over a wildcard one, as in the kernel. PURE. */
export function listenersFor(
	all: readonly TcpListener[],
	hostBytes: readonly number[],
	port: number
): TcpListener[] {
	const onPort = all.filter((l) => l.port === port);
	const exact = onPort.filter((l) => same(unmapV4(l.addr), hostBytes) || same(l.addr, hostBytes));
	if (exact.length > 0) return exact;
	// A wildcard bind: 0.0.0.0 for IPv4; [::] (dual-stack) for either family.
	return onPort.filter((l) => isZero(l.addr) && (l.addr.length === 16 || hostBytes.length === 4));
}

// ─── the verdict ────────────────────────────────────────────────────────────

export type ListenerVerdict =
	| { readonly kind: 'nothing-listening' }
	| { readonly kind: 'verified'; readonly how: 'cgroup' | 'socket-owner' | 'override' }
	| { readonly kind: 'refused'; readonly reason: string };

export type ListenerVerifier = (host: string, port: number) => ListenerVerdict;

export interface ListenerProbeDeps {
	/** Where /proc lives. Tests point this at a scratch tree. */
	readonly procRoot?: string;
	readonly isRoot?: () => boolean;
	/** MainPID of morphit-indexer.service, or null when it is not running. */
	readonly indexerMainPid?: () => number | null;
	readonly env?: NodeJS.ProcessEnv;
}

function systemdMainPid(): number | null {
	const r = spawnSync('systemctl', ['show', '-p', 'MainPID', '--value', INDEXER_UNIT], {
		encoding: 'utf8',
		timeout: 5_000,
		stdio: ['ignore', 'pipe', 'ignore']
	});
	const pid = Number((r.stdout ?? '').trim());
	return r.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
}

const HOW_TO_OVERRIDE =
	`If this box runs its indexer outside systemd, set ${TRUST_LOCAL_INDEXER_ENV}=1 for this ` +
	'command to skip this check (see docs/OPERATIONS.md, "Upgrading").';

/**
 * Is the process listening on host:port this node's indexer? Reads /proc only;
 * sends nothing to the listener. Never throws.
 */
export function verifyIndexerListener(
	host: string,
	port: number,
	deps: ListenerProbeDeps = {}
): ListenerVerdict {
	const proc = deps.procRoot ?? '/proc';
	const env = deps.env ?? process.env;
	const hostBytes = ipBytes(host);
	if (hostBytes === null) {
		return {
			kind: 'refused',
			reason:
				`the indexer's listen address "${host}" is not an IP address, so the process behind it ` +
				`cannot be checked. Set MORPHIT_INDEXER_LISTEN_HOST to an IP address. ${HOW_TO_OVERRIDE}`
		};
	}
	let rows: TcpListener[] = [];
	let readAny = false;
	for (const f of ['net/tcp', 'net/tcp6']) {
		try {
			rows = rows.concat(parseProcNetTcp(readFileSync(join(proc, f), 'utf8')));
			readAny = true;
		} catch {
			/* tcp6 may be absent on an IPv4-only kernel */
		}
	}
	if (!readAny) {
		return {
			kind: 'refused',
			reason: `could not read the list of listening sockets (${proc}/net/tcp). ${HOW_TO_OVERRIDE}`
		};
	}
	const hits = listenersFor(rows, hostBytes, port);
	if (hits.length === 0) return { kind: 'nothing-listening' };
	if (env[TRUST_LOCAL_INDEXER_ENV] === '1') return { kind: 'verified', how: 'override' };

	const where = `${host}:${port}`;
	const isRoot =
		deps.isRoot ?? (() => typeof process.getuid === 'function' && process.getuid() === 0);
	if (isRoot()) {
		// Map each listening socket's inode to the process(es) holding it.
		const wanted = new Set(hits.map((h) => `socket:[${h.inode}]`));
		const holders = new Map<string, number[]>();
		let pids: string[] = [];
		try {
			pids = readdirSync(proc).filter((d) => /^\d+$/.test(d));
		} catch {
			return { kind: 'refused', reason: `could not list processes in ${proc}. ${HOW_TO_OVERRIDE}` };
		}
		for (const pid of pids) {
			let fds: string[];
			try {
				fds = readdirSync(join(proc, pid, 'fd'));
			} catch {
				continue; // exited meanwhile
			}
			for (const fd of fds) {
				let target: string;
				try {
					target = readlinkSync(join(proc, pid, 'fd', fd));
				} catch {
					continue;
				}
				if (wanted.has(target)) holders.set(target, [...(holders.get(target) ?? []), Number(pid)]);
			}
		}
		for (const h of hits) {
			const owners = holders.get(`socket:[${h.inode}]`) ?? [];
			if (owners.length === 0) {
				return {
					kind: 'refused',
					reason: `could not find which process is listening on ${where}. ${HOW_TO_OVERRIDE}`
				};
			}
			for (const pid of owners) {
				let cg = '';
				try {
					cg = readFileSync(join(proc, String(pid), 'cgroup'), 'utf8');
				} catch {
					/* unreadable is not the indexer */
				}
				if (!/\/morphit-indexer\.service(\/|$)/m.test(cg)) {
					let comm = '?';
					try {
						comm = readFileSync(join(proc, String(pid), 'comm'), 'utf8').trim();
					} catch {
						/* name is only for the message */
					}
					return {
						kind: 'refused',
						reason:
							`the process listening on ${where} (pid ${pid}, ${comm}) is not part of ` +
							`${INDEXER_UNIT}, so its answers are not trusted. Start the indexer ` +
							`(sudo systemctl start morphit-indexer) and stop whatever holds that port. ${HOW_TO_OVERRIDE}`
					};
				}
			}
		}
		return { kind: 'verified', how: 'cgroup' };
	}

	// Unprivileged: other users' fds are unreadable, but every socket's owner is
	// public. The indexer's main process owner is public too.
	const mainPid = (deps.indexerMainPid ?? systemdMainPid)();
	if (mainPid === null) {
		return {
			kind: 'refused',
			reason: `${INDEXER_UNIT} is not running, so nothing on ${where} can be trusted as it. ${HOW_TO_OVERRIDE}`
		};
	}
	let indexerUid: number | null = null;
	try {
		const m = /^Uid:\s+(\d+)/m.exec(readFileSync(join(proc, String(mainPid), 'status'), 'utf8'));
		indexerUid = m ? Number(m[1]) : null;
	} catch {
		indexerUid = null;
	}
	if (indexerUid === null) {
		return {
			kind: 'refused',
			reason: `could not read which user ${INDEXER_UNIT} runs as. ${HOW_TO_OVERRIDE}`
		};
	}
	const stranger = hits.find((h) => h.uid !== indexerUid);
	if (stranger !== undefined) {
		return {
			kind: 'refused',
			reason:
				`the socket listening on ${where} belongs to user id ${stranger.uid}, not to the user ` +
				`${INDEXER_UNIT} runs as (${indexerUid}), so its answers are not trusted. ${HOW_TO_OVERRIDE}`
		};
	}
	return { kind: 'verified', how: 'socket-owner' };
}

// ─── locating + asking the indexer ─────────────────────────────────────────

export interface LocalIndexerOptions {
	/** Explicit base URLs. Tests only; otherwise the configured address. */
	readonly bases?: readonly string[];
	/** The indexer unit's env files (for its listen address). */
	readonly unitEnvFiles?: readonly string[];
	/** How the listener is authenticated. Tests inject; default reads /proc. */
	readonly verifyListener?: ListenerVerifier;
}

/** The candidate bases, most specific first. */
export function candidateIndexerBases(opts: LocalIndexerOptions): readonly string[] {
	if (opts.bases && opts.bases.length > 0) return opts.bases;
	if (opts.unitEnvFiles) {
		const configured = configuredIndexerBase(readIndexerConfig(opts.unitEnvFiles));
		if (configured !== null) return [configured];
	}
	return FALLBACK_INDEXER_BASES;
}

/**
 * The ONE base URL of this node's authenticated indexer. The first candidate
 * with anything listening is the answer; if that listener is not the indexer
 * this throws rather than trying the next address. Throws a calm, specific
 * message when there is no such listener.
 */
export function locateLocalIndexer(opts: LocalIndexerOptions): string {
	const bases = candidateIndexerBases(opts);
	const verify = opts.verifyListener ?? ((h: string, p: number) => verifyIndexerListener(h, p));
	for (const base of bases) {
		let u: URL;
		try {
			u = new URL(base);
		} catch {
			continue;
		}
		const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
		const v = verify(u.hostname.replace(/^\[|\]$/g, ''), port);
		if (v.kind === 'nothing-listening') continue;
		if (v.kind === 'refused')
			throw new Error(`this node's indexer could not be confirmed: ${v.reason}`);
		return base.replace(/\/+$/, '');
	}
	throw new Error(
		`this node's indexer is not listening (checked ${bases.join(', ')}). ` +
			'Start it with: sudo systemctl start morphit-indexer'
	);
}

/** GET a small JSON document from the authenticated indexer. Body capped. */
export async function getLocalIndexerJson<T>(
	base: string,
	path: string,
	timeoutMs = 5000
): Promise<T> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		// This box's own indexer only: ask for the loopback-only fields
		// (e.g. /v1/instance clearnet_eliminated_missing); public edges strip it.
		const res = await fetch(`${base}${path}`, {
			signal: ctrl.signal,
			redirect: 'manual',
			headers: { 'x-morphit-local-health': '1' }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const txt = await res.text();
		if (txt.length > 4 * 1024 * 1024) throw new Error('response too large');
		return JSON.parse(txt) as T;
	} catch (e) {
		throw new Error(
			`this node's indexer did not answer ${path}: ${e instanceof Error ? e.message : String(e)}`
		);
	} finally {
		clearTimeout(t);
	}
}
