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
 * Ctrl+C at any prompt rejects with an AbortError (readline's own, or
 * {@link abortError} for the masked reader), so each command's caller can
 * say what was stopped and what to run next — never a stack trace, and never
 * a silent exit that skips the caller's clean-up (v1.21.7: the masked reader
 * used to exit the process on the spot).
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

/** The error a prompt rejects with when the operator presses Ctrl+C (the same
 *  shape as readline's). */
export function abortError(): Error {
	return Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/** The error a prompt rejects with when its input ENDED: Ctrl+D at a terminal,
 *  or piped answers that ran out before a question that has no default. It is
 *  an abort too (every caller already stops cleanly on one), but marked, so
 *  the message says what happened — it used to say "you pressed Ctrl+C".
 *  `waitedMs` marks the other way a non-terminal run gets no answer: the input
 *  is still open but nothing came within that time (it did NOT end). */
export function inputEndedError(detail = 'Aborted with Ctrl+D', waitedMs?: number): Error {
	return Object.assign(new Error(detail), {
		name: 'AbortError',
		code: 'ABORT_ERR',
		inputEnded: true,
		...(waitedMs !== undefined ? { noAnswerWithinMs: waitedMs } : {})
	});
}

/** For a stop that was no answer arriving in time on an input that is still
 *  open: how long it waited, in ms; else null. */
export function noAnswerWithinMs(err: unknown): number | null {
	if (!isAbortError(err)) return null;
	const ms = (err as { noAnswerWithinMs?: unknown }).noAnswerWithinMs;
	return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}

/** `ms` in seconds, as a person would say it ("20 seconds", "1.5 seconds"). */
function secondsText(ms: number): string {
	const s = Math.round(ms / 100) / 10;
	return `${s} second${s === 1 ? '' : 's'}`;
}

/** The one plain line that says why a run stopped at a question: Ctrl+C, the
 *  input ending (Ctrl+D, or no more piped answers), or no answer arriving in
 *  time on an input that is still open (review v1.21.18: that last one used to
 *  say "the input ended" too, which was not what happened). */
export function stoppedLine(err: unknown): string {
	const waited = noAnswerWithinMs(err);
	if (waited !== null) {
		return `Stopped — no answer came within ${secondsText(waited)} (this is not running at a terminal, so it does not wait longer).`;
	}
	return isInputEnded(err)
		? 'Stopped — the input ended (Ctrl+D, or no more answers were piped in).'
		: 'Stopped — you pressed Ctrl+C.';
}

/** True for a Ctrl+C at a prompt (readline's AbortError or {@link abortError}). */
export function isAbortError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as { code?: unknown }).code;
	return err.name === 'AbortError' || code === 'ABORT_ERR';
}

/** True when an abort was the input ending (Ctrl+D, or piped answers that ran
 *  out), not Ctrl+C. readline's own Ctrl+D error says so in its message. */
export function isInputEnded(err: unknown): boolean {
	if (!isAbortError(err)) return false;
	return (
		(err as { inputEnded?: unknown }).inputEnded === true ||
		/Ctrl\+D/i.test((err as Error).message)
	);
}

/** How long to wait for an answer when stdin is NOT a terminal. */
export const NON_TTY_ANSWER_TIMEOUT_MS = Number(process.env.MORPHIT_PROMPT_TIMEOUT_MS ?? 20_000);

/**
 * Piped answers: ONE reader for the whole run. A new readline per question
 * (as before) read the whole pipe into the first one, and closing it threw the
 * rest away — so `printf '1\n2\n' | morphit-ops …` answered the first question
 * and lost the second. Lines are queued as they arrive and handed out one per
 * question; the reader is paused while nobody is waiting, so it never keeps
 * the process alive.
 */
interface PipedInput {
	readonly lines: string[];
	ended: boolean;
	wake: (() => void) | null;
	readonly rl: ReturnType<typeof createInterface>;
}
let piped: PipedInput | null = null;

function pipedInput(): PipedInput {
	if (piped !== null) return piped;
	const rl = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
	const p: PipedInput = { lines: [], ended: false, wake: null, rl };
	rl.on('line', (line: string) => {
		p.lines.push(line);
		p.wake?.();
	});
	rl.on('close', () => {
		p.ended = true;
		p.wake?.();
	});
	rl.pause();
	piped = p;
	return p;
}

