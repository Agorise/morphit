/**
 * Installed-box heal: the indexer and relay reach all 14 public hidden Blurt
 * RPC nodes, not the 4 an Ansible install used to write.
 *
 * WHY. group_vars seeded MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS and
 * MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS with two operators' nodes (Star and Jade,
 * each .onion + .b32.i2p) while the code knows seven. An explicit value
 * replaces the built-in list, so every Ansible node — and a zero-clearnet
 * node depends on these alone — read the chain and counted its quorum over two
 * operators.
 *
 * WHAT, on this server, in every env file the services source:
 *  - a value that is exactly that old seed (in any order, or the .onion /
 *    .b32.i2p half of it, as a box with one transport got) is replaced by the
 *    full list for the same transports, in the code's order;
 *  - anything else is the operator's choice: kept (an empty value means
 *    "no hidden RPC"), and said so;
 * then the changed services restart, and VERIFY: the running process has the
 * new list (its environment), and its local health answer counts that many
 * more RPC endpoints than before. FALLBACK: a second restart. Otherwise a calm
 * line with the file and the command for this server.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

/** What earlier Ansible installs wrote (group_vars morphit_hidden_rpc_seed_*). */
export const OLD_HIDDEN_SEED = [
	'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091',
	'http://axj4qkjwk3bwh2lrn4bud5rrgsyrvuamd6jxdlmks6flsrju7q5rb5yd.onion:8091',
	'http://zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p:8091',
	'http://7tea4n3co3q2ozke2ovgqn7j5zirkauxipfttudbhthkat6fzlcq.b32.i2p:8091'
] as const;

const isOnion = (u: string): boolean => /\.onion(:\d+)?\/?$/.test(u);
const isI2p = (u: string): boolean => /\.b32\.i2p(:\d+)?\/?$/.test(u);

/** The full list to put in place of `value`, or null when `value` is not the
 *  old seed (or one transport's half of it). PURE. */
export function replacementFor(value: string): string[] | null {
	const got = value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (got.length === 0 || new Set(got).size !== got.length) return null;
	const old = new Set<string>(OLD_HIDDEN_SEED);
	if (!got.every((u) => old.has(u))) return null;
	const onion = got.some(isOnion);
	const i2p = got.some(isI2p);
	const want = OLD_HIDDEN_SEED.filter((u) => (onion && isOnion(u)) || (i2p && isI2p(u)));
	if (got.length !== want.length) return null; // a hand-picked part of it: the operator's
	return DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter(
		(u) => (onion && isOnion(u)) || (i2p && isI2p(u))
	);
}

