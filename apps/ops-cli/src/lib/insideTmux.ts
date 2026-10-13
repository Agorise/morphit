/**
 * insideTmux.ts — is this process running inside a tmux session?
 *
 * The node guide has operators run the long install inside tmux (so a dropped
 * SSH connection doesn't stop it). When the install finishes they are still in
 * tmux, and an operator new to it doesn't know how to leave (2026-10-12). The
 * installer can't close the session for them — that would wipe the summary and
 * the passwords they still need to read — so it tells them how.
 *
 * `$TMUX` does not survive `sudo` (env_reset), so this walks the parent
 * processes instead: inside tmux, one of them is the tmux server. Linux /proc;
 * anywhere else (or on any read error) the answer is false.
 */
import { readFileSync } from 'node:fs';

/** The parent pid and command name from a /proc/<pid>/stat line. PURE. */
export function parseProcStat(stat: string): { comm: string; ppid: number } | null {
	// "<pid> (<comm>) <state> <ppid> …" — comm may hold spaces and parentheses,
	// so split at the LAST ')'.
	const open = stat.indexOf('(');
	const close = stat.lastIndexOf(')');
	if (open < 0 || close < open) return null;
	const rest = stat.slice(close + 2).split(' ');
	const ppid = Number(rest[1]);
	if (!Number.isInteger(ppid) || ppid < 0) return null;
	return { comm: stat.slice(open + 1, close), ppid };
}

export function insideTmux(
	pid: number = process.pid,
	read: (path: string) => string = (p) => readFileSync(p, 'utf8')
): boolean {
	try {
		for (let i = 0; i < 64 && pid > 1; i++) {
			const s = parseProcStat(read(`/proc/${pid}/stat`));
			if (s === null) return false;
			if (s.comm.startsWith('tmux')) return true;
			pid = s.ppid;
		}
	} catch {
		/* not Linux, or the process went away */
	}
	return false;
}

/** What to tell an operator who is inside tmux when the install is done. */
export const TMUX_EXIT_HINT =
	'  You are inside tmux. Type  exit  to close it — or press Ctrl+B, then D,\n' +
	'  to leave it running and come back later with:  tmux attach';
