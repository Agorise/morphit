/**
 * Morphit ops CLI — terminal-render primitives.
 *
 * Plain ANSI escape sequences.  No chalk/ansi-styles dep —
 * this is enough.
 *
 * Color mode comes from Config.color and tty.isTTY.  When
 * disabled, all wrappers become identity functions.
 *
 * cp139-C: defense against terminal-escape injection via
 * external content (DB rows, RPC responses, error messages
 * containing chain-influenced text).  Every primitive that
 * writes to stdout/stderr funnels through `sanitizeForTerm`,
 * which strips C0/C1 control chars and ESC sequences EXCEPT
 * the ANSI SGR escapes our own `fmt.*` helpers emit.  Result:
 * `info(fmt.red(hostileString))` produces colored output of
 * the visible characters with all terminal-control escapes
 * stripped.  fmt.* output is preserved untouched.
 *
 * Two surfaces still bypass this: (1) callers using
 * `console.log` directly (e.g. the init wizard and
 * systemCheck.ts renderer, which predate this hardening) and
 * (2) `process.stderr.write` in main.ts's last-resort
 * handler.  Those sites apply `sanitizeForTerm` inline when
 * they emit external content; see the cp139-C-* findings for
 * the call-site coverage.
 */

import type { Config } from '../config.ts';

// ─── ANSI codes ──────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const FG_RED = '\x1b[31m';
const FG_GREEN = '\x1b[32m';
const FG_YELLOW = '\x1b[33m';
const FG_BLUE = '\x1b[34m';
const FG_CYAN = '\x1b[36m';
const FG_GRAY = '\x1b[90m';

// ─── Terminal-escape sanitization (cp139-C) ──────────────────────

/** Strip control bytes that could be interpreted by the operator's
 *  terminal as commands rather than text.  Allowlist:
 *  - Printable characters (0x20-0x7E) pass through.
 *  - Tab (0x09) and newline (0x0A) pass through.
 *  - ANSI SGR escape sequences (`\x1b[N;N;...m`) pass through —
 *    these are color/style codes emitted by `fmt.red`/`fmt.bold`
 *    /etc.; stripping them would break colors.
 *  - Non-ASCII bytes (UTF-8 continuation) pass through verbatim.
 *
 *  Stripped:
 *  - All other C0 control chars (0x00-0x08, 0x0B-0x1F) — BS, FF,
 *    VT, etc. — that some terminals interpret.
 *  - DEL (0x7F).
 *  - C1 control chars in their bare-byte form (0x80-0x9F) — some
 *    8-bit terminal modes interpret these as CSI/DCS/OSC.
 *  - Any ESC sequence that isn't a CSI-SGR (ESC `[` digits/`;` `m`).
 *    This drops:
 *      * OSC (ESC `]`): window-title / clipboard / hyperlink
 *        sequences terminated by BEL or ST.
 *      * DCS, SOS, PM, APC: device-control / private modes.
 *      * Single-shift / Fp / Fs / Fe / F0..F3 sequences.
 *      * CSI sequences that AREN'T SGR (cursor moves, screen
 *        clears, alternate-buffer switches).
 *
 *  Threat model: DB rows / RPC responses / FS file content can be
 *  influenced by hostile parties.  Today the practical reach is
 *  near-zero (Morphit's loggers emit hardcoded text, chain RPC
 *  responses don't contain ANSI in practice), but defending at the
 *  display boundary is cheap and closes the bug class for every
 *  future flow that might pipe user-influenced text into operator
 *  display. */
export function sanitizeForTerm(s: string): string {
	let out = '';
	let i = 0;
	while (i < s.length) {
		const ch = s.charCodeAt(i);
		if (ch === 0x1b) {
			// ESC.  If immediately followed by `[`, look for a
			// CSI-SGR terminator `m`.  Allow only that.  Drop all
			// other ESC sequences.
			if (s.charCodeAt(i + 1) === 0x5b /* '[' */) {
				let j = i + 2;
				let sgr = false;
				// Defensive upper bound: SGR sequences are very short
				// in practice (`\x1b[N;N;N;Nm` — 4 SGR params is the
				// max we ever emit).  Cap the search at 32 chars to
				// avoid runaway hunts in pathological input.
				const maxJ = Math.min(s.length, i + 32);
				while (j < maxJ) {
					const cc = s.charCodeAt(j);
					if (cc === 0x6d /* 'm' */) {
						// Verify intermediate bytes are digits / `;`.
						let allDigits = true;
						for (let k = i + 2; k < j; k++) {
							const c2 = s.charCodeAt(k);
							if (!((c2 >= 0x30 && c2 <= 0x39) || c2 === 0x3b)) {
								allDigits = false;
								break;
							}
						}
						if (allDigits) {
							out += s.slice(i, j + 1);
							i = j + 1;
							sgr = true;
						}
						break;
					}
					// Any non-digit-non-semicolon char before `m`
					// means this isn't a SGR sequence; stop hunting.
					if (!((cc >= 0x30 && cc <= 0x39) || cc === 0x3b)) break;
					j++;
				}
				if (sgr) continue;
				// Not SGR: drop the ESC byte itself; the rest of the
				// non-CSI sequence will get scanned below and any
				// disallowed bytes stripped individually.
				i++;
				continue;
			}
			// ESC not followed by `[`: drop the ESC byte.  Successor
			// bytes get scanned individually (and if they're printable
			// ASCII they pass through, which is intentional — we don't
			// try to identify and consume the entire malformed
			// sequence, just neutralize the ESC).
			i++;
			continue;
		}
		// C0 control chars except \t \n.
		if ((ch >= 0x00 && ch <= 0x08) || (ch >= 0x0b && ch <= 0x1f)) {
			i++;
			continue;
		}
		// DEL.
		if (ch === 0x7f) {
			i++;
			continue;
		}
		// C1 control chars (8-bit-mode escape introducers).
		if (ch >= 0x80 && ch <= 0x9f) {
			i++;
			continue;
		}
		out += s[i];
		i++;
	}
	return out;
}

