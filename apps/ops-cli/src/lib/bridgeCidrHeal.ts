/**
 * Installed-box heal: the indexer believes the client address the BunkerWeb
 * frontend forwards, on a box whose frontend Docker bridge is not the
 * 172.20.0.0/16 the ansible install pins.
 *
 * WHY. The indexer's per-address limits used to trust X-Forwarded-For from
 * all of 172.16.0.0/12, so any container on any Docker network of the box
 * could make up client addresses. The default is now loopback plus
 * 172.20.0.0/16 only. A hand-made stack (morphit.io: 172.18.0.0/24) would then
 * see its frontend as an untrusted private proxy: nothing breaks, but every
 * visitor shares one bucket (with the larger shared ceiling) and the indexer
 * logs `untrusted_private_proxy` once.
 *
 * WHAT, on this server:
 *  1. find the frontend container (the one serving apps/web/build) and the
 *     Docker network it reaches the host through (the one whose gateway is
 *     its host.docker.internal, else its only network), and read that
 *     network's subnet from Docker;
 *  2. covered already (inside the default 172.20.0.0/16, or by the value an
 *     operator set) → nothing to do; an operator's value that does NOT cover
 *     it is left alone and the line to add is given;
 *  3. otherwise append
 *       MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128,<subnet>
 *     to the indexer's own env file (owner and mode kept) and restart it;
 *  4. VERIFY: the running indexer process has the value (its environment),
 *     and after a request through the frontend's loopback port its log since
 *     the restart has no `untrusted_private_proxy` line.
 * Boxes without a frontend container (bare-metal nginx on loopback, which is
 * always trusted) are left alone.
 */
import { dockerStatus, type DockerStatus } from './dockerStatus.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

export const TRUSTED_KEY = 'MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS';
export const DEFAULT_TRUSTED = ['127.0.0.0/8', '::1/128', '172.20.0.0/16'] as const;

/** The env files the indexer unit sources, in its order (last one wins). */
export function indexerEnvFiles(root = ''): string[] {
	return [
		`${root}/opt/morphit/morphit.env`,
		`${root}/opt/morphit/morphit.config.env`,
		`${root}/etc/morphit/indexer.env`
	];
}

const v4 = (ip: string): number | null => {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return null;
	const o = m.slice(1).map(Number);
	return o.some((x) => x > 255)
		? null
		: ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
};
const range = (cidr: string): [number, number] | null => {
	const [ip, bits = '32'] = cidr.trim().split('/');
	const base = v4(ip ?? '');
	const n = Number(bits);
	if (base === null || !Number.isInteger(n) || n < 0 || n > 32) return null;
	const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
	const lo = (base & mask) >>> 0;
	return [lo, (lo | (~mask >>> 0)) >>> 0];
};

/** Is IPv4 `subnet` inside one of `list`? PURE. */
export function coveredBy(subnet: string, list: readonly string[]): boolean {
	const s = range(subnet);
	if (s === null) return false;
	return list.some((c) => {
		const r = range(c);
		return r !== null && r[0] <= s[0] && s[1] <= r[1];
	});
}

