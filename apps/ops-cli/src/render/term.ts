/**
 * Morphit ops CLI — terminal-render primitives.
 *
 * Plain ANSI escape sequences.  No chalk/ansi-styles dep —
 * this is enough.
 *
 * Color mode comes from Config.color and tty.isTTY.  When
 * disabled, all wrappers become identity functions.
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
	const rule = '━'.repeat(SECTION_RULE_LEN);
	if (colorEnabled) {
		process.stdout.write(`${fmt.cyan(rule)}\n`);
		process.stdout.write(`${fmt.bold(fmt.cyan(title))}\n`);
		process.stdout.write(`${fmt.cyan(rule)}\n`);
	} else {
		process.stdout.write(`${rule}\n`);
		process.stdout.write(`${title}\n`);
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
	const labelPad = opts.label.padEnd(labelW);
	const valuePad = opts.value.padEnd(valueW);
	const tail =
		opts.status === undefined
			? ''
			: `${glyph(opts.status)}${opts.detail !== undefined ? ' ' + fmt.dim(opts.detail) : ''}`;
	process.stdout.write(`  ${labelPad}${valuePad}${tail}\n`);
}

/** Print a blank line. */
export function blank(): void {
	process.stdout.write('\n');
}

/** Print an info line — used when no row format applies. */
export function info(s: string): void {
	process.stdout.write(`${s}\n`);
}

/** Print a warning to stderr. */
export function warn(s: string): void {
	process.stderr.write(`${glyph('warn')} ${s}\n`);
}

/** Print an error to stderr. */
export function error(s: string): void {
	process.stderr.write(`${glyph('error')} ${s}\n`);
}
