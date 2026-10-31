/**
 * Offline notices — opening their store when the relay starts, and again
 * until it opens.
 *
 * The relay may start before the indexer has run the migration that makes a
 * table the store needs (an upgrade restarts both; nothing orders them), or
 * while the database does not answer, or the key file is not back yet. Then
 * offline notices are off — and come on by themselves once the store opens:
 * it is tried again after 5 s, 10 s, 20 s … then every 5 minutes. One calm
 * log line when they are off (and again only when the reason changes), one
 * when they come on.
 */

import type { Database } from '$db/pool';
import type { Logger } from '$log';
import { offeredChannels } from './config.ts';
import type { NotifyConfig } from './config.ts';
import { errorClass } from './dispatch.ts';
import { openSealedStore, type OfflineNotifyStore } from './store.ts';
import { VaultUnavailableError } from './vault.ts';

/** Waits before each new try; the last one repeats. */
export const OPEN_RETRY_MS: readonly number[] = [
	5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000
];

/**
 * The store, or null when there is nothing to open: no channel offered and
 * nothing saved (then nothing is tried again — setting a channel up restarts
 * the relay). Throws when it should open but cannot (yet).
 */
export async function openOfflineNotify(
	db: Database,
	dataDir: string | null,
	cfg: NotifyConfig,
	log: Logger
): Promise<OfflineNotifyStore | null> {
	let wanted = offeredChannels(cfg).length > 0 || Object.keys(cfg.off).length > 0;
	if (!wanted) {
		const r = await db.query<{ any: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM offline_notify_channels)
			     OR EXISTS (SELECT 1 FROM offline_notify_key) AS any`
		);
		wanted = r.rows[0]?.any === true;
	}
	if (!wanted) return null;
	if (dataDir === null)
		throw new VaultUnavailableError('the relay has no state directory (MORPHIT_RELAY_DATA_DIR)');
	const { store, created } = await openSealedStore(db, dataDir);
	if (created) log.info('offline_notify_key_created', { dir: dataDir });
	return store;
}

/** Why it did not open, in words the operator can act on (a path at most,
 *  never a secret): the vault's own sentence, or the kind of error. */
function why(err: unknown): string {
	if (err instanceof VaultUnavailableError) return err.message;
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
		? `${errorClass(err)} (database error ${code})`
		: errorClass(err);
}

/**
 * Open the store now; if it cannot be opened, try again (OPEN_RETRY_MS)
 * until it opens. `onOpen` gets it once. `first` settles after the first
 * try (opened or not). `stop` ends the tries (at shutdown).
 */
export function keepOpening(
	open: () => Promise<OfflineNotifyStore | null>,
	onOpen: (store: OfflineNotifyStore) => void,
	log: Logger,
	delaysMs: readonly number[] = OPEN_RETRY_MS
): { readonly first: Promise<void>; stop(): void } {
	let stopped = false;
	let timer: NodeJS.Timeout | null = null;
	let tries = 0;
	let lastWhy: string | null = null;
	const attempt = async (): Promise<void> => {
		let store: OfflineNotifyStore | null;
		try {
			store = await open();
		} catch (err) {
			if (stopped) return;
			const reason = why(err);
			const wait = delaysMs[Math.min(tries, delaysMs.length - 1)]!;
			tries++;
			if (reason !== lastWhy)
				log.warn('offline_notify_unavailable', {
					hint: `Offline notices are off for now: ${reason}. The relay tries again by itself (next in ${Math.round(wait / 1000)} s).`
				});
			lastWhy = reason;
			timer = setTimeout(() => void attempt(), wait);
			timer.unref();
			return;
		}
		if (stopped || store === null) return;
		if (tries > 0) log.info('offline_notify_on', { after_tries: tries + 1 });
		onOpen(store);
	};
	return {
		first: attempt(),
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		}
	};
}