/** The value of `key` the files set (last file, last line wins). PURE. */
export function envSetting(texts: readonly string[], key: string): string | null {
	let v: string | null = null;
	const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'gm');
	for (const t of texts)
		for (const m of t.matchAll(re)) v = (m[1] ?? '').replace(/^(["'])(.*)\1$/, '$2');
	return v;
}

export interface BridgeRuntime {
	/** Docker's state when frontendSubnet() answered null (absent: assumed up). */
	docker?(): DockerStatus;
	/** The frontend's host-facing Docker network: its subnet; null when there
	 *  is no frontend container (or Docker cannot be asked); '' when a frontend
	 *  container runs but its host-facing network could not be read. */
	frontendSubnet(): string | null;
	readFile(path: string): string | null;
	writeFile(path: string, text: string): boolean;
	indexerActive(): boolean;
	restartIndexer(): boolean;
	/** The running indexer process's value of `key`; null if unreadable. */
	indexerEnv(key: string): string | null;
	/** One request through the frontend's loopback port to an indexer path
	 *  that keys its limits on the client address; true if it answered. */
	requestThroughFrontend(): boolean;
	/** The indexer's log since `sinceMs`. */
	indexerLogSince(sinceMs: number): string;
	now(): number;
	sleep(ms: number): Promise<void>;
}

export async function healTrustedBridge(
	ctx: HealCtx,
	opts: { runtime?: BridgeRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	let stop = ctx.spinner("Reading the frontend's Docker network…");
	let subnet: string | null;
	try {
		subnet = rt.frontendSubnet();
	} finally {
		stop();
	}
	if (subnet === '')
		return {
			strategy: 'left-alone',
			verified: false,
			detail:
				"Indexer trusted proxies: the frontend container runs, but its host-facing Docker network could not be read, so the indexer's trusted proxies were left as they are; on this server check: sudo docker network ls and sudo docker inspect on the frontend container"
		};
	if (subnet === null) {
		const st = rt.docker?.() ?? 'up';
		if (st === 'down')
			return {
				strategy: 'docker-unavailable',
				verified: false,
				detail:
					"Indexer trusted proxies: Docker did not answer, so the frontend's network could not be read; on this server check: sudo systemctl status docker"
			};
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail:
				st === 'missing'
					? 'Indexer trusted proxies: no Docker on this server (a proxy on loopback is always trusted).'
					: 'Indexer trusted proxies: no frontend container on this server (a proxy on loopback is always trusted).'
		};
	}
	if (range(subnet) === null)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Indexer trusted proxies: the frontend's network is ${subnet}, which this check does not handle; if visitors share one rate-limit bucket, on this server add ${TRUSTED_KEY}=127.0.0.0/8,::1/128,${subnet} to /etc/morphit/indexer.env and restart morphit-indexer.`
		};
	const files = indexerEnvFiles(opts.root ?? '');
	const texts = files.map((f) => rt.readFile(f));
	const current = envSetting(
		texts.map((t) => t ?? ''),
		TRUSTED_KEY
	);
	const list =
		current === null || current.trim() === '' ? [...DEFAULT_TRUSTED] : current.split(',');
	if (coveredBy(subnet, list))
		return {
			strategy: 'already',
			verified: true,
			routine: true,
			detail: `Indexer trusted proxies: the frontend's network ${subnet} is already trusted${current ? ` (${TRUSTED_KEY})` : ' (the default)'}.`
		};
	const line = `${TRUSTED_KEY}=127.0.0.0/8,::1/128,${subnet}`;
	if (current !== null && current.trim() !== '')
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Indexer trusted proxies: your ${TRUSTED_KEY}=${current} does not include the frontend's network ${subnet}, so every visitor shares one rate-limit bucket. Left as you set it; to fix, on this server add ${subnet} to that line and run: sudo systemctl restart morphit-indexer`
		};
	// The indexer's own file when it has one (Ansible), else the shared one (morphit-ops init).
	const target = texts[2] !== null ? files[2]! : texts[0] !== null ? files[0]! : files[2]!;
	const before = rt.readFile(target) ?? '';
	const next = `${before.replace(/\n*$/, before === '' ? '' : '\n')}# The BunkerWeb frontend's Docker bridge (written by morphit-ops upgrade).\n${line}\n`;
	if (
		!rt.writeFile(target, next) ||
		envSetting([rt.readFile(target) ?? ''], TRUSTED_KEY) !== line.split('=')[1]
	)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Indexer trusted proxies: could not write ${target}; on this server add the line ${line} and run: sudo systemctl restart morphit-indexer`
		};
	if (!rt.indexerActive())
		return {
			strategy: 'env-only',
			verified: true,
			detail: `Indexer trusted proxies: ${line} written to ${target} (read back); the indexer is not running here, so it takes effect when it starts.`
		};
	const t0 = rt.now();
	stop = ctx.spinner("Restarting the indexer so it trusts the frontend's network…");
	let running = false;
	try {
		rt.restartIndexer();
		for (let i = 0; i < 20 && !running; i++) {
			await rt.sleep(1_500);
			running = rt.indexerEnv(TRUSTED_KEY) !== null;
		}
	} finally {
		stop();
	}
	const seenValue = rt.indexerEnv(TRUSTED_KEY);
	if (seenValue === null || !coveredBy(subnet, seenValue.split(',')))
		return {
			strategy: 'env-written',
			verified: false,
			detail: `Indexer trusted proxies: ${line} is in ${target}, but the running indexer does not show it yet; on this server run: sudo systemctl restart morphit-indexer`
		};
	stop = ctx.spinner('Sending one request through the frontend to check it…');
	let asked: boolean;
	let warned: boolean;
	try {
		asked = rt.requestThroughFrontend();
		if (asked) await rt.sleep(1_000);
		warned = asked && /untrusted_private_proxy/.test(rt.indexerLogSince(t0));
	} finally {
		stop();
	}
	return {
		strategy: 'env-written',
		verified: !warned,
		detail: warned
			? `Indexer trusted proxies: ${line} is in effect, but the indexer still reports an untrusted proxy after a request through the frontend — the frontend may reach it through another network; on this server compare \`docker network inspect\` of the frontend's networks with ${target}.`
			: `Indexer trusted proxies: ${line} written to ${target}, seen in the running indexer` +
				(asked
					? ', and a request through the frontend raised no untrusted-proxy warning.'
					: ' (the frontend port did not answer, so no request was sent through it).')
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healTrustedBridge(ctx);
}