/** Why the last {@link nextPipedLine} gave null: the input ended, or it is
 *  still open and nothing came within `ms`. */
type NoLine = { readonly ended: true } | { readonly ended: false; readonly ms: number };

function whyNoLine(timeoutMs: number): NoLine {
	return pipedInput().ended ? { ended: true } : { ended: false, ms: timeoutMs };
}

/**
 * Questions that got no answer from a non-terminal input since the last real
 * answer (review v1.21.18). Once the input has ended, every question gets ''
 * (or its default) at once, so a caller that asks again until it gets a usable
 * answer — "Fees account name", a payment method's key, the listing fee's
 * "Enter ticker" — asked it about 200,000 times a second, forever. The SAME
 * question getting no answer a second time can only be such a caller asking
 * again: that is a stop. The first one still gets '' (or its default), which
 * every "Enter to skip" question needs, and other questions in a row each get
 * theirs too.
 */
const unanswered = new Set<string>();

/** The stop for a question that got no answer (see {@link NoLine}). */
function noAnswerFor(question: string, why: NoLine): Error {
	const q = question.trim();
	return why.ended
		? inputEndedError(`No answer to "${q}" — the input ended`)
		: inputEndedError(`No answer to "${q}" within ${secondsText(why.ms)}`, why.ms);
}

/** The next piped line, or null when the input has ended or none came in time. */
async function nextPipedLine(timeoutMs: number): Promise<string | null> {
	const p = pipedInput();
	if (p.lines.length === 0 && !p.ended) {
		p.rl.resume();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, timeoutMs);
			function done(): void {
				clearTimeout(timer);
				p.wake = null;
				resolve();
			}
			p.wake = done;
		});
		if (!p.ended) p.rl.pause();
	}
	return p.lines.length > 0 ? (p.lines.shift() ?? null) : null;
}

/** An answer, and whether someone actually gave it: false when the input
 *  ended or no answer came in time and the default (or '') stands in. */
interface Answer {
	readonly text: string;
	readonly given: boolean;
	/** When not given: why no answer came. */
	readonly why?: NoLine;
}

async function askAnswer(question: string, defaultValue?: string): Promise<Answer> {
	// NEVER block forever, but DO accept piped answers. Feeding answers through a
	// pipe is ordinary automation; the hazard is stdin that never delivers (an
	// open pipe, `ssh -T`, a unit with stdin attached), where a reader waits for
	// input that cannot arrive. A terminal gets unlimited time; anything else gets
	// a bounded wait, then falls back to the documented default.
	const promptStr =
		defaultValue !== undefined ? `${question} [${defaultValue}]\n> ` : `${question}\n> `;
	let ans: string;
	if (stdin.isTTY === true) {
		const rl = createInterface({ input: stdin, output: stdout });
		try {
			ans = await rl.question(promptStr);
		} catch (err) {
			// Ctrl+D ends the input; say so rather than "Ctrl+C".
			if (isInputEnded(err)) throw inputEndedError();
			throw err;
		} finally {
			rl.close();
		}
	} else {
		stdout.write(promptStr);
		const line = await nextPipedLine(NON_TTY_ANSWER_TIMEOUT_MS);
		if (line === null) {
			const why = whyNoLine(NON_TTY_ANSWER_TIMEOUT_MS);
			// Asked again after getting no answer: a caller re-asking until it
			// gets one, which can never come (see `unanswered`). Stop.
			const key = question.trim();
			if (unanswered.has(key)) throw noAnswerFor(question, why);
			unanswered.add(key);
			return { text: defaultValue ?? '', given: false, why };
		}
		unanswered.clear();
		ans = line;
	}
	const trimmed = ans.trim();
	if (trimmed === '' && defaultValue !== undefined) return { text: defaultValue, given: true };
	return { text: trimmed, given: true };
}

/** Ask a free-form string question.  Returns the trimmed response.
 *  If `defaultValue` is provided, an empty response yields the default. */
export async function ask(question: string, defaultValue?: string): Promise<string> {
	return (await askAnswer(question, defaultValue)).text;
}

/** A question that needs a valid answer got none (the input ended, or nothing
 *  came in time) and its stand-in is not valid either: asking again would only
 *  repeat the same non-answer forever. */
function noAnswer(question: string, a: Answer): Error {
	return noAnswerFor(question, a.why ?? { ended: true });
}

