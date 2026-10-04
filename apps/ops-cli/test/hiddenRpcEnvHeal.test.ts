/**
 * The hidden-RPC heal against a simulated box: services read their env files
 * at start (last file wins), and their local health counts clearnet + hidden
 * RPC endpoints.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import {
	OLD_HIDDEN_SEED,
	SERVICES,
	healHiddenRpc,
	replacementFor,
	type HiddenRpcRuntime
} from '../src/lib/hiddenRpcEnvHeal.ts';

const IDX = '/etc/morphit/indexer.env';
const REL = '/etc/morphit/relay.env';
const onion = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) => u.includes('.onion'));

class Box {
	files = new Map<string, string>([
		[
			IDX,
			`MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=${OLD_HIDDEN_SEED.join(',')}\n`
		],
		[
			REL,
			`MORPHIT_RELAY_BLURT_RPC=\nMORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS=${OLD_HIDDEN_SEED.join(',')}\n`
		]
	]);
	env = new Map<string, string | null>();
	restarts: string[] = [];
	sticky = 0;
	writable = true;
	constructor() {
		for (const s of SERVICES()) this.start(s.unit);
	}
	start(unit: string): void {
		const s = SERVICES().find((x) => x.unit === unit)!;
		let v: string | null = null;
		for (const f of s.files)
			for (const m of (this.files.get(f) ?? '').matchAll(new RegExp(`^${s.key}=(.*)$`, 'gm')))
				v = m[1]!;
		this.env.set(unit, v);
	}
	readonly rt: HiddenRpcRuntime = {
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.writable ? (this.files.set(p, t), true) : false),
		active: () => true,
		restart: (u) => {
			this.restarts.push(u);
			if (this.sticky > 0) this.sticky--;
			else this.start(u);
			return true;
		},
		processEnv: (u) => this.env.get(u) ?? null,
		rpcTotal: (url) => {
			const unit = url.includes(':8081') ? 'morphit-indexer' : 'morphit-relay';
			return (this.env.get(unit) ?? '').split(',').filter(Boolean).length;
		},
		sleep: async () => {}
	};
	run() {
		return healHiddenRpc(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe('installed nodes reach all 14 hidden RPC nodes (hidden RPC heal)', () => {
	it('an Ansible node as installed knows 4 — the case the heal is for', () => {
		expect(new Box().rt.rpcTotal('http://127.0.0.1:8081/v1/health')).toBe(4);
	});

	it('both services: the old seed becomes the 14 in the code order, restarted, seen running and in health', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'rewritten', verified: true });
		expect(b.env.get('morphit-indexer')).toBe(DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.join(','));
		expect(b.env.get('morphit-relay')).toBe(DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.join(','));
		expect(b.files.get(IDX)).toMatch(/^MORPHIT_INDEXER_RPC_ENDPOINTS=\n/);
		expect(out.detail).toContain('4 → 14');
		expect((await b.run()).strategy).toBe('already');
		expect(b.restarts).toEqual(['morphit-indexer', 'morphit-relay']);
	});

	it('a Tor-only seed half (no i2pd on the box) becomes the 7 .onion nodes, not the .b32.i2p ones', () => {
		expect(replacementFor(OLD_HIDDEN_SEED.slice(0, 2).join(','))).toEqual(onion);
		expect(replacementFor(`"${OLD_HIDDEN_SEED.join(',')}"`)).toBeNull(); // quotes handled by the caller
		expect(replacementFor([...OLD_HIDDEN_SEED].reverse().join(','))).toEqual([
			...DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
		]);
	});

	it("an operator's own list, a hand-picked part of the seed, or an empty value is kept, and said so", async () => {
		expect(
			replacementFor(`${OLD_HIDDEN_SEED[0]},${OLD_HIDDEN_SEED[2]},http://x.onion:8091`)
		).toBeNull();
		expect(replacementFor(OLD_HIDDEN_SEED[0]!)).toBeNull();
		const b = new Box();
		b.files.set(IDX, 'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=\n');
		const out = await b.run();
		expect(b.files.get(IDX)).toBe('MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=\n');
		expect(out.detail).toMatch(/morphit-indexer: .* your own setting .*empty: no hidden RPC/);
		expect(b.restarts).toEqual(['morphit-relay']);
	});

	it('a restart that did not take: restarted again, then verified; still not: the command given', async () => {
		const a = new Box();
		a.sticky = 1;
		expect((await a.run()).verified).toBe(true);
		const b = new Box();
		b.sticky = 10;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toContain('sudo systemctl restart morphit-indexer');
	});

	it('quoted values keep their quotes', async () => {
		const b = new Box();
		b.files.set(REL, `MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS="${OLD_HIDDEN_SEED.join(',')}"\n`);
		await b.run();
		expect(b.files.get(REL)).toBe(
			`MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS="${DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.join(',')}"\n`
		);
	});
});