// ─── Color decision ──────────────────────────────────────────────

let colorEnabled = false;

export function initColor(config: Config): void {
	if (config.color === 'never') {
		colorEnabled = false;
		return;
	}
	if (config.color === 'always') {
		colorEnabled = true;
		return;
	}
	// auto — TTY-aware
	colorEnabled = process.stdout.isTTY === true;
}

function wrap(code: string, s: string): string {
	if (!colorEnabled) return s;
	return code + s + RESET;
}

// ─── Public color helpers ────────────────────────────────────────

export const fmt = {
	bold: (s: string): string => wrap(BOLD, s),
	dim: (s: string): string => wrap(DIM, s),
	red: (s: string): string => wrap(FG_RED, s),
	green: (s: string): string => wrap(FG_GREEN, s),
	yellow: (s: string): string => wrap(FG_YELLOW, s),
	blue: (s: string): string => wrap(FG_BLUE, s),
	cyan: (s: string): string => wrap(FG_CYAN, s),
	gray: (s: string): string => wrap(FG_GRAY, s)
};

// ─── Status glyphs ───────────────────────────────────────────────

export type Status = 'ok' | 'warn' | 'error' | 'info';

/** Render a status glyph.  Uses Unicode when color is on (modern
 *  terminal almost-certainly supports UTF-8), ASCII tags when
 *  color is off (more conservative — minimal terminals get a
 *  more readable plain-ASCII alternative). */
export function glyph(status: Status): string {
	if (!colorEnabled) {
		switch (status) {
			case 'ok':
				return '[OK]';
			case 'warn':
				return '[WARN]';
			case 'error':
				return '[ERR]';
			case 'info':
				return '[i]';
		}
	}
	switch (status) {
		case 'ok':
			return fmt.green('✓');
		case 'warn':
			return fmt.yellow('⚠');
		case 'error':
			return fmt.red('✗');
		case 'info':
			return fmt.blue('ℹ');
	}
}

// ─── Section rendering ───────────────────────────────────────────

const SECTION_RULE_LEN = 50;

/** Print a section header. */
export function section(title: string): void {
	const safe = sanitizeForTerm(title);
	const rule = '━'.repeat(SECTION_RULE_LEN);
	if (colorEnabled) {
		process.stdout.write(`${fmt.cyan(rule)}\n`);
		process.stdout.write(`${fmt.bold(fmt.cyan(safe))}\n`);
		process.stdout.write(`${fmt.cyan(rule)}\n`);
	} else {
		process.stdout.write(`${rule}\n`);
		process.stdout.write(`${safe}\n`);
		process.stdout.write(`${rule}\n`);
	}
}

/** Print a key:value line, optionally with a status glyph and
 *  an inline detail (the last column). */
export function row(opts: {
	label: string;
	value: string;
	status?: Status;
	detail?: string;
}): void {
	const labelW = 22;
	const valueW = 22;
	const labelPad = sanitizeForTerm(opts.label).padEnd(labelW);
	const valuePad = sanitizeForTerm(opts.value).padEnd(valueW);
	const tail =
		opts.status === undefined
			? ''
			: `${glyph(opts.status)}${opts.detail !== undefined ? ' ' + fmt.dim(sanitizeForTerm(opts.detail)) : ''}`;
	process.stdout.write(`  ${labelPad}${valuePad}${tail}\n`);
}

/** Print a blank line. */
export function blank(): void {
	process.stdout.write('\n');
}

/** Print an info line — used when no row format applies. */
export function info(s: string): void {
	process.stdout.write(`${sanitizeForTerm(s)}\n`);
}

/** Print a warning to stderr. */
export function warn(s: string): void {
	process.stderr.write(`${glyph('warn')} ${sanitizeForTerm(s)}\n`);
}

/** Print an error to stderr. */
export function error(s: string): void {
	process.stderr.write(`${glyph('error')} ${sanitizeForTerm(s)}\n`);
}
