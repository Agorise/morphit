/**
 * Installing the release's npm dependencies during `morphit-ops upgrade`
 * without reaching the clearnet from a hidden-only node.
 *
 * WHAT WAS WRONG. A zero-clearnet node fetched the slim release over Tor/I2P,
 * verified it, and then ran a plain `npm ci`: a direct connection from the
 * box's own address to registry.npmjs.org (and a DNS lookup for it through the
 * system resolver), or, with no clearnet route at all, a failed upgrade that
 * rolled back. Only the self-contained offline bundle, whose node_modules ship
 * prebuilt, skipped it.
 *
 * NOW, on a hidden-only node, in order:
 *   1. The prebuilt node_modules of an offline bundle (its marker) — nothing
 *      to fetch.
 *   2. CARRY FORWARD: when the release's lockfile resolves to exactly the same
 *      packages as the install it replaces (dependencyFingerprint), copy the
 *      previous node_modules trees. No network at all. Most releases change no
 *      dependency.
 *   3. OVER TOR: `npm ci --ignore-scripts` with npm's only proxy set to a
 *      loopback bridge (startTorRegistryBridge) that accepts CONNECT to
 *      registry.npmjs.org:443 alone and opens it through Tor's SOCKS port with
 *      the NAME, so Tor resolves it; TLS is end to end between npm and the
 *      registry. Every proxy variable the shell had is dropped first.
 *   4. Otherwise refuse, and say how to finish: the offline bundle, checked
 *      against the offline_sha256 in @morphit's signed release record.
 * After 2 and 3 the tree is VERIFIED against the lockfile on disk
 * (lockedTreeProblems), not taken from an exit code.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import {
	existsSync,
	readFileSync,
	readdirSync,
	lstatSync,
	mkdirSync,
	copyFileSync,
	writeFileSync
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import {
	socks5Greeting,
	parseSocks5Greeting,
	socks5ConnectRequest,
	parseSocks5ConnectReply
} from '@morphit/hidden-transport';

/** The one host npm may reach through Tor. */
export const NPM_REGISTRY_AUTHORITY = 'registry.npmjs.org:443';

interface LockEntry {
	readonly version?: string;
	readonly resolved?: string;
	readonly integrity?: string;
	readonly link?: boolean;
	readonly optional?: boolean;
	readonly dev?: boolean;
	readonly bin?: Record<string, string> | string;
	readonly os?: readonly string[];
	readonly cpu?: readonly string[];
	readonly hasInstallScript?: boolean;
}

function lockPackages(lockText: string): Record<string, LockEntry> | null {
	try {
		const l = JSON.parse(lockText) as {
			lockfileVersion?: number;
			packages?: Record<string, LockEntry>;
		};
		if (!l || typeof l.packages !== 'object' || l.packages === null) return null;
		return l.packages;
	} catch {
		return null;
	}
}

/**
 * What node_modules is made of, from a package-lock.json: every installed
 * package (path, version, resolved, integrity), every workspace link, and every
 * workspace's `bin`. Workspace VERSIONS and their declared ranges are left out:
 * they change on every release without changing a single file under
 * node_modules. Null when the lockfile cannot be read. PURE.
 */