/** Ask for an integer.  Re-prompts on invalid input.
 *  Returns the parsed integer.  Default can be 0. */
export async function askInt(
	question: string,
	opts: { min?: number; max?: number; default?: number } = {}
): Promise<number> {
	const { min, max, default: def } = opts;
	while (true) {
		const a = await askAnswer(question, def !== undefined ? String(def) : undefined);
		const raw = a.text;
		const n = /^\s*-?\d+\s*$/.test(raw) ? parseInt(raw, 10) : NaN;
		let problem: string | null = null;
		if (isNaN(n)) problem = '  ✗ Please enter a whole number.  Try again.\n';
		else if (min !== undefined && n < min) problem = `  ✗ Must be at least ${min}.  Try again.\n`;
		else if (max !== undefined && n > max) problem = `  ✗ Must be at most ${max}.  Try again.\n`;
		if (problem === null) return n;
		if (!a.given) throw noAnswer(question, a);
		console.log(problem);
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
		const a = await askAnswer(question, def !== undefined ? String(def) : undefined);
		const raw = a.text;
		const n = raw.trim() === '' ? NaN : Number(raw);
		let problem: string | null = null;
		if (!Number.isFinite(n))
			problem = '  ✗ Please enter a valid number (e.g. 0.25, 1.5).  Try again.\n';
		else if (min !== undefined && n < min) problem = `  ✗ Must be at least ${min}.  Try again.\n`;
		else if (max !== undefined && n > max) problem = `  ✗ Must be at most ${max}.  Try again.\n`;
		if (problem === null) return n;
		if (!a.given) throw noAnswer(question, a);
		console.log(problem);
	}
}

/** Ask a yes/no question.  Default determines what an empty
 *  response (just Enter) returns. */
export async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
	const hint = defaultYes ? 'Y/n' : 'y/N';
	while (true) {
		const raw = (await askAnswer(`${question} [${hint}]`)).text;
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
		const a = await askAnswer(
			promptLabel,
			defaultIdx !== undefined ? String(defaultIdx + 1) : undefined
		);
		// The WHOLE answer must be one number: parseInt took "20x" as 20, "1.9"
		// as 1 and "1 3" as 1, running an item the operator did not pick.
		const n = /^\s*\d+\s*$/.test(a.text) ? parseInt(a.text, 10) : NaN;
		if (isNaN(n) || n < 1 || n > choices.length) {
			// No one is there to try again (the input ended / timed out with no
			// default): asking again would loop forever.
			if (!a.given) throw noAnswer(showList ? question : promptLabel, a);
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
	if (stdin.isTTY !== true) {
		// Not a terminal (piped answers, /dev/null, a unit): the SAME queued
		// reader every other question uses (review v1.21.18). Reading stdin
		// directly here lost the line to that reader (the secret went to the
		// NEXT question), and with every answer already queued the process
		// simply ended mid-question with exit 0. No raw mode, no terminal
		// escapes: there is no terminal. No answer is a stop — a secret has no
		// stand-in.
		const line = await nextPipedLine(NON_TTY_ANSWER_TIMEOUT_MS);
		stdout.write('\n');
		if (line === null) throw noAnswerFor(prompt, whyNoLine(NON_TTY_ANSWER_TIMEOUT_MS));
		unanswered.clear();
		return line;
	}
	// Terminal escapes only to a terminal (stdout may be piped to a log).
	const toTerminal = stdout.isTTY === true;
	return new Promise<string>((resolve, reject) => {
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
		if (toTerminal) stdout.write('\x1b[?2004l');

		let buf = '';

		const onData = (raw: string): void => {
			const chunk = stripTerminalControlSequences(raw);
			for (const ch of chunk) {
				const code = ch.charCodeAt(0);
				if (code === 0x03) {
					// Ctrl+C: the caller says what was stopped (it used to exit
					// here, silently, skipping every clean-up).
					stdout.write('\n');
					cleanup();
					reject(abortError());
					return;
				}
				if (code === 0x04) {
					// Ctrl+D: the input ended — a stop, said as such. It used to
					// return '', which callers took as an answer ("don't know",
					// or asked again forever) (review v1.21.18).
					stdout.write('\n');
					cleanup();
					reject(inputEndedError());
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
			if (toTerminal) stdout.write('\x1b[?2004h');
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
