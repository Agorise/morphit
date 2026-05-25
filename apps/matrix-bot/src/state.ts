/**
 * Persistent state for the matrix-bot — SQLite-backed.
 *
 * Two purposes:
 *   1. Rate-limit windows for WARN-tier alerts (one row per
 *      category recording the last delivery timestamp).
 *   2. Suppression counts (each suppressed WARN gets a row;
 *      surfaced in the daily digest as "you got N alerts of
 *      this kind today, we DM'd you 1").
 *   3. INFO accumulator — each INFO event gets stashed for the
 *      daily 09:00 UTC digest, then drained when the digest
 *      fires.
 *
 * Database path is configurable via MORPHIT_MATRIX_BOT_STATE_DB.
 * Default `/var/lib/morphit-matrix-bot/state.db` — the systemd
 * unit creates the directory with the right ownership.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AlertCategory, StructuredAlert } from './classifier.ts';

export interface State {
	/** Last delivery time (ms since epoch) for this category, or
	 *  null if we've never delivered an alert of this category. */
	getLastDelivery(category: AlertCategory): number | null;
	setLastDelivery(category: AlertCategory, ms: number): void;

	/** Count of suppressed WARN events for this category since
	 *  `sinceMs`.  Surfaced by the digest builder. */
	countSuppressions(category: AlertCategory, sinceMs: number): number;
	insertSuppression(category: AlertCategory, ms: number): void;

	/** Pile a structured alert into the INFO accumulator.  Read
	 *  back + emptied by the digest builder. */
	pushInfoEvent(alert: StructuredAlert): void;
	drainInfoEvents(): ReadonlyArray<StructuredAlert>;

	/** Truncate stale rows.  Called once a day after digest fires
	 *  to keep the DB from growing without bound. */
	pruneOlderThan(ms: number): void;

	/** Close the database (clean shutdown). */
	close(): void;
}

/** Parse a batch of info_events `payload_json` strings into
 *  StructuredAlert instances, tolerating rows with corrupt JSON.
 *
 *  Exported so the matrix-bot-input-hardening smoke can verify
 *  cp139 B-1 (tolerant drain) without standing up a real SQLite
 *  instance — the smoke environment may not have a built
 *  better-sqlite3 binary.  Production `drainInfoEvents()` below
 *  calls this with the rows it SELECTed from the DB.
 *
 *  Behavior:
 *  - Good rows → parsed StructuredAlert objects in the output.
 *  - Bad rows → skipped, with a console.error per row and one
 *    aggregate console.error if any rows were dropped.
 *  - Order preserved (input order = output order, minus drops). */
export function parseInfoRowsTolerantly(
	rows: ReadonlyArray<{ payload_json: string }>
): StructuredAlert[] {
	const events: StructuredAlert[] = [];
	let corruptCount = 0;
	for (const r of rows) {
		try {
			events.push(JSON.parse(r.payload_json) as StructuredAlert);
		} catch (err) {
			corruptCount++;
			console.error(
				`drainInfoEvents: skipping corrupt info_events row ` +
					`(payload_json not valid JSON): ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}
	if (corruptCount > 0) {
		console.error(
			`drainInfoEvents: ${corruptCount} of ${rows.length} info_events ` +
				`rows had corrupt JSON and were dropped.  Continuing with ` +
				`${events.length} good events.`
		);
	}
	return events;
}

/** Open / create the SQLite database at `path`.  Creates parent
 *  directory if missing.  Schema is set up idempotently on every
 *  open. */
export function openState(path: string): State {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.exec(`
		CREATE TABLE IF NOT EXISTS last_delivery (
			category TEXT PRIMARY KEY,
			delivered_at_ms INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS suppressions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			category TEXT NOT NULL,
			suppressed_at_ms INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_suppressions_cat_ts
			ON suppressions(category, suppressed_at_ms);
		CREATE TABLE IF NOT EXISTS info_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			received_at_ms INTEGER NOT NULL,
			payload_json TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_info_events_ts ON info_events(received_at_ms);
	`);

	const stmts = {
		getLastDelivery: db.prepare(
			'SELECT delivered_at_ms FROM last_delivery WHERE category = ?'
		),
		setLastDelivery: db.prepare(
			`INSERT INTO last_delivery (category, delivered_at_ms)
			 VALUES (?, ?)
			 ON CONFLICT(category) DO UPDATE SET delivered_at_ms = excluded.delivered_at_ms`
		),
		countSuppressions: db.prepare(
			`SELECT COUNT(*) AS n FROM suppressions
			 WHERE category = ? AND suppressed_at_ms >= ?`
		),
		insertSuppression: db.prepare(
			'INSERT INTO suppressions (category, suppressed_at_ms) VALUES (?, ?)'
		),
		insertInfo: db.prepare(
			'INSERT INTO info_events (received_at_ms, payload_json) VALUES (?, ?)'
		),
		selectInfo: db.prepare(
			'SELECT payload_json FROM info_events ORDER BY received_at_ms ASC'
		),
		deleteInfo: db.prepare('DELETE FROM info_events'),
		pruneSuppressions: db.prepare(
			'DELETE FROM suppressions WHERE suppressed_at_ms < ?'
		),
		pruneInfo: db.prepare('DELETE FROM info_events WHERE received_at_ms < ?')
	};

	return {
		getLastDelivery(category) {
			const row = stmts.getLastDelivery.get(category) as { delivered_at_ms: number } | undefined;
			return row?.delivered_at_ms ?? null;
		},
		setLastDelivery(category, ms) {
			stmts.setLastDelivery.run(category, ms);
		},
		countSuppressions(category, sinceMs) {
			const row = stmts.countSuppressions.get(category, sinceMs) as { n: number };
			return row.n;
		},
		insertSuppression(category, ms) {
			stmts.insertSuppression.run(category, ms);
		},
		pushInfoEvent(alert) {
			stmts.insertInfo.run(Date.now(), JSON.stringify(alert));
		},
		drainInfoEvents() {
			const rows = stmts.selectInfo.all() as ReadonlyArray<{ payload_json: string }>;
			// cp139 B-1: tolerant parse — see parseInfoRowsTolerantly
			// docstring above for the full rationale.  Net: corrupt
			// row (operator hand-edit, partial-write recovery, bug
			// in a prior version's pushInfoEvent) doesn't throw the
			// drain or block the DELETE.  Loss of one INFO event
			// is acceptable; permanent silent hang of the daily
			// digest is not.
			const events = parseInfoRowsTolerantly(rows);
			stmts.deleteInfo.run();
			return events;
		},
		pruneOlderThan(ms) {
			stmts.pruneSuppressions.run(ms);
			stmts.pruneInfo.run(ms);
		},
		close() {
			db.close();
		}
	};
}
