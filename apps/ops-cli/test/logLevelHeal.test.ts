/**
 * The indexer log-level heal against a simulated box (the indexer reads its
 * env files at start and warns log_level_invalid for an unknown level).
 */
import { describe, expect, it } from 'vitest';
import { fixLogLevel, healLogLevel, type LogLevelRuntime } from '../src/lib/logLevelHeal.ts';

const IDX = '/etc/morphit/indexer.env';
class Box {
	files = new Map([[IDX, 'MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_LOG_LEVEL=verbose\n']]);
	level: string | null = 'verbose';
	log: Array<{ t: number; l: string }> = [];
	t = 1000;
	restarts = 0;
	readonly rt: LogLevelRuntime = {
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.files.set(p, t), true),
		indexerActive: () => true,
		restartIndexer: () => {
			this.restarts++;
			const m = /^MORPHIT_LOG_LEVEL=(.*)$/m.exec(this.files.get(IDX) ?? '');
			this.level = m ? m[1]! : null;
			if (this.level && !/^(debug|info|warn|error)$/i.test(this.level))
				this.log.push({ t: this.t, l: 'log_level_invalid' });
			return true;
		},
		processEnv: () => this.level,
		logSince: (ms) =>
			this.log
				.filter((x) => x.t >= ms)
				.map((x) => x.l)
				.join('\n'),
		now: () => this.t,
		sleep: async (ms) => void (this.t += ms)
	};
	run() {
		return healLogLevel(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe('the indexer log level is one it knows', () => {
	it('an unknown level becomes info; restarted; no more log_level_invalid', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'rewritten', verified: true });
		expect(b.files.get(IDX)).toBe('MORPHIT_INDEXER_LISTEN_PORT=8081\nMORPHIT_LOG_LEVEL=info\n');
		expect((await b.run()).strategy).toBe('already');
		expect(b.restarts).toBe(1);
	});
	it('valid levels (any case), empty and quoted values are left alone', () => {
		for (const v of ['debug', 'INFO', 'Warn', 'error', '', '"warn"'])
			expect(fixLogLevel(`MORPHIT_LOG_LEVEL=${v}\n`).bad).toEqual([]);
		expect(fixLogLevel(`MORPHIT_LOG_LEVEL="trace"\n`).text).toBe('MORPHIT_LOG_LEVEL=info\n');
	});
	it('a restart that does not take: not reported as done', async () => {
		const b = new Box();
		b.rt.restartIndexer = () => true;
		expect((await b.run()).verified).toBe(false);
	});
});
