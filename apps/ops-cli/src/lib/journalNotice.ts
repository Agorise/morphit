/**
 * One-time notice about relay log lines older relays left in journald
 * (operator-confirmed heal).
 *
 * Relays before this release logged each sequential-pattern signup rejection
 * at info level with the client's network prefix (/24 or /64) and the account
 * names created from it (event `sequential_pattern_rejected`, fields
 * `bucketKey`, `matched`). The new relay does not. The old lines stay in the
 * journal until it rotates them away; journald cannot delete one unit's lines,
 * only whole journal files.
 *
 * Once per box: count those lines; when there are none, remember that and say
 * nothing. When there are some, say so plainly and, at a terminal, ask whether
 * to drop ALL journal history now (rotate + vacuum). Yes → do it and verify by
 * counting again; no → remember the answer and never ask again. Not asked
 * (the upgrade never waits for an answer; no terminal) → nothing is changed and
 * the notice names the command that asks it (`later`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const JOURNAL_NOTICE_MARKER = '/var/lib/morphit/.journal-signup-prefix-notice-done';

export interface JournalNoticeRuntime {
	/** How many journal lines of the relay carry the old event; null if unknown. */
	count(): number | null;
	/** `journalctl --rotate` then `--vacuum-time=1s`; true when both ran. */
	vacuum(): boolean;
	/** Ask y/N at a terminal; null when it is not asked now. */
	ask(question: string): Promise<boolean | null>;
	/** The command that asks it later. */
	later?: string;
	markerExists(): boolean;
	writeMarker(text: string): void;
	info(m: string): void;
	warn(m: string): void;
	spinner(label: string): () => void;
}

export type JournalNoticeOutcome =
	| 'already-handled'
	| 'nothing-found'
	| 'unknown'
	| 'vacuumed'
	| 'vacuum-incomplete'
	| 'declined'
	| 'not-asked';

export async function relayJournalNotice(rt: JournalNoticeRuntime): Promise<JournalNoticeOutcome> {
	if (rt.markerExists()) return 'already-handled';
	const stop = rt.spinner('Checking the relay’s older log lines on this server…');
	let n: number | null;
	try {
		n = rt.count();
	} finally {
		stop();
	}
	if (n === null) return 'unknown';
	if (n === 0) {
		rt.writeMarker('nothing found\n');
		return 'nothing-found';
	}
	rt.info(
		`On this server: older relay logs hold ${n} line(s) that pair a client's network prefix with account names. ` +
			'The relay no longer writes them. journald cannot delete one service’s lines; dropping them means ' +
			'dropping ALL journal history on this server (sudo journalctl --rotate && sudo journalctl --vacuum-time=1s).'
	);
	const yes = await rt.ask('Drop all journal history on this server now?');
	if (yes === null) {
		rt.info(`Not asked now, so nothing was changed.${rt.later ? ` To answer: ${rt.later}` : ''}`);
		return 'not-asked';
	}
	if (!yes) {
		rt.writeMarker(`declined ${new Date().toISOString()}\n`);
		rt.info('Left the journal as it is; this is not asked again.');
		return 'declined';
	}
	const stop2 = rt.spinner('Rotating and emptying the journal…');
	let left: number | null;
	try {
		rt.vacuum();
		left = rt.count();
	} finally {
		stop2();
	}
	if (left === 0) {
		rt.writeMarker(`vacuumed ${new Date().toISOString()}\n`);
		rt.info('✓ Journal history dropped; no such line is left.');
		return 'vacuumed';
	}
	rt.warn(
		`${left ?? 'Some'} line(s) are still in the journal (a journal file still in use is kept). ` +
			'Run on this server later: sudo journalctl --rotate && sudo journalctl --vacuum-time=1s'
	);
	return 'vacuum-incomplete';
}

/** The marker file, created with its directory. */
export function writeNoticeMarker(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, { mode: 0o600 });
}

export function noticeMarkerExists(path: string): boolean {
	return existsSync(path);
}
