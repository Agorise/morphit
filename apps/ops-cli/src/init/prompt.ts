/**
 * Morphit ops CLI — interactive prompt helpers.
 *
 * Thin wrapper over node:readline/promises with conveniences
 * the wizard needs:
 *   - ask:           plain string with optional default
 *   - askInt:        integer with min/max validation
 *   - askYesNo:      y/n with default
 *   - askPassword:   masked input (no echo)
 *   - askChoice:     numbered single-select
 *
 * All prompts honor Ctrl+C → exit 130 (SIGINT convention) so
 * the operator can bail out of any step without a confusing
 * stack trace.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Ask a free-form string question.  Returns the trimmed response.
 *  If `defaultValue` is provided, an empty response yields the default. */
export async function ask(question: string, defaultValue?: string): Promise<string> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const promptStr =
			defaultValue !== undefined ? `${question} [${defaultValue}]\n> ` : `${question}\n> `;
		const ans = await rl.question(promptStr);
		const trimmed = ans.trim();
		if (trimmed === '' && defaultValue !== undefined) return defaultValue;
		return trimmed;
	} finally {
		rl.close();
	}
}

/** Ask for an integer.  Re-prompts on invalid input.
 *  Returns the parsed integer.  Default can be 0. */
export async function askInt(
	question: string,
	opts: { min?: number; max?: number; default?: number } = {}
): Promise<number> {
	const { min, max, default: def } = opts;
	while (true) {
		const raw = await ask(question, def !== undefined ? String(def) : undefined);
		const n = parseInt(raw, 10);
		if (isNaN(n)) {
			console.log('  ✗ Please enter a whole number.  Try again.\n');
			continue;
		}
		if (min !== undefined && n < min) {
			console.log(`  ✗ Must be at least ${min}.  Try again.\n`);
			continue;
		}
		if (max !== undefined && n > max) {
			console.log(`  ✗ Must be at most ${max}.  Try again.\n`);
			continue;
		}
		return n;
	}
}

/** Ask for a positive finite floating-point number.  Loops on
 *  invalid input.  Used for prices, ratios, and other non-
 *  integer numeric inputs in the wizard. */
export async function askFloat(
	question: string,
	opts: { min?: number; max?: number; default?: number } = {}
): Promise<number> {
	const { min, max, default: def } = opts;
	while (true) {
		const raw = await ask(question, def !== undefined ? String(def) : undefined);
		const n = Number(raw);
		if (!Number.isFinite(n)) {
			console.log('  ✗ Please enter a valid number (e.g. 0.25, 1.5).  Try again.\n');
			continue;
		}
		if (min !== undefined && n < min) {
			console.log(`  ✗ Must be at least ${min}.  Try again.\n`);
			continue;
		}
		if (max !== undefined && n > max) {
			console.log(`  ✗ Must be at most ${max}.  Try again.\n`);
			continue;
		}
		return n;
	}
}

/** Ask a yes/no question.  Default determines what an empty
 *  response (just Enter) returns. */
export async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
	const hint = defaultYes ? 'Y/n' : 'y/N';
	while (true) {
		const raw = await ask(`${question} [${hint}]`);
		if (raw === '') return defaultYes;
		const lower = raw.toLowerCase();
		if (lower === 'y' || lower === 'yes') return true;
		if (lower === 'n' || lower === 'no') return false;
		console.log('  ✗ Please answer y or n.  Try again.\n');
	}
}

/** Ask a numbered single-select question.  Renders each choice
 *  on its own line with a 1-indexed number, accepts a number
 *  in the response, returns the choice's index (0-indexed). */
export async function askChoice(
	question: string,
	choices: readonly string[],
	defaultIdx?: number
): Promise<number> {
	if (choices.length === 0) {
		throw new Error('askChoice requires at least one choice');
	}
	console.log(question);
	for (let i = 0; i < choices.length; i++) {
		const marker = defaultIdx !== undefined && i === defaultIdx ? ' (default)' : '';
		console.log(`  ${i + 1}. ${choices[i]}${marker}`);
	}
	while (true) {
		const raw = await ask('Choose', defaultIdx !== undefined ? String(defaultIdx + 1) : undefined);
		const n = parseInt(raw, 10);
		if (isNaN(n) || n < 1 || n > choices.length) {
			console.log(`  ✗ Please enter a number between 1 and ${choices.length}.  Try again.\n`);
			continue;
		}
		return n - 1;
	}
}

/** Ask for a password / secret.  No echo to terminal, no entry
 *  in the readline history.  Uses raw-mode + character-by-
 *  character read because node:readline doesn't natively mask.
 *
 *  Caller is responsible for follow-up confirm-prompt + match
 *  check when a confirmation is desired (we don't bake that in
 *  because some flows want one-shot entry, not confirmation). */
export async function askPassword(prompt: string): Promise<string> {
	stdout.write(`${prompt}\n> `);
	return new Promise<string>((resolve) => {
		const wasRaw = stdin.isRaw;
		const wasPaused = stdin.isPaused();
		// readable-mode handler reads the stream as a sequence of
		// utf-8 strings; we accumulate, watch for newline.
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.setEncoding('utf8');

		let buf = '';

		const onData = (chunk: string): void => {
			for (const ch of chunk) {
				const code = ch.charCodeAt(0);
				if (code === 0x03) {
					// Ctrl+C: clean exit.
					stdout.write('\n');
					cleanup();
					process.exit(130);
				}
				if (code === 0x04) {
					// Ctrl+D / EOT — treat as cancel; return empty.
					stdout.write('\n');
					cleanup();
					resolve('');
					return;
				}
				if (ch === '\n' || ch === '\r') {
					stdout.write('\n');
					cleanup();
					resolve(buf);
					return;
				}
				if (code === 0x7f || code === 0x08) {
					// Backspace.
					if (buf.length > 0) {
						buf = buf.slice(0, -1);
						stdout.write('\b \b');
					}
					continue;
				}
				if (code < 0x20) {
					// Other control chars — ignore.
					continue;
				}
				buf += ch;
				stdout.write('*');
			}
		};

		const cleanup = (): void => {
			stdin.removeListener('data', onData);
			stdin.setRawMode?.(wasRaw === true);
			if (wasPaused) stdin.pause();
		};

		stdin.on('data', onData);
	});
}

/** Print a section header with rule lines.  Used to delimit
 *  wizard steps so the output is scannable. */
export function step(stepNum: number, totalSteps: number, title: string): void {
	const rule = '━'.repeat(58);
	console.log('');
	console.log(rule);
	console.log(`Step ${stepNum} of ${totalSteps}: ${title}`);
	console.log(rule);
	console.log('');
}

/** Print an explanatory paragraph block.  Wraps long lines at
 *  ~70 chars to stay readable in narrow terminals. */
export function explain(text: string): void {
	const lines = text.split('\n');
	for (const line of lines) {
		console.log(line);
	}
	console.log('');
}

/** Print a list of examples, prefixed with "  • ". */
export function examples(items: readonly string[]): void {
	console.log('Examples:');
	for (const item of items) {
		console.log(`  • ${item}`);
	}
	console.log('');
}
