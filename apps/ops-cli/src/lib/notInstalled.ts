/**
 * "No database URL configured" on a server where Morphit was never installed
 * (review, 2026-10-29): menu item 3 (fast-sync) — or any database view — on a
 * fresh box printed "Set one of: MORPHIT_OPS_DATABASE_URL …", a list of
 * settings nobody should set by hand there. The real answer is to install it.
 *
 * On an INSTALLED server the same message came from a run without sudo
 * (review v1.21.18): the database address is in settings only root may read,
 * so the answer there is the same command with sudo.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sudoCommandLine } from './commandFailed.ts';

/** Whether this user may read `path`. */
function canRead(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** The plain message for `err` when this server has no Morphit install at all,
 *  or has one whose settings this user may not read (run without sudo), else
 *  null (keep the original message). */
export function notInstalledMessage(
	err: unknown,
	installDir: string,
	exists: (path: string) => boolean = existsSync,
	opts: {
		readonly readable?: (path: string) => boolean;
		readonly isRoot?: boolean;
		/** The command's arguments, for the exact sudo command. */
		readonly argv?: readonly string[];
	} = {}
): string | null {
	const msg = err instanceof Error ? err.message : String(err);
	if (!msg.startsWith('No database URL configured')) return null;
	const settings = [
		'/etc/morphit/indexer.env',
		join(installDir, 'morphit.env'),
		join(installDir, 'morphit.config.env')
	].filter((p) => exists(p));
	if (settings.length > 0) {
		const isRoot = opts.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0);
		const readable = opts.readable ?? canRead;
		if (!isRoot && settings.some((p) => !readable(p))) {
			return (
				'That needs administrator rights on this server: its database settings can only be read with sudo.\n' +
				`  Run it with sudo: ${sudoCommandLine(opts.argv ?? process.argv.slice(2))}`
			);
		}
		return null;
	}
	return (
		'This server has no Morphit database yet: Morphit is not installed here.\n' +
		'  Install it first: sudo morphit-ops, then choose 1 (Install / set up a new node).'
	);
}
