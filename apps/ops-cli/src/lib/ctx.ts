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
