/**
 * Answers piped into morphit-ops, and a menu nobody can answer (review
 * 2026-10-29):
 *  - every question opened its own reader on stdin: the first one read the
 *    whole pipe and closing it threw the rest away, so only the first piped
 *    answer was ever seen;
 *  - with no terminal and no default, a menu asked "Choose" forever (each
 *    non-answer was "invalid", and asked again);
 *  - a menu took "20x" as 20, "1.9" as 1 and "1 3" as 1;
 *  - Ctrl+D was reported as "you pressed Ctrl+C".
 * The prompts run in a real child process with a real pipe on stdin.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandFailed } from '../src/lib/commandFailed.ts';
import { inputEndedError } from '../src/init/prompt.ts';

const REPO = new URL('../../../', import.meta.url).pathname;
const PROMPT = join(REPO, 'apps/ops-cli/src/init/prompt.ts');

/** Run `body` (with ask/askChoice/askYesNo in scope) with `input` piped in. */
function run(body: string, input: string, timeoutMs = 20_000) {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-prompt-'));
	const file = join(dir, 'run.ts');
	writeFileSync(
		file,
		`import { ask, askChoice, askYesNo, isInputEnded } from ${JSON.stringify(PROMPT)};\n` +
			`(async () => {\ntry {\n${body}\n} catch (e) { console.log('THREW', isInputEnded(e), (e as Error).message); }\nprocess.exit(0);\n})();\n`
	);
	const started = Date.now();
	const r = spawnSync(join(REPO, 'node_modules/.bin/tsx'), [file], {
		input,
		encoding: 'utf8',
		timeout: timeoutMs,
		env: { ...process.env, MORPHIT_PROMPT_TIMEOUT_MS: '3000' }
	});
	return { out: `${r.stdout}${r.stderr}`, ms: Date.now() - started, status: r.status };
}

describe('piped answers', () => {
	it('every question gets its own piped line', () => {
		const r = run(
			`const a = await ask('one'); const b = await ask('two'); const c = await askChoice('pick', ['x', 'y', 'z']);\n` +
				`console.log('GOT', JSON.stringify([a, b, c]));`,
			'alpha\nbeta\n3\n'
		);
		expect(r.out).toContain('GOT ["alpha","beta",2]');
	});

	it('a menu with no default stops when the input ends, instead of asking forever', () => {
		const r = run(`await askChoice('pick', ['x', 'y']); console.log('NOT REACHED');`, 'nonsense\n');
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/THREW true No answer to "pick"/);
		expect(r.out.match(/Please enter a number/g)?.length ?? 0).toBeLessThanOrEqual(1);
		expect(r.ms).toBeLessThan(15_000);
	});

	it('a yes/no question takes its default when the input has ended', () => {
		const r = run(`console.log('YN', await askYesNo('ok?', false));`, '');
		expect(r.out).toContain('YN false');
	});
});

describe('menu numbers', () => {
	it.each(['20x', '1.9', '1 3'])('"%s" is not taken as a choice', (bad) => {
		const r = run(
			`const c = await askChoice('pick', ['a', 'b', 'c'], 2); console.log('PICKED', c);`,
			`${bad}\n`
		);
		// Refused, then the input ended → the default (3rd item, index 2).
		expect(r.out).toMatch(/Please enter a number between 1 and 3/);
		expect(r.out).toContain('PICKED 2');
	});
});

describe('Ctrl+D', () => {
	it('is reported as the input ending, not as Ctrl+C', () => {
		const out: string[] = [];
		expect(commandFailed(inputEndedError(), (s) => void out.push(s))).toBe(130);
		expect(out.join('\n')).toMatch(/the input ended/);
		expect(out.join('\n')).not.toMatch(/Ctrl\+C/);
		// readline's own Ctrl+D error, as Node 22 throws it
		const rl = Object.assign(new Error('Aborted with Ctrl+D'), {
			name: 'AbortError',
			code: 'ABORT_ERR'
		});
		const out2: string[] = [];
		commandFailed(rl, (s) => void out2.push(s));
		expect(out2.join('\n')).not.toMatch(/Ctrl\+C/);
	});
});