/** The text with every line setting `key` to the old seed rewritten. PURE. */
export function rewriteHidden(
	text: string,
	key: string
): { text: string; to: string[] | null; kept: string | null } {
	let to: string[] | null = null;
	let kept: string | null = null;
	const re = new RegExp(`^([ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*)(.*?)[ \\t]*$`, 'gm');
	const out = text.replace(re, (line, prefix: string, raw: string) => {
		const q = /^(["'])(.*)\1$/.exec(raw);
		const value = q ? q[2]! : raw;
		const r = replacementFor(value);
		if (r === null) {
			kept = value;
			return line;
		}
		to = r;
		return `${prefix}${q ? q[1] : ''}${r.join(',')}${q ? q[1] : ''}`;
	});
	return { text: out, to, kept };
}

export interface ServiceSpec {
	readonly unit: 'morphit-indexer' | 'morphit-relay';
	readonly key: string;
	readonly files: readonly string[];
	/** Local health URL that reports rpc_endpoints_total to a local caller. */
	readonly health: string;
}

export const SERVICES = (root = ''): ServiceSpec[] => [
	{
		unit: 'morphit-indexer',
		key: 'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS',
		files: [
			`${root}/opt/morphit/morphit.env`,
			`${root}/opt/morphit/morphit.config.env`,
			`${root}/etc/morphit/indexer.env`
		],
		health: 'http://127.0.0.1:8081/v1/health'
	},
	{
		unit: 'morphit-relay',
		key: 'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS',
		files: [
			`${root}/opt/morphit/morphit.env`,
			`${root}/opt/morphit/morphit.config.env`,
			`${root}/etc/morphit/relay.env`,
			`${root}/etc/morphit/relay-vapid.env`
		],
		health: 'http://127.0.0.1:8080/v1/health'
	}
];

export interface HiddenRpcRuntime {
	readFile(path: string): string | null;
	writeFile(path: string, text: string): boolean;
	active(unit: string): boolean;
	restart(unit: string): boolean;
	/** The running service's value of `key`; null if unreadable or unset. */
	processEnv(unit: string, key: string): string | null;
	/** rpc_endpoints_total from the local health answer (asked with
	 *  X-Morphit-Local-Health: 1); null if it did not answer. */
	rpcTotal(url: string): number | null;
	sleep(ms: number): Promise<void>;
}

export async function healHiddenRpc(
	ctx: HealCtx,
	opts: { runtime?: HiddenRpcRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const lines: string[] = [];
	let verified = true;
	let strategy = 'already';
	for (const svc of SERVICES(opts.root ?? '')) {
		let to: string[] | null = null;
		const changed: string[] = [];
		const kept: string[] = [];
		for (const f of svc.files) {
			const text = rt.readFile(f);
			if (text === null) continue;
			const r = rewriteHidden(text, svc.key);
			if (r.kept !== null)
				kept.push(
					`${f} (${r.kept === '' ? 'empty: no hidden RPC' : `${r.kept.split(',').length} of your own`})`
				);
			if (r.to === null) continue;
			if (!rt.writeFile(f, r.text) || rewriteHidden(rt.readFile(f) ?? '', svc.key).to !== null) {
				verified = false;
				lines.push(
					`${svc.unit}: could not update ${f}; on this server remove its ${svc.key} line (the built-in list is all 14 nodes), then run: sudo systemctl restart ${svc.unit}`
				);
				continue;
			}
			to = r.to;
			changed.push(f);
		}
		if (to === null) {
			if (kept.length > 0)
				lines.push(
					`${svc.unit}: ${svc.key} is your own setting in ${kept.join(', ')} — left as it is`
				);
			continue;
		}
		strategy = 'rewritten';
		if (!rt.active(svc.unit)) {
			lines.push(
				`${svc.unit}: ${to.length} hidden RPC nodes written to ${changed.join(', ')} (read back); it is not running here`
			);
			continue;
		}
		const before = rt.rpcTotal(svc.health);
		const restartAndSee = async (label: string): Promise<boolean> => {
			const stop = ctx.spinner(label);
			try {
				rt.restart(svc.unit);
				for (let i = 0; i < 20; i++) {
					await rt.sleep(1_500);
					if (rt.processEnv(svc.unit, svc.key) === to!.join(',')) return true;
				}
				return false;
			} finally {
				stop();
			}
		};
		let seen = await restartAndSee(
			`Restarting ${svc.unit} with all ${to.length} hidden RPC nodes…`
		);
		if (!seen) {
			strategy = 'second-restart';
			seen = await restartAndSee(
				`${svc.unit} does not show the new list yet; restarting it once more…`
			);
		}
		if (!seen) {
			verified = false;
			lines.push(
				`${svc.unit}: ${svc.key} now lists ${to.length} nodes in ${changed.join(', ')}, but the running service does not show it; on this server run: sudo systemctl restart ${svc.unit}`
			);
			continue;
		}
		let after: number | null = null;
		for (let i = 0; i < 10 && after === null; i++) {
			after = rt.rpcTotal(svc.health);
			if (after === null) await rt.sleep(2_000);
		}
		const grew = before !== null && after !== null ? after - before : null;
		lines.push(
			`${svc.unit}: now uses ${to.length} hidden RPC nodes (was ${OLD_HIDDEN_SEED.filter((u) => to!.includes(u)).length}), seen in the running service` +
				(grew !== null ? ` and in its health answer (${before} → ${after} RPC endpoints)` : '')
		);
	}
	return {
		strategy,
		verified,
		detail:
			lines.length > 0
				? `Hidden RPC nodes: ${lines.join('; ')}.`
				: 'Hidden RPC nodes: nothing on this server sets the old list.'
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healHiddenRpc(ctx);
}

const sh = (cmd: string, args: string[], timeout = 20_000): { ok: boolean; out: string } => {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
		return { ok: r.status === 0, out: r.stdout ?? '' };
	} catch {
		return { ok: false, out: '' };
	}
};

const realRuntime: HiddenRpcRuntime = {
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
	active: (u) => sh('systemctl', ['is-active', '--quiet', u]).ok,
	restart: (u) => sh('systemctl', ['restart', u], 120_000).ok,
	processEnv: (u, key) => {
		const pid = sh('systemctl', ['show', '-p', 'MainPID', '--value', u]).out.trim();
		if (!/^[1-9]\d*$/.test(pid)) return null;
		try {
			const hit = readFileSync(`/proc/${pid}/environ`, 'utf8')
				.split('\0')
				.find((e) => e.startsWith(`${key}=`));
			return hit === undefined ? null : hit.slice(key.length + 1);
		} catch {
			return null;
		}
	},
	rpcTotal: (url) => {
		const r = sh('curl', [
			'-s',
			'-m',
			'8',
			'--noproxy',
			'*',
			'-H',
			'X-Morphit-Local-Health: 1',
			url
		]);
		try {
			const n = (JSON.parse(r.out) as { rpc_endpoints_total?: unknown }).rpc_endpoints_total;
			return typeof n === 'number' ? n : null;
		} catch {
			return null;
		}
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
