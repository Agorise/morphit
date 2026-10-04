/**
 * An unrecognised MORPHIT_LOG_LEVEL means 'info', not debug.
 *
 * The level was taken from the environment unchecked. "INFO", "verbose" or a
 * typo compared as below every level, so every debug line — including the
 * per-account presence lines — was written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type LogModule = typeof import('$log');

async function freshLogWith(level: string | undefined): Promise<LogModule> {
	vi.resetModules();
	if (level === undefined) delete process.env.MORPHIT_LOG_LEVEL;
	else process.env.MORPHIT_LOG_LEVEL = level;
	return (await import('$log')) as LogModule;
}

const original = process.env.MORPHIT_LOG_LEVEL;
afterEach(() => {
	if (original === undefined) delete process.env.MORPHIT_LOG_LEVEL;
	else process.env.MORPHIT_LOG_LEVEL = original;
	vi.resetModules();
});

async function levelsWritten(envLevel: string | undefined): Promise<string[]> {
	const log = await freshLogWith(envLevel);
	const seen: string[] = [];
	log.setLogSink((r) => seen.push(`${r.level}:${r.event}`));
	const l = log.logger('t');
	l.debug('d');
	l.info('i');
	l.warn('w');
	return seen;
}

describe('MORPHIT_LOG_LEVEL', () => {
	for (const bad of ['verbose', 'trace', 'inf', '1']) {
		it(`"${bad}" logs at info, not debug`, async () => {
			expect(await levelsWritten(bad)).toEqual(['info:i', 'warn:w']);
		});
	}
	it('a valid level in any case works', async () => {
		expect(await levelsWritten(' WARN ')).toEqual(['warn:w']);
		expect(await levelsWritten('debug')).toEqual(['debug:d', 'info:i', 'warn:w']);
		expect(await levelsWritten(undefined)).toEqual(['info:i', 'warn:w']);
	});
});