const sh = (cmd: string, args: string[], timeout = 20_000): { ok: boolean; out: string } => {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
		return { ok: r.status === 0, out: r.stdout ?? '' };
	} catch {
		return { ok: false, out: '' };
	}
};

interface Inspect {
	Mounts?: Array<{ Source?: string; Destination?: string }>;
	HostConfig?: { ExtraHosts?: string[] | null };
	NetworkSettings?: { Networks?: Record<string, unknown> };
}

const realRuntime: BridgeRuntime = {
	docker: () => dockerStatus(),
	frontendSubnet: () => {
		const ids = sh('docker', ['ps', '-q']);
		if (!ids.ok || ids.out.trim() === '') return null;
		const insp = sh('docker', ['inspect', ...ids.out.trim().split(/\s+/)]);
		if (!insp.ok) return '';
		let list: Inspect[];
		try {
			list = JSON.parse(insp.out) as Inspect[];
		} catch {
			return '';
		}
		const fe = list.find((c) =>
			(c.Mounts ?? []).some((m) => /\/apps\/web\/build\/?$/.test(m.Source ?? ''))
		);
		if (!fe) return null;
		const nets = Object.keys(fe.NetworkSettings?.Networks ?? {});
		const gw = (fe.HostConfig?.ExtraHosts ?? [])
			.map((h) => /^host\.docker\.internal:(.+)$/.exec(h)?.[1])
			.find(Boolean);
		for (const n of nets) {
			const r = sh('docker', [
				'network',
				'inspect',
				n,
				'-f',
				'{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}};{{end}}'
			]);
			if (!r.ok) continue;
			const pairs = r.out
				.trim()
				.split(';')
				.map((p) => p.trim().split(' '))
				.filter((p) => p[0] && range(p[0]) !== null);
			const hit =
				pairs.find((p) => gw !== undefined && p[1] === gw) ??
				(nets.length === 1 ? pairs[0] : undefined);
			if (hit) return hit[0]!;
		}
		// The frontend is there, but which of its networks faces the host could
		// not be told.
		return '';
	},
	readFile: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	writeFile: (p, text) => {
		const tmp = `${p}.morphit-tmp`;
		try {
			writeFileSync(tmp, text, { mode: 0o640 });
			keepOwnerAndMode(p, tmp);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	indexerActive: () => sh('systemctl', ['is-active', '--quiet', 'morphit-indexer']).ok,
	restartIndexer: () => sh('systemctl', ['restart', 'morphit-indexer'], 120_000).ok,
	indexerEnv: (key) => {
		const pid = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'morphit-indexer']).out.trim();
		if (!/^[1-9]\d*$/.test(pid)) return null;
		try {
			const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
			const hit = env.find((e) => e.startsWith(`${key}=`));
			return hit === undefined ? null : hit.slice(key.length + 1);
		} catch {
			return null;
		}
	},
	requestThroughFrontend: () =>
		sh('curl', [
			'-s',
			'-o',
			'/dev/null',
			'-m',
			'8',
			'--noproxy',
			'*',
			'-w',
			'%{http_code}',
			'http://127.0.0.1:8090/v1/orderbook'
		]).out.trim() !== '000',
	indexerLogSince: (sinceMs) =>
		sh('journalctl', [
			'-u',
			'morphit-indexer',
			'--since',
			`@${Math.floor(sinceMs / 1000)}`,
			'--no-pager',
			'-o',
			'cat'
		]).out,
	now: () => Date.now(),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
