/**
 * The trusted-bridge heal against a simulated box: Docker reports the
 * frontend's network, the indexer reads its env files at start (last wins)
 * and, like the real middleware, logs `untrusted_private_proxy` when a
 * request reaches it from a private peer outside the trusted list.
 */
import { describe, expect, it } from 'vitest';
import {
	coveredBy,
	envSetting,
	healTrustedBridge,
	indexerEnvFiles,
	TRUSTED_KEY,
	type BridgeRuntime
} from '../src/lib/bridgeCidrHeal.ts';

const [MORPHIT_ENV, , INDEXER_ENV] = indexerEnvFiles();

class Box {
	subnet: string | null = '172.18.0.0/24';
	files = new Map<string, string>([[INDEXER_ENV!, 'MORPHIT_INDEXER_LISTEN_PORT=8081\n']]);
	active = true;
	restarts = 0;
	/** The value the indexer process started with (null: not set → default). */
	started: string | null = null;
	/** The frontend really reaches the indexer from this address. */
	peer = '172.18.0.5';
	log: Array<{ t: number; line: string }> = [];
	t = 1_000;
	writable = true;
	trusted(): string[] {
		return this.started ? this.started.split(',') : ['127.0.0.0/8', '::1/128', '172.20.0.0/16'];
	}
	readonly rt: BridgeRuntime = {
		frontendSubnet: () => this.subnet,
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.writable ? (this.files.set(p, t), true) : false),
		indexerActive: () => this.active,
		restartIndexer: () => {
			this.restarts++;
			this.started = envSetting(
				indexerEnvFiles().map((f) => this.files.get(f) ?? ''),
				TRUSTED_KEY
			);
			return true;
		},
		indexerEnv: (k) => (k === TRUSTED_KEY ? this.started : null),
		requestThroughFrontend: () => {
			if (!coveredBy(`${this.peer}/32`, this.trusted()))
				this.log.push({ t: this.t, line: 'warn untrusted_private_proxy' });
			return true;
		},
		indexerLogSince: (since) =>
			this.log
				.filter((l) => l.t >= since)
				.map((l) => l.line)
				.join('\n'),
		now: () => this.t,
		sleep: async (ms) => void (this.t += ms)
	};
	run() {
		return healTrustedBridge(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe("the indexer trusts the frontend's own Docker bridge (trusted proxies)", () => {
	it('a hand-made stack on 172.18.0.0/24: as installed, the frontend is an untrusted proxy — the case the heal is for', () => {
		const b = new Box();
		b.rt.requestThroughFrontend();
		expect(b.log.map((l) => l.line)).toContain('warn untrusted_private_proxy');
	});

	it('writes loopback + the bridge, restarts, sees it in the running indexer, and no warning after a request', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'env-written', verified: true });
		expect(b.files.get(INDEXER_ENV!)).toMatch(
			/\nMORPHIT_INDEXER_TRUSTED_PROXY_CIDRS=127\.0\.0\.0\/8,::1\/128,172\.18\.0\.0\/24\n$/
		);
		expect(b.files.get(INDEXER_ENV!)).toMatch(/^MORPHIT_INDEXER_LISTEN_PORT=8081\n/);
		expect(b.restarts).toBe(1);
		expect((await b.run()).strategy).toBe('already');
		expect(b.restarts).toBe(1);
	});

	it('the ansible bridge (172.20.0.0/16) or no frontend container: nothing written', async () => {
		const a = new Box();
		a.subnet = '172.20.0.0/16';
		expect((await a.run()).strategy).toBe('already');
		const b = new Box();
		b.subnet = null;
		expect((await b.run()).strategy).toBe('skipped');
		expect(a.restarts + b.restarts).toBe(0);
		expect(a.files.get(INDEXER_ENV!)).toBe('MORPHIT_INDEXER_LISTEN_PORT=8081\n');
	});

	it("an operator's value is kept: covering → already; not covering → left alone with the line to add", async () => {
		const a = new Box();
		a.files.set(INDEXER_ENV!, `${TRUSTED_KEY}=127.0.0.0/8,172.16.0.0/12\n`);
		expect((await a.run()).strategy).toBe('already');
		const b = new Box();
		b.files.set(INDEXER_ENV!, `${TRUSTED_KEY}=127.0.0.0/8,10.9.0.0/16\n`);
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'left-alone', verified: false });
		expect(b.files.get(INDEXER_ENV!)).toBe(`${TRUSTED_KEY}=127.0.0.0/8,10.9.0.0/16\n`);
		expect(out.detail).toContain('172.18.0.0/24');
	});

	it('a box set up by morphit-ops init (no /etc/morphit/indexer.env): written to morphit.env', async () => {
		const b = new Box();
		b.files = new Map([[MORPHIT_ENV!, 'MORPHIT_DOMAIN=x.org\n']]);
		expect((await b.run()).verified).toBe(true);
		expect(b.files.get(MORPHIT_ENV!)).toContain(`${TRUSTED_KEY}=127.0.0.0/8,::1/128,172.18.0.0/24`);
	});

	it('the frontend reaches the indexer from another network: the warning is seen, not reported as done', async () => {
		const b = new Box();
		b.peer = '172.19.0.7';
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toMatch(/still reports an untrusted proxy/);
	});

	it('the restarted indexer does not show the value: not reported as done, the command given', async () => {
		const b = new Box();
		b.rt.restartIndexer = () => true; // a restart that did not take
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toContain('sudo systemctl restart morphit-indexer');
	});

	it('CIDR containment', () => {
		expect(coveredBy('172.18.0.0/24', ['172.16.0.0/12'])).toBe(true);
		expect(coveredBy('172.18.0.0/24', ['172.20.0.0/16'])).toBe(false);
		expect(coveredBy('172.20.3.0/24', ['127.0.0.0/8', '::1/128', '172.20.0.0/16'])).toBe(true);
		expect(coveredBy('10.0.0.0/8', ['10.0.0.0/16'])).toBe(false);
	});
});
