/**
 * The indexer asset-policy heal against a simulated box: the indexer reads
 * morphit.env, morphit.config.env, then /etc/morphit/indexer.env (last wins).
 */
import { describe, expect, it } from 'vitest';
import {
	healIndexerEnvShadow,
	withoutEmptyShadows,
	type ShadowRuntime
} from '../src/lib/indexerEnvShadowHeal.ts';

const CFG = '/opt/morphit/morphit.config.env';
const IDX = '/etc/morphit/indexer.env';
const TEMPLATE_OUT =
	'# policy\nMORPHIT_INDEXER_DISABLED_ASSETS=\nMORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=\nMORPHIT_INDEXER_ATTESTATION_PHASE=1\n';

class Box {
	files = new Map<string, string>([
		[CFG, 'MORPHIT_INSTANCE_NAME=x\nMORPHIT_INDEXER_DISABLED_ASSETS="USDT,USDC"\n'],
		[IDX, TEMPLATE_OUT]
	]);
	running = new Map<string, string>();
	restarts = 0;
	constructor() {
		this.start();
	}
	start(): void {
		this.running.clear();
		for (const f of ['/opt/morphit/morphit.env', CFG, IDX])
			for (const m of (this.files.get(f) ?? '').matchAll(/^([A-Z_]+)=(.*)$/gm))
				this.running.set(m[1]!, m[2]!.replace(/^"(.*)"$/, '$1'));
	}
	readonly rt: ShadowRuntime = {
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.files.set(p, t), true),
		indexerActive: () => true,
		restartIndexer: () => (this.restarts++, this.start(), true),
		processEnv: (k) => this.running.get(k),
		sleep: async () => {}
	};
	run() {
		return healIndexerEnvShadow(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe("the operator's asset policy is not undone by indexer.env (asset policy)", () => {
	it('as installed, the empty line in indexer.env wins over morphit.config.env — the case the heal is for', () => {
		expect(new Box().running.get('MORPHIT_INDEXER_DISABLED_ASSETS')).toBe('');
	});

	it('removes the empty lines, restarts, and the running indexer has the config.env value', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'removed-restarted', verified: true });
		expect(b.running.get('MORPHIT_INDEXER_DISABLED_ASSETS')).toBe('USDT,USDC');
		expect(b.files.get(IDX)).toBe('# policy\nMORPHIT_INDEXER_ATTESTATION_PHASE=1\n');
		expect((await b.run()).strategy).toBe('already');
		expect(b.restarts).toBe(1);
	});

	it('nothing set in config.env: the lines go, no restart (nothing the indexer uses changes)', async () => {
		const b = new Box();
		b.files.set(CFG, 'MORPHIT_INSTANCE_NAME=x\n');
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'removed', verified: true });
		expect(b.restarts).toBe(0);
	});

	it('a non-empty value in indexer.env is kept, and named when config.env disagrees', async () => {
		const b = new Box();
		b.files.set(IDX, 'MORPHIT_INDEXER_DISABLED_ASSETS=DOGE\n');
		const out = await b.run();
		expect(b.files.get(IDX)).toBe('MORPHIT_INDEXER_DISABLED_ASSETS=DOGE\n');
		expect(out.strategy).toBe('already');
		expect(out.detail).toContain('overrides USDT,USDC');
	});

	it('only empty assignments (any quoting) of the two keys are removed', () => {
		expect(
			withoutEmptyShadows(
				'MORPHIT_INDEXER_DISABLED_ASSETS=""\nMORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=\'\'\nOTHER=\n'
			).text
		).toBe('OTHER=\n');
		expect(withoutEmptyShadows('MORPHIT_INDEXER_DISABLED_ASSETS=USDT\n').removed).toEqual([]);
	});
});
