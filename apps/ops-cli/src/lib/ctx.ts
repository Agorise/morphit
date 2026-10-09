/**
 * Morphit ops CLI — shared command context.
 *
 * Every subcommand's run function takes a CommandCtx.
 * Centralizing the shape makes it easy to add fields
 * (e.g., a logger, a clock-injection for testing) later
 * without touching every command.
 */

import type { Database } from '../db.ts';
import type { Config } from '../config.ts';
import { startDotsSpinner } from '../init/spinner.ts';

export interface CommandCtx {
	readonly db: Database;
	readonly config: Config;
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
}

/** Convenience: did the user pass --json? */
export function jsonOutput(ctx: CommandCtx): boolean {
	return ctx.flags.json === 'true';
}

/**
 * Run a command's database read under the braille spinner, so the wait for
 * Postgres (up to the pool's 5 s connect timeout, then the queries) is never a
 * silent pause at the terminal. Under --json the spinner goes to stderr, so
 * stdout carries nothing but the JSON document. Always stopped (line cleared)
 * before the caller prints anything, success or throw. Nothing at all without
 * a terminal.
 */
export async function whileReading<T>(
	ctx: CommandCtx,
	fn: () => Promise<T>,
	label = 'Reading from the database…'
): Promise<T> {
	const out = jsonOutput(ctx) ? process.stderr : process.stdout;
	// Without a terminal there is no wait to show anyone, and the label would
	// be a stray line in a piped report or a cron mail (review 2026-10-08).
	const stop = out.isTTY ? startDotsSpinner(label, out) : () => undefined;
	try {
		return await fn();
	} finally {
		stop();
	}
}
