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

/**
 * Shared, disambiguated prompt for unlocking the relay's Blurt active key.
 * The bare "Unlock passphrase" wording left operators guessing whether it
 * wanted their Blurt key, their SSH key, a GPG key, or their system password
 * (a real operator hit exactly that). Naming the key + calling out what it is
 * NOT removes the ambiguity. Used at every relay-key decrypt site (register,
 * show-key, payment-method). Pinned by passphrase-prompt-clarity-smoke.
 */
export const RELAY_KEY_UNLOCK_PROMPT =
	"Unlock passphrase for the relay's Blurt active key (the one you set at install — not your SSH, GPG, or system password)";

/**
 * Remove terminal control (CSI) sequences from a raw-mode input chunk — most
 * importantly the bracketed-paste markers `ESC [200~` / `ESC [201~` that a
 * terminal wraps around pasted text. Without this, pasting a passphrase into
 * the masked reader captured the literal `[200~…[201~` bracket bytes (the ESC
 * alone was dropped as a control char), so the decryptor got the wrong string
 * and rejected a correct passphrase (v1.15.6). Also strips cursor/arrow-key
 * CSI (`ESC [A` …) so stray keypresses don't pollute the buffer. A passphrase
 * character is never part of an ESC sequence, so this is safe. PURE. */
export function stripTerminalControlSequences(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

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
 *  in the response, returns the choice's index (0-indexed).
 *
 *  `opts.showList` (default true) prints the numbered choice list.
 *  Pass `false` when the caller has already printed its own
 *  richer catalog (e.g. the main menu) so we don't redundantly
 *  re-list every item and make the screen too tall — in that case
 *  the `question` text itself is used as the input prompt. */
export async function askChoice(
	question: string,
	choices: readonly string[],
	defaultIdx?: number,
	opts?: { showList?: boolean }
): Promise<number> {
	if (choices.length === 0) {
		throw new Error('askChoice requires at least one choice');
	}
	const showList = opts?.showList !== false;
	if (showList) {
		console.log(question);
		for (let i = 0; i < choices.length; i++) {
			const marker = defaultIdx !== undefined && i === defaultIdx ? ' (default)' : '';
			console.log(`  ${i + 1}. ${choices[i]}${marker}`);
		}
	}
	// When the list is suppressed, use the question itself as the
	// prompt so there isn't a second generic "Choose" line.
	const promptLabel = showList ? 'Choose' : question;
	while (true) {
		const raw = await ask(promptLabel, defaultIdx !== undefined ? String(defaultIdx + 1) : undefined);
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
		// Turn OFF bracketed-paste while we read: otherwise a PASTED passphrase
		// arrives wrapped in ESC[200~ … ESC[201~ and the markers pollute it
		// (v1.15.6). Restored in cleanup. We also strip any CSI that still slips
		// through (belt-and-suspenders / split chunks).
		stdout.write('\x1b[?2004l');

		let buf = '';

		const onData = (raw: string): void => {
			const chunk = stripTerminalControlSequences(raw);
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
			stdout.write('\x1b[?2004h');
			stdin.removeListener('data', onData);
			stdin.setRawMode?.(wasRaw === true);
			if (wasPaused) stdin.pause();
		};

		stdin.on('data', onData);
	});
}

/** Auto-numbering for the guided install.  The sub-steps it reuses (from the
 *  23-step `init` wizard) each carry a hardcoded "Step N of 23"; when
 *  beginSteps(total) is active, step() ignores those numbers and emits a single
 *  running "Step N of {total}" instead, so the guided install reads as one clean,
 *  non-jumping sequence with an accurate end-count.  `init` never calls
 *  beginSteps(), so it keeps its classic "Step N of 23". */
let _autoStepOn = false;
let _autoStepNum = 0;
let _autoStepTotal = 0;

export function beginSteps(total: number): void {
	_autoStepOn = true;
	_autoStepNum = 0;
	_autoStepTotal = total;
}
export function endSteps(): void {
	_autoStepOn = false;
}

/** The running step number so far (for a post-run self-check that the declared
 *  total matched the number of steps actually shown). */
export function currentStepNum(): number {
	return _autoStepNum;
}

/** Print a step header with rule lines.  Under the guided install's running
 *  counter this shows "Step N of {total}: title"; otherwise "Step N of M: title"
 *  from the caller's own numbers. */
export function step(stepNum: number, totalSteps: number, title: string): void {
	const rule = '━'.repeat(58);
	const label = _autoStepOn
		? `Step ${++_autoStepNum} of ${_autoStepTotal}: ${title}`
		: `Step ${stepNum} of ${totalSteps}: ${title}`;
	console.log('');
	console.log(rule);
	console.log(label);
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
