/**
 * Morphit indexer — federation seed list (Phase D.5).
 *
 * Hardcoded reference instances inserted into known_instances at
 * indexer boot.  Idempotent: ON CONFLICT DO NOTHING means we never
 * overwrite chain-discovered rows or operator manual edits.
 *
 * Purpose: short-circuit chain-replay latency for the canonical
 * reference instance.  A fresh indexer takes hours to fully
 * replay Blurt history; without seeding, /instances shows
 * "no peers known yet" for that whole window even though the
 * canonical instance is reachable right now.
 *
 * Trust model: the seed gives the probe scheduler an origin and
 * the on-chain account that's claimed to operate it.  The probe
 * verifies by hitting `${origin}/v1/instance` and comparing the
 * response's relay_account against operator_account from this
 * seed.  A wrong seed entry would degrade to status='mismatch',
 * not poison the directory — same defense in depth as
 * chain-discovered entries.
 *
 * Operator can override: deleting a seeded row (DELETE FROM
 * known_instances WHERE origin = 'https://morphit.io') is fine
 * — the seed only re-inserts on next boot, but the operator's
 * intent persists if they don't restart, and even a re-insert
 * is harmless (it's just status='never' again until probe runs).
 *
 * To remove a seed permanently, edit this file and submit a PR.
 */

import type { Database } from '$db/pool';
import { logger } from '$log';

const log = logger('federation-seed');

interface Seed {
	readonly origin: string;
	readonly operator_account: string;
}

/** Reference instances seeded into known_instances at boot.
 *  Each entry's operator_account is the on-chain account that
 *  claims to run the origin.  The probe layer cross-verifies. */
const SEEDS: readonly Seed[] = [{ origin: 'https://morphit.io', operator_account: 'morphit' }];

/** Insert seeds into known_instances if not already present.
 *  Called once at indexer boot, after migrations.  Errors are
 *  logged but don't gate indexer startup — seeding is a
 *  convenience, not load-bearing. */
export async function seedFederationDirectory(db: Database): Promise<void> {
	for (const seed of SEEDS) {
		try {
			// We don't have a real registration block for seeds, so we
			// use 0 + the unix epoch.  The probe layer doesn't read
			// these fields for seeds — only for the new-instance
			// grace period, where age=now-registered_at_time.  Using
			// epoch means seeds are NEVER treated as new (no grace
			// period applies), which is correct: morphit.io should
			// pass the orderbook-activity check on its own merits.
			await db.query(
				`INSERT INTO known_instances (
					origin, operator_account,
					registered_at_block, registered_at_time,
					last_probe_status
				) VALUES ($1, $2, 0, '1970-01-01T00:00:00Z', 'never')
				ON CONFLICT (origin) DO NOTHING`,
				[seed.origin, seed.operator_account]
			);
		} catch (err) {
			log.warn('seed_failed', { origin: seed.origin }, err);
		}
	}
	log.info('seeded', { count: SEEDS.length });
}
