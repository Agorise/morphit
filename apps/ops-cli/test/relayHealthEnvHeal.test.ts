/**
 * The relay-health heal against a simulated box: the relay reads its env files
 * at start (last file wins, true/1/yes/on), answers /v1/health with the
 * operator block only to a local caller with X-Morphit-Local-Health: 1 and no
 * forwarding headers — or to anyone when the variable was true at its start —
 * and the local web edges add X-Forwarded-For (and may or may not clear the
 * visitor's header).
 */
import { describe, expect, it } from 'vitest';
import {
	envValueIn,
	healRelayHealth,
	relayEnvFiles,
	verboseOff,
	type RelayHealthRuntime
} from '../src/lib/relayHealthEnvHeal.ts';

const [MORPHIT_ENV, , RELAY_ENV] = relayEnvFiles();

class Box {
	files = new Map<string, string>([
		[MORPHIT_ENV!, 'MORPHIT_DOMAIN=trade.example.org\n'],
		[RELAY_ENV!, '# relay\nMORPHIT_RELAY_LISTEN_PORT=8080\nMORPHIT_RELAY_VERBOSE_HEALTH=true\n']
	]);
	active = true;
	running = true;
	/** The value the relay process started with. */
	verbose = true;
	restarts = 0;
	/** A restart that does not take (the old process keeps serving). */
	stuckRestarts = 0;
	writable = true;
	edgeStrips = true;
	/** A hand-made edge that adds no forwarding header. */
	edgeForwards = true;
	/** A relay that never serves the block, not even to the local check. */
	noLocalBlock = false;
	readonly rt: RelayHealthRuntime = {
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.writable ? (this.files.set(p, t), true) : false),
		relayActive: () => this.active,
		restartRelay: () => {
			this.restarts++;
			if (this.stuckRestarts > 0) {
				this.stuckRestarts--;
				return true;
			}
			const v = envValueIn(
				relayEnvFiles().map((f) => this.files.get(f) ?? ''),
				'MORPHIT_RELAY_VERBOSE_HEALTH'
			);
			this.verbose = ['true', '1', 'yes', 'on'].includes((v ?? 'false').toLowerCase());
			return true;
		},
		get: (url, headers) => {
			if (!this.running) return null;
			const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
			if (url.startsWith('http://127.0.0.1:8080/')) return this.relay(h);
			// an edge: forwards with X-Forwarded-For, clearing the header or not
			const fwd = new Map(h);
			if (this.edgeStrips) fwd.delete('x-morphit-local-health');
			if (this.edgeForwards) fwd.set('x-forwarded-for', '127.0.0.1');
			return this.relay(fwd);
		},
		sleep: async () => {}
	};
	relay(h: Map<string, string>): string {
		const local =
			!this.noLocalBlock && h.get('x-morphit-local-health') === '1' && !h.has('x-forwarded-for');
		return local || this.verbose
			? '{"status":"ok","hidden_only":false,"version":"1","node_version":"v22","uptime_sec":5}'
			: '{"status":"ok","rpc_ok":true,"hidden_only":false}';
	}
	run() {
		return healRelayHealth(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe('the relay stops publishing its operator block (relay health)', () => {
	it('as shipped in the example (true), anyone reads the relay internals — the case the heal is for', () => {
		const b = new Box();
		expect(b.rt.get('https://trade.example.org/relay/v1/health', {})).toContain('node_version');
	});

	it('turns it off, restarts, and sees: anonymous no block, edges no block, local check still gets it', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(out.strategy).toBe('env-false');
		expect(b.files.get(RELAY_ENV!)).toBe(
			'# relay\nMORPHIT_RELAY_LISTEN_PORT=8080\nMORPHIT_RELAY_VERBOSE_HEALTH=false\n'
		);
		expect(b.restarts).toBe(1);
		expect(b.rt.get('http://127.0.0.1:8080/v1/health', {})).not.toContain('node_version');
		expect(out.detail).toMatch(/through 2 local web edge/);
		// second run: nothing to change, nothing restarted
		const again = await b.run();
		expect(again.strategy).toBe('already');
		expect(b.restarts).toBe(1);
	});

	it('every true form the relay accepts, in any file it sources; other values and lines untouched', () => {
		for (const v of ['true', 'TRUE', '1', 'yes', 'on', '"true"', "'on'"])
			expect(verboseOff(`A=1\nexport MORPHIT_RELAY_VERBOSE_HEALTH=${v}\n`).text).toBe(
				'A=1\nexport MORPHIT_RELAY_VERBOSE_HEALTH=false\n'
			);
		for (const v of ['false', '0', 'no', 'off'])
			expect(verboseOff(`MORPHIT_RELAY_VERBOSE_HEALTH=${v}\n`).changed).toBe(false);
		expect(verboseOff('# MORPHIT_RELAY_VERBOSE_HEALTH=true\n').changed).toBe(false);
	});

	it('set in morphit.env too: both files are fixed (the last one would otherwise win)', async () => {
		const b = new Box();
		b.files.set(MORPHIT_ENV!, 'MORPHIT_RELAY_VERBOSE_HEALTH=yes\n');
		b.files.set(RELAY_ENV!, 'MORPHIT_RELAY_VERBOSE_HEALTH=1\n');
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect([...b.files.values()].join('')).not.toMatch(/=(yes|1)\n/);
	});

	it('a restart that did not take: restarted once more, then verified', async () => {
		const b = new Box();
		b.stuckRestarts = 1;
		const out = await b.run();
		expect(out.strategy).toBe('second-restart');
		expect(out.verified).toBe(true);
		expect(b.restarts).toBe(2);
	});

	it('still public after both restarts: not reported as done, and says where to look on this server', async () => {
		const b = new Box();
		b.stuckRestarts = 5;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toMatch(/still get the operator block/);
		expect(out.detail).toContain('sudo systemctl restart morphit-relay');
	});

	it('an edge that passes the visitor header on as if local: not reported as done, the edge named', async () => {
		const b = new Box();
		b.edgeStrips = false;
		b.edgeForwards = false;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toContain('https://trade.example.org');
		expect(out.detail).toContain('http://127.0.0.1:8090');
	});

	it("the local check gets no block either: not verified, since the indexer's signup check would be blind", async () => {
		const b = new Box();
		b.noLocalBlock = true;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toContain(
			"curl -s -H 'X-Morphit-Local-Health: 1' http://127.0.0.1:8080/v1/health"
		);
	});

	it('the env file cannot be written: nothing restarted, the command given', async () => {
		const b = new Box();
		b.writable = false;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.restarts).toBe(0);
		expect(out.detail).toContain('MORPHIT_RELAY_VERBOSE_HEALTH=false');
	});

	it('relay not running here: the file is fixed, nothing restarted', async () => {
		const b = new Box();
		b.active = false;
		const out = await b.run();
		expect(out.strategy).toBe('env-only');
		expect(b.restarts).toBe(0);
		expect(b.files.get(RELAY_ENV!)).toContain('VERBOSE_HEALTH=false');
	});

	it('already off and the relay keeps its block local: verified without a restart', async () => {
		const b = new Box();
		b.files.set(RELAY_ENV!, 'MORPHIT_RELAY_VERBOSE_HEALTH=false\n');
		b.verbose = false;
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'already', verified: true });
		expect(b.restarts).toBe(0);
	});
});