export function dependencyFingerprint(lockText: string): string | null {
	const pkgs = lockPackages(lockText);
	if (pkgs === null) return null;
	const rows: string[] = [];
	for (const key of Object.keys(pkgs).sort()) {
		const e = pkgs[key]!;
		if (key.includes('node_modules/')) {
			rows.push(
				e.link === true
					? `L ${key} ${e.resolved ?? ''}`
					: `P ${key} ${e.version ?? ''} ${e.resolved ?? ''} ${e.integrity ?? ''}`
			);
		} else if (key !== '' && e.bin !== undefined) {
			rows.push(`B ${key} ${JSON.stringify(e.bin)}`);
		}
	}
	return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** Does this optional package apply to this machine? */
function appliesHere(e: LockEntry): boolean {
	const ok = (list: readonly string[] | undefined, v: string): boolean => {
		if (!list || list.length === 0) return true;
		if (list.some((x) => x === `!${v}`)) return false;
		const positives = list.filter((x) => !x.startsWith('!'));
		return positives.length === 0 || positives.includes(v);
	};
	return ok(e.os, process.platform) && ok(e.cpu, process.arch);
}

/**
 * How the tree under `installDir` differs from its package-lock.json: missing
 * packages, wrong versions, missing workspace links. Optional packages that do
 * not apply to this machine are skipped; optional ones that do apply must be
 * there. Empty = the tree is what the lockfile says. Reads files only.
 */
export function lockedTreeProblems(installDir: string, lockText: string): string[] {
	const pkgs = lockPackages(lockText);
	if (pkgs === null) return ['package-lock.json could not be read'];
	const out: string[] = [];
	for (const [key, e] of Object.entries(pkgs)) {
		if (!key.includes('node_modules/')) continue;
		if (e.optional === true && !appliesHere(e)) continue;
		const at = join(installDir, key);
		if (e.link === true) {
			try {
				if (!lstatSync(at).isSymbolicLink()) out.push(`${key} is not a link`);
			} catch {
				out.push(`${key} link missing`);
			}
			continue;
		}
		let v = '';
		try {
			v =
				(JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')) as { version?: string })
					.version ?? '';
		} catch {
			if (e.optional === true) continue; // an optional install that failed is npm's normal outcome
			out.push(`${key} missing`);
			continue;
		}
		if (e.version !== undefined && v !== e.version)
			out.push(`${key} is ${v}, lockfile says ${e.version}`);
		if (out.length >= 20) break;
	}
	return out;
}

/** The node_modules directories a lockfile installs into (root first). */
export function nodeModulesDirs(lockText: string): string[] {
	const pkgs = lockPackages(lockText) ?? {};
	const dirs = new Set<string>(['node_modules']);
	for (const key of Object.keys(pkgs)) {
		const i = key.indexOf('/node_modules/');
		if (i > 0 && !key.startsWith('node_modules/')) dirs.add(`${key.slice(0, i)}/node_modules`);
	}
	return [...dirs];
}

/** Copy every `*.node` native addon (and nothing else) of the packages that
 *  carry install scripts, from the previous install, when the version is the
 *  same. That is what an install script builds or downloads; without scripts
 *  (`--ignore-scripts`) the new tree lacks it. Returns the packages served. */
export function carryNativeAddons(fromDir: string, toDir: string, lockText: string): string[] {
	const pkgs = lockPackages(lockText) ?? {};
	const served: string[] = [];
	for (const [key, e] of Object.entries(pkgs)) {
		if (e.hasInstallScript !== true || !key.includes('node_modules/') || e.link === true) continue;
		const from = join(fromDir, key);
		const to = join(toDir, key);
		let oldV = '';
		try {
			oldV =
				(JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')) as { version?: string })
					.version ?? '';
		} catch {
			continue;
		}
		if (oldV !== e.version || !existsSync(to)) continue;
		const addons: string[] = [];
		const walk = (d: string, depth: number): void => {
			if (depth > 4) return;
			let names: string[];
			try {
				names = readdirSync(d);
			} catch {
				return;
			}
			for (const n of names) {
				if (n === 'node_modules') continue;
				const p = join(d, n);
				let st;
				try {
					st = lstatSync(p);
				} catch {
					continue;
				}
				if (st.isDirectory()) walk(p, depth + 1);
				else if (st.isFile() && n.endsWith('.node')) addons.push(p);
			}
		};
		walk(from, 0);
		let copied = 0;
		for (const a of addons) {
			const dest = join(to, relative(from, a));
			if (existsSync(dest)) continue;
			mkdirSync(dirname(dest), { recursive: true });
			copyFileSync(a, dest);
			copied++;
		}
		if (copied > 0) served.push(key.replace(/^.*node_modules\//, ''));
	}
	return served;
}

/** An environment for a child npm with every inherited proxy setting removed
 *  (any case), so nothing the shell carried can route npm elsewhere. */
export function withoutProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (/proxy/i.test(k)) continue;
		out[k] = v;
	}
	return out;
}

/** The environment for `npm ci` through the Tor bridge on `bridgePort`. */
export function torNpmEnv(env: NodeJS.ProcessEnv, bridgePort: number): NodeJS.ProcessEnv {
	const proxy = `http://127.0.0.1:${bridgePort}`;
	return {
		...withoutProxyEnv(env),
		npm_config_https_proxy: proxy,
		npm_config_proxy: proxy,
		npm_config_noproxy: '',
		npm_config_registry: 'https://registry.npmjs.org/',
		npm_config_audit: 'false',
		npm_config_fund: 'false',
		npm_config_update_notifier: 'false',
		npm_config_offline: 'false',
		npm_config_prefer_offline: 'true'
	};
}

export interface TorBridge {
	readonly port: number;
	/** Every CONNECT target asked for, allowed or not. */
	readonly asked: string[];
	/** Bytes relayed from the registry to npm so far. */
	received(): number;
	/** When a tunnel last opened or a byte last moved either way (ms, the
	 *  bridge's clock); the stall watch reads it. */
	lastActivity(): number;
	close(): Promise<void>;
}

/** Open `authority` (host:port) through a SOCKS5 proxy, passing the NAME. */
function socksOpen(
	socksHost: string,
	socksPort: number,
	host: string,
	port: number
): Promise<Socket> {
	return new Promise((resolveOpen, rejectOpen) => {
		const s = netConnect({ host: socksHost, port: socksPort });
		let stage: 'greet' | 'connect' = 'greet';
		let acc = Buffer.alloc(0);
		let done = false;
		const fail = (e: Error): void => {
			if (done) return;
			done = true;
			s.destroy();
			rejectOpen(e);
		};
		s.setTimeout(30_000, () => fail(new Error('Tor did not answer in time')));
		s.once('error', (e) => fail(new Error(`Tor SOCKS ${socksHost}:${socksPort}: ${e.message}`)));
		// Tor may close a SOCKS request without a reply. A closed socket never
		// times out, so without this npm's CONNECT waited for ever (morphitlat,
		// 2026-10-31: a tunnel open 5 h 21 min, nothing received, while Tor sat
		// at 30% bootstrapped).
		s.once('close', () => fail(new Error('Tor closed the connection without answering')));
		s.once('connect', () => s.write(socks5Greeting()));
		s.on('data', (chunk: Buffer) => {
			if (done) return;
			acc = Buffer.concat([acc, chunk]);
			if (stage === 'greet') {
				if (acc.length < 2) return;
				const g = parseSocks5Greeting(acc.subarray(0, 2));
				if (!g.ok) return fail(new Error(`Tor SOCKS greeting: ${g.error}`));
				acc = acc.subarray(2);
				stage = 'connect';
				s.write(socks5ConnectRequest(host, port));
				if (acc.length === 0) return;
			}
			if (acc.length < 5) return;
			const atyp = acc[3];
			const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + (acc[4] ?? 0) : 10;
			if (acc[1] !== 0x00)
				return fail(
					new Error(
						`Tor refused ${host}:${port}: ${parseSocks5ConnectReply(acc).error ?? 'refused'}`
					)
				);
			if (acc.length < need) return;
			done = true;
			s.removeAllListeners('data');
			s.removeAllListeners('timeout');
			s.setTimeout(0);
			const rest = acc.subarray(need);
			if (rest.length > 0) s.unshift(rest);
			resolveOpen(s);
		});
	});
}

/**
 * A loopback HTTP proxy that only understands CONNECT, only to `allow`, and
 * opens every tunnel through Tor's SOCKS port by name. Anything else is
 * answered 403 and never dialled.
 */
export async function startTorRegistryBridge(opts: {
	readonly socksHost: string;
	readonly socksPort: number;
	readonly allow?: readonly string[];
	/** The clock lastActivity() reads (tests). */
	readonly now?: () => number;
}): Promise<TorBridge> {
	const allow = new Set((opts.allow ?? [NPM_REGISTRY_AUTHORITY]).map((a) => a.toLowerCase()));
	const asked: string[] = [];
	const now = opts.now ?? Date.now;
	let received = 0;
	let last = now();
	const server: Server = createServer((_req, res) => {
		res.writeHead(403, { 'content-type': 'text/plain' });
		res.end('only CONNECT to the npm registry is relayed\n');
	});
	const sockets = new Set<Socket>();
	server.on('connect', (req, client: Socket, head: Buffer) => {
		const target = String(req.url ?? '').toLowerCase();
		asked.push(target);
		sockets.add(client);
		client.on('close', () => sockets.delete(client));
		client.on('error', () => client.destroy());
		const m = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target);
		if (!allow.has(target) || m === null) {
			client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
			return;
		}
		last = now();
		socksOpen(opts.socksHost, opts.socksPort, m[1]!, Number(m[2]))
			.then((upstream) => {
				last = now();
				sockets.add(upstream);
				upstream.on('data', (d: Buffer) => {
					received += d.length;
					last = now();
				});
				client.on('data', () => {
					last = now();
				});
				upstream.on('close', () => sockets.delete(upstream));
				upstream.on('error', () => client.destroy());
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				if (head.length > 0) upstream.write(head);
				upstream.pipe(client);
				client.pipe(upstream);
			})
			.catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const addr = server.address();
	const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
	return {
		port,
		asked,
		received: () => received,
		lastActivity: () => last,
		close: () =>
			new Promise<void>((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			})
	};
}

/** Is a SOCKS5 server answering at host:port? (A greeting round-trip.) */
export async function socksAnswers(
	host: string,
	port: number,
	timeoutMs = 5_000
): Promise<boolean> {
	return new Promise((r) => {
		const s = netConnect({ host, port });
		const end = (v: boolean): void => {
			s.destroy();
			r(v);
		};
		s.setTimeout(timeoutMs, () => end(false));
		s.once('error', () => end(false));
		s.once('connect', () => s.write(socks5Greeting()));
		s.once('data', (d: Buffer) => end(d.length >= 2 && parseSocks5Greeting(d.subarray(0, 2)).ok));
	});
}

export type HiddenDepsOutcome =
	| {
			readonly ok: true;
			readonly strategy: 'carried-forward' | 'updated-over-tor' | 'npm-over-tor';
			readonly detail: string;
	  }
	| { readonly ok: false; readonly reason: string };

/** No byte through Tor for this long while npm runs: npm is stopped. npm's own
 *  request limit is 5 minutes with retries; this is past that, and a download
 *  that is slow but moving never trips it. */
export const TOR_NPM_STALL_MS = 10 * 60_000;

/** What runNpm is given besides its arguments and environment. */
export interface TorNpmRun {
	/** The spinner's text, read on every frame (what is fetched, MB so far). */
	readonly label: () => string;
	/** Aborted when the stall watch gives up: the step stops npm. */
	readonly signal: AbortSignal;
}

/** Plain-words megabytes for the spinner. PURE. */
export function megabytes(bytes: number): string {
	return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/**
 * Steps 2–4 of the header, for a hidden-only node whose release has no
 * prebuilt node_modules. `runNpm` runs `npm <args>` in installDir with `env`
 * and resolves to its exit code, and stops npm when `run.signal` aborts;
 * `copyTree` copies a directory with its links. Nothing here opens a
 * connection except through `socks`.
 *
 * Step 3 first tries the UPDATE: the previous node_modules are copied in and
 * `npm install` (no scripts, no lockfile writes) fetches only the packages the
 * lockfile changed — v1.21.19 changed 5 of 821 packages, and the full `npm ci`
 * it ran instead fetched all of them through Tor (morphitlat, 2026-10-31: still
 * downloading after two hours). The result is checked like any other: the
 * lockfile untouched, the tree matching it. Only then the full `npm ci`.
 * While npm runs, a watch stops it once nothing has come through Tor for
 * `stallMs` (TOR_NPM_STALL_MS), so a dead route ends in a rollback with a
 * reason, never a spinner without end.
 */
export async function installDepsForHiddenNode(deps: {
	readonly installDir: string;
	readonly previousDir: string;
	readonly socks: { readonly host: string; readonly port: number };
	readonly runNpm: (
		args: readonly string[],
		env: NodeJS.ProcessEnv,
		run: TorNpmRun
	) => Promise<number>;
	readonly copyTree: (from: string, to: string) => Promise<boolean>;
	readonly info: (m: string) => void;
	readonly env?: NodeJS.ProcessEnv;
	/** The stall watch's limits and clock (tests drive them). */
	readonly watch?: {
		readonly stallMs?: number;
		readonly everyMs?: number;
		readonly now?: () => number;
		readonly every?: (fn: () => void, ms: number) => () => void;
	};
}): Promise<HiddenDepsOutcome> {
	const read = (d: string): string | null => {
		try {
			return readFileSync(join(d, 'package-lock.json'), 'utf8');
		} catch {
			return null;
		}
	};
	const newLock = read(deps.installDir);
	if (newLock === null)
		return { ok: false, reason: 'the release has no readable package-lock.json' };
	const oldLock = read(deps.previousDir);
	const want = dependencyFingerprint(newLock);

	// 2. Carry forward.
	if (oldLock !== null && want !== null && dependencyFingerprint(oldLock) === want) {
		deps.info(
			'This release uses exactly the same dependencies as the installed one; reusing them (nothing is downloaded).'
		);
		let copied = true;
		for (const rel of nodeModulesDirs(newLock)) {
			const from = join(deps.previousDir, rel);
			if (!existsSync(from)) continue;
			if (!(await deps.copyTree(from, join(deps.installDir, rel)))) copied = false;
		}
		const problems = copied
			? lockedTreeProblems(deps.installDir, newLock)
			: ['the copy did not complete'];
		if (problems.length === 0) {
			return {
				ok: true,
				strategy: 'carried-forward',
				detail: 'dependencies reused from the previous install'
			};
		}
		deps.info(
			`The reused dependencies do not match this release's lockfile (${problems.slice(0, 3).join('; ')}); trying over Tor.`
		);
	}

	// 3. Over Tor, registry only.
	if (!(await socksAnswers(deps.socks.host, deps.socks.port))) {
		return {
			ok: false,
			reason:
				`this release changes dependencies, and Tor's SOCKS port (${deps.socks.host}:${deps.socks.port}) did not answer, ` +
				'so they cannot be fetched privately. Nothing was fetched over the clearnet'
		};
	}
	const stallMs = deps.watch?.stallMs ?? TOR_NPM_STALL_MS;
	const now = deps.watch?.now ?? Date.now;
	const every =
		deps.watch?.every ??
		((fn: () => void, ms: number): (() => void) => {
			const t = setInterval(fn, ms);
			return () => clearInterval(t);
		});
	const bridge = await startTorRegistryBridge({
		socksHost: deps.socks.host,
		socksPort: deps.socks.port,
		now
	});
	const env = torNpmEnv(deps.env ?? process.env, bridge.port);
	const stallWords = `nothing came through Tor for ${Math.round(stallMs / 60_000)} minutes, so npm was stopped`;
	/** One npm run under the stall watch: its exit code, and whether the
	 *  watch stopped it. */
	const watched = async (
		args: readonly string[],
		what: string
	): Promise<{ code: number; stalled: boolean }> => {
		const ctl = new AbortController();
		let stalled = false;
		const startBytes = bridge.received();
		const stop = every(() => {
			if (!stalled && now() - bridge.lastActivity() >= stallMs) {
				stalled = true;
				ctl.abort();
			}
		}, deps.watch?.everyMs ?? 5_000);
		try {
			const code = await deps.runNpm(args, env, {
				label: () => `${what} — ${megabytes(bridge.received() - startBytes)} received so far…`,
				signal: ctl.signal
			});
			// npm that finished as the watch fired is done: its tree is checked.
			return { code, stalled: stalled && code !== 0 };
		} finally {
			stop();
		}
	};
	const lockUntouched = (): boolean => read(deps.installDir) === newLock;
	const natives = (): string => {
		const n = carryNativeAddons(deps.previousDir, deps.installDir, newLock);
		return n.length > 0 ? `; native add-ons reused for ${n.join(', ')}` : '';
	};
	try {
		deps.info(
			'This release changes dependencies; fetching them from the npm registry through Tor (no clearnet).'
		);
		// 3a. The update: the previous tree, plus only what the lockfile changed.
		const previous = nodeModulesDirs(newLock).filter((rel) =>
			existsSync(join(deps.previousDir, rel))
		);
		if (previous.length > 0) {
			let copied = true;
			for (const rel of previous) {
				// Step 2 may have copied it already (and found it did not match):
				// `cp -a` onto an existing folder would nest a second one inside.
				const to = join(deps.installDir, rel);
				if (existsSync(to)) continue;
				if (!(await deps.copyTree(join(deps.previousDir, rel), to))) copied = false;
			}
			if (copied) {
				const r = await watched(
					['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save'],
					'Fetching only the changed dependencies through Tor'
				);
				if (r.stalled) return { ok: false, reason: stallWords };
				const problems = r.code === 0 ? lockedTreeProblems(deps.installDir, newLock) : [];
				if (r.code === 0 && problems.length === 0 && lockUntouched()) {
					return {
						ok: true,
						strategy: 'updated-over-tor',
						detail:
							'the unchanged dependencies reused, only the changed ones fetched through Tor from registry.npmjs.org' +
							natives()
					};
				}
				deps.info(
					r.code !== 0
						? `Fetching only the changed dependencies did not finish (npm exit ${r.code}); fetching all of them instead.`
						: !lockUntouched()
							? 'npm changed the lockfile while updating; fetching all the dependencies instead.'
							: `The updated dependencies do not match this release's lockfile (${problems.slice(0, 3).join('; ')}); fetching all of them instead.`
				);
				if (!lockUntouched()) {
					try {
						writeFileSync(join(deps.installDir, 'package-lock.json'), newLock);
					} catch {
						return { ok: false, reason: "the release's package-lock.json could not be put back" };
					}
				}
			}
		}
		// 3b. Everything, from the lockfile.
		const r = await watched(
			['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
			'Installing dependencies through Tor'
		);
		if (r.stalled) return { ok: false, reason: stallWords };
		const problems = lockedTreeProblems(deps.installDir, newLock);
		if (r.code === 0 && problems.length === 0) {
			return {
				ok: true,
				strategy: 'npm-over-tor',
				detail: 'fetched through Tor from registry.npmjs.org' + natives()
			};
		}
		return {
			ok: false,
			reason:
				r.code !== 0
					? `fetching the changed dependencies through Tor did not finish (npm exit ${r.code})`
					: `the dependencies fetched through Tor do not match the lockfile (${problems.slice(0, 3).join('; ')})`
		};
	} finally {
		await bridge.close();
	}
}
