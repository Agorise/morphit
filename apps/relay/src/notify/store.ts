/**
 * Offline notices — the database side (tables from indexer migrations v69
 * and v71).
 *
 * Every address and Matrix room goes in and out through the vault (sealed,
 * padded, bound to its account and channel). Codes are looked up by keyed
 * hash; addresses are COUNTED by keyed hash in a table that has no account
 * column, by day only, so no stored value ties two accounts to one address
 * (someone reading the LIVE database could pair rows written in one
 * transaction — keyed hashes, never an address; see schema.sql v69). Nothing
 * here logs an address or a code.
 */

import { randomBytes, randomInt } from 'node:crypto';
import type { Database } from '$db/pool';

/** A transaction's client (what {@link Database.withTx} hands over). */
type Tx = Parameters<Parameters<Database['withTx']>[0]>[0];

/** The account the operator's Matrix test address is kept under: no Blurt
 *  account can be called this (`~` is not allowed in one), so no user's
 *  request can ever name it. */
export const TEST_ACCOUNT = '~operator-test';

/** What the Matrix rooms of offline_notify_matrix_rooms and the queue entries
 *  for them are sealed under (they belong to an address, not to an account;
 *  `~` is not allowed in a Blurt account name either). */
export const ROOM_ACCOUNT = '~matrix-room';

/** Every change to which Matrix addresses the rows hold, and every claim of a
 *  room for one, runs under this lock (taken before any row lock): so a
 *  release and a claim for one address, or two releases, never cross. It is
 *  the lock of these tables, so it is named after their schema (the relay
 *  and its admin tool use the same one; tests in other schemas of one
 *  database do not wait for each other). */
const MATRIX_LOCK = 'offline-notify:matrix-rooms:';
async function lockMatrix(c: Tx): Promise<void> {
	await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || current_schema(), 0))`, [
		MATRIX_LOCK
	]);
}

/** The longest any of this store's transactions waits for a lock ({@link
 *  MATRIX_LOCK} or a row): past it the store throws {@link isLockBusy} — the
 *  API answers 503 `busy` (the page says to try again in a moment), the
 *  worker and the leave queue try again on their next round — rather than
 *  wait without end. No transaction here waits on anything but the database
 *  — never on a homeserver (see leaveIfUnused) — so locks are held for
 *  milliseconds. */
export const LOCK_WAIT_MS = 5_000;

/** The database gave up waiting for a lock (lock_not_available). */
export function isLockBusy(err: unknown): boolean {
	return (err as { code?: unknown } | null)?.code === '55P03';
}

type AddressCols = {
	account: string;
	address_sealed: Buffer | null;
	prev_address_sealed: Buffer | null;
};
import type { MatrixRoomBook } from './channels/matrix.ts';
import { countingKey, type AddressChannel, type Channel } from './addresses.ts';
import { openVault, VaultUnavailableError, type Vault } from './vault.ts';

/** How long a code is good for, and how many wrong tries it survives. */
export const CODE_TTL_MS = 15 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
/** Codes in a (UTC) day, all channels: per account; per account and
 *  address (she is told when she reaches it); and per address, whoever asks
 *  — past that the code is not sent, and she is NOT told, so the answer
 *  never says whether someone else used that address today. */
export const CODES_PER_ACCOUNT_PER_DAY = 6;
export const CODES_PER_ACCOUNT_ADDRESS_PER_DAY = 3;
export const CODES_PER_ADDRESS_PER_DAY = 5;
/** Notices per account in a day (all senders, all channels count once). */
export const NOTICES_PER_DAY = 20;
/** A notice link opens the conversation for this long. */
export const LINK_TTL_MS = 7 * 24 * 60 * 60_000;

export type ChannelState = 'on' | 'pending';
/** Which of the site's addresses her links open (the network she set up from). */
export const LINK_NETS = ['clearnet', 'tor', 'i2p', 'loki'] as const;
export type LinkNet = (typeof LINK_NETS)[number];

export interface VerifiedChannel {
	readonly channel: Channel;
	readonly address: string;
	readonly linkNet: LinkNet;
	/** The confirmed address she had, kept while she changes it. */
	readonly prev: boolean;
}

/** A confirmed address, or the confirmed one she had while she changes it:
 *  notices keep going to it until the new one is confirmed. */
const CONFIRMED = '(verified_at IS NOT NULL OR prev_verified_at IS NOT NULL)';

export interface DueNotice {
	readonly account: string;
	readonly sender: string;
	readonly orderPermlink: string;
	readonly eventAt: Date;
	readonly attempts: number;
}

/** A six-digit code (Telegram: eight, sent to the bot). */
export function newCode(digits: 6 | 8): string {
	return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The store, with the vault the saved addresses were sealed with. The database
 * remembers which key that was (offline_notify_key): a key file that is
 * missing, or is another key, is refused — offline notices stay off and the
 * relay says why — rather than a new key made and every address dropped. A
 * new key is made only when nothing was ever sealed.
 */
export async function openSealedStore(
	db: Database,
	dataDir: string
): Promise<{ store: OfflineNotifyStore; created: boolean }> {
	// Everything this store uses must be there: before the indexer's v71
	// migration has run (an upgrade restarts the relay and the indexer in no
	// set order) this throws before anything is made (42P01 / 42703), and the relay tries again
	// (opening.ts) — notices never half-work on an older schema.
	await db.query(`SELECT address_mac FROM offline_notify_matrix_rooms LIMIT 0`);
	await db.query(`SELECT address_mac FROM offline_notify_leave LIMIT 0`);
	const known = await db.query<{ key_check: Buffer }>(
		`SELECT key_check FROM offline_notify_key WHERE id = 1`
	);
	const expected = known.rows[0]?.key_check ?? null;
	const { vault, created } = openVault(dataDir, { create: expected === null });
	const check = vault.mac('key-check');
	if (expected === null) {
		await db.query(
			`INSERT INTO offline_notify_key (id, key_check) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
			[check]
		);
		const now = await db.query<{ key_check: Buffer }>(
			`SELECT key_check FROM offline_notify_key WHERE id = 1`
		);
		if (!vault.sameMac(now.rows[0]?.key_check, check))
			throw new VaultUnavailableError('another key was recorded at the same moment', 'mismatch');
	} else if (!vault.sameMac(expected, check)) {
		throw new VaultUnavailableError(
			'the offline-notify key file is not the one the saved addresses were sealed with: put the right one back, or start over with `sudo morphit-ops offline-notify`',
			'mismatch'
		);
	}
	const store = new OfflineNotifyStore(db, vault);
	await store.moveOldRooms();
	return { store, created };
}

export class OfflineNotifyStore {
	constructor(
		private readonly db: Database,
		readonly vault: Vault
	) {}

	/** A transaction of this store: none waits longer than {@link LOCK_WAIT_MS}
	 *  for a lock. */
	private tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
		return this.db.withTx(async (c) => {
			await c.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
			return fn(c);
		});
	}

	/**
	 * Run `fn` (statements that may add, change or delete rows) and keep the
	 * Matrix room mapping in step, in the same transaction: an address that a
	 * row matching `where` held before and that NO row of any account holds
	 * after (as its address, or kept aside during a change; the operator's
	 * test address too) is released — its room queued for the bot to leave;
	 * an address a row now holds that was released is taken back — its room
	 * stays. Decided here, in the database, under {@link MATRIX_LOCK}: this is
	 * the one place that lets a room go; every path that changes a row's
	 * address goes through it.
	 */
	private async guardRooms<T>(
		c: Tx,
		where: string,
		params: readonly unknown[],
		fn: () => Promise<T>
	): Promise<T> {
		await lockMatrix(c);
		const cols = 'account, address_sealed, prev_address_sealed';
		const before = await c.query<AddressCols>(
			`SELECT ${cols} FROM offline_notify_channels
			  WHERE channel = 'matrix' AND (${where}) FOR UPDATE`,
			params as unknown[]
		);
		const result = await fn();
		const accounts = [...new Set(before.rows.map((r) => r.account))];
		const after = await c.query<AddressCols>(
			`SELECT ${cols} FROM offline_notify_channels
			  WHERE channel = 'matrix' AND ((${where}) OR account = ANY($${params.length + 1}::text[]))`,
			[...params, accounts]
		);
		const had = this.addressesOf(before.rows);
		const has = this.addressesOf(after.rows);
		for (const a of has) if (!had.has(a)) await this.takeBack(c, a);
		const gone = [...had].filter((a) => !has.has(a));
		if (gone.length > 0) {
			const held = await this.heldAddresses(c);
			for (const a of gone) if (!held.has(a)) await this.release(c, a);
		}
		return result;
	}

	/** The Matrix addresses these rows hold (a value that does not open: none). */
	private addressesOf(rows: readonly AddressCols[]): Set<string> {
		const out = new Set<string>();
		for (const r of rows)
			for (const v of [r.address_sealed, r.prev_address_sealed]) {
				const a = v === null ? null : this.vault.open(v, r.account, 'matrix', 'address');
				if (a !== null) out.add(a);
			}
		return out;
	}

	/** Every Matrix address any row holds now. */
	private async heldAddresses(c: Tx): Promise<Set<string>> {
		const r = await c.query<AddressCols>(
			`SELECT account, address_sealed, prev_address_sealed FROM offline_notify_channels
			  WHERE channel = 'matrix'`
		);
		return this.addressesOf(r.rows);
	}

	/** The keyed hash an address's room is kept under. The same keyed hash
	 *  of the same normalised address as the code limits use, under its own
	 *  label: the mapping cannot be joined with offline_notify_address_log. */
	private roomMac(address: string): Buffer {
		return this.vault.mac('matrix-room', countingKey('matrix', address));
	}

	private openRoom(sealed: Buffer): string | null {
		return this.vault.open(sealed, ROOM_ACCOUNT, 'matrix', 'route');
	}

	/** Queue a room to be left: an address's room (`mac`, left only if no row
	 *  took the address back meanwhile), or one nothing uses (null). */
	private async queueRoom(c: Tx, sealed: Buffer, mac: Buffer | null): Promise<void> {
		await c.query(
			`INSERT INTO offline_notify_leave (route_sealed, account, address_mac) VALUES ($1, $2, $3)
			 ON CONFLICT (route_sealed) DO UPDATE SET address_mac = EXCLUDED.address_mac`,
			[sealed, ROOM_ACCOUNT, mac]
		);
	}

	/** No row holds this address any more: its room goes to the leave queue. */
	private async release(c: Tx, address: string): Promise<void> {
		const mac = this.roomMac(address);
		const r = await c.query<{ room_sealed: Buffer }>(
			`UPDATE offline_notify_matrix_rooms SET released_at = now(), updated_at = now()
			  WHERE address_mac = $1 AND released_at IS NULL RETURNING room_sealed`,
			[mac]
		);
		const room = r.rows[0]?.room_sealed;
		if (room !== undefined) await this.queueRoom(c, room, mac);
	}

	/** A row holds this address again: its room, if not left yet, stays. */
	private async takeBack(c: Tx, address: string): Promise<void> {
		await c.query(
			`UPDATE offline_notify_matrix_rooms SET released_at = NULL, updated_at = now()
			  WHERE address_mac = $1 AND released_at IS NOT NULL`,
			[this.roomMac(address)]
		);
	}

	/**
	 * Where each Matrix address's one room is kept (channels/matrix.ts sends
	 * with it). A room is claimed for an address only if the mapping still
	 * holds what the sender read, and only while a row holds the address.
	 */
	matrixRoomBook(): MatrixRoomBook {
		return {
			get: async (userId) => {
				const r = await this.db.query<{ room_sealed: Buffer; bot_only_invites: boolean }>(
					`SELECT room_sealed, bot_only_invites FROM offline_notify_matrix_rooms
					  WHERE address_mac = $1`,
					[this.roomMac(userId)]
				);
				const row = r.rows[0];
				const room = row ? this.openRoom(row.room_sealed) : null;
				return row && room !== null
					? { room, version: row.room_sealed, botOnly: row.bot_only_invites }
					: null;
			},
			claim: (userId, version, room) =>
				this.tx(async (c) => {
					await lockMatrix(c);
					const mac = this.roomMac(userId);
					const sealed = this.vault.seal(room, ROOM_ACCOUNT, 'matrix', 'route');
					// A send that came too late (no row holds the address any
					// more): its room is not kept.
					if (!(await this.heldAddresses(c)).has(userId)) {
						await this.queueRoom(c, sealed, null);
						return null;
					}
					const cur = await c.query<{ room_sealed: Buffer; bot_only_invites: boolean }>(
						`SELECT room_sealed, bot_only_invites FROM offline_notify_matrix_rooms
						  WHERE address_mac = $1 FOR UPDATE`,
						[mac]
					);
					const row = cur.rows[0];
					const curRoom = row ? this.openRoom(row.room_sealed) : null;
					const stillWhatWasRead =
						row === undefined ||
						curRoom === null ||
						(version !== null && row.room_sealed.equals(version));
					if (!stillWhatWasRead) {
						// Another sender claimed one first: theirs is hers; the
						// one just opened goes.
						await this.queueRoom(c, sealed, null);
						return { room: curRoom!, botOnly: row!.bot_only_invites, won: false };
					}
					if (row === undefined)
						await c.query(
							`INSERT INTO offline_notify_matrix_rooms (address_mac, room_sealed, bot_only_invites)
							 VALUES ($1, $2, TRUE)`,
							[mac, sealed]
						);
					else {
						await c.query(
							`UPDATE offline_notify_matrix_rooms
							    SET room_sealed = $2, bot_only_invites = TRUE, released_at = NULL, updated_at = now()
							  WHERE address_mac = $1`,
							[mac, sealed]
						);
						// The room it replaces could not be used any more: left.
						if (curRoom !== null) await this.queueRoom(c, row.room_sealed, null);
					}
					return { room, botOnly: true, won: true };
				})
		};
	}

	/**
	 * Rooms older versions kept on each row (route_sealed): moved into the
	 * mapping, one room per address — the one of the row confirmed last, or a
	 * room the mapping has already — and the rest queued to leave; the rows
	 * keep none. A queue entry for a room that is now an address's room is
	 * dropped. Runs whenever the store opens; does nothing once done.
	 */
	async moveOldRooms(): Promise<{ moved: number; queued: number }> {
		return this.tx(async (c) => {
			await lockMatrix(c);
			const r = await c.query<{
				account: string;
				address_sealed: Buffer | null;
				route_sealed: Buffer | null;
				at: Date;
				prev_address_sealed: Buffer | null;
				prev_route_sealed: Buffer | null;
				prev_at: Date;
			}>(
				`SELECT account, address_sealed, route_sealed, COALESCE(verified_at, created_at) AS at,
				        prev_address_sealed, prev_route_sealed, COALESCE(prev_verified_at, created_at) AS prev_at
				   FROM offline_notify_channels
				  WHERE channel = 'matrix' AND (route_sealed IS NOT NULL OR prev_route_sealed IS NOT NULL)
				  FOR UPDATE`
			);
			if (r.rows.length === 0) return { moved: 0, queued: 0 };
			const byAddress = new Map<string, Array<{ room: string; at: number }>>();
			const strays: Array<{ room: string }> = [];
			for (const x of r.rows)
				for (const [a, rt, at] of [
					[x.address_sealed, x.route_sealed, x.at],
					[x.prev_address_sealed, x.prev_route_sealed, x.prev_at]
				] as const) {
					if (rt === null) continue;
					const room = this.vault.open(rt, x.account, 'matrix', 'route');
					if (room === null) continue;
					const address = a === null ? null : this.vault.open(a, x.account, 'matrix', 'address');
					if (address === null) strays.push({ room });
					else
						byAddress.set(address, [...(byAddress.get(address) ?? []), { room, at: at.getTime() }]);
				}
			let moved = 0;
			let queued = 0;
			const kept = new Set<string>();
			for (const [address, rooms] of byAddress) {
				const mac = this.roomMac(address);
				const cur = await c.query<{ room_sealed: Buffer }>(
					`SELECT room_sealed FROM offline_notify_matrix_rooms WHERE address_mac = $1`,
					[mac]
				);
				let keep = cur.rows[0] ? this.openRoom(cur.rows[0].room_sealed) : null;
				if (keep === null) {
					keep = [...rooms].sort((p, q) => q.at - p.at)[0]!.room;
					await c.query(
						`INSERT INTO offline_notify_matrix_rooms (address_mac, room_sealed, bot_only_invites)
						 VALUES ($1, $2, FALSE)
						 ON CONFLICT (address_mac) DO UPDATE SET room_sealed = EXCLUDED.room_sealed,
						   bot_only_invites = FALSE, released_at = NULL, updated_at = now()`,
						[mac, this.vault.seal(keep, ROOM_ACCOUNT, 'matrix', 'route')]
					);
					moved++;
				}
				kept.add(keep);
				for (const { room } of rooms)
					if (room !== keep && !kept.has(room)) {
						await this.queueRoom(c, this.vault.seal(room, ROOM_ACCOUNT, 'matrix', 'route'), null);
						queued++;
					}
			}
			for (const { room } of strays)
				if (!kept.has(room)) {
					await this.queueRoom(c, this.vault.seal(room, ROOM_ACCOUNT, 'matrix', 'route'), null);
					queued++;
				}
			await c.query(
				`UPDATE offline_notify_channels SET route_sealed = NULL, prev_route_sealed = NULL
				  WHERE channel = 'matrix' AND (route_sealed IS NOT NULL OR prev_route_sealed IS NOT NULL)`
			);
			// An older queue entry for a room that is an address's room now.
			const q = await c.query<{ route_sealed: Buffer; account: string }>(
				`SELECT route_sealed, account FROM offline_notify_leave WHERE address_mac IS NULL`
			);
			for (const e of q.rows) {
				const room = this.vault.open(e.route_sealed, e.account, 'matrix', 'route');
				if (room !== null && kept.has(room))
					await c.query(`DELETE FROM offline_notify_leave WHERE route_sealed = $1`, [
						e.route_sealed
					]);
			}
			return { moved, queued };
		});
	}

	async status(account: string): Promise<{
		channels: Array<{ channel: Channel; state: ChannelState }>;
		locale: string | null;
	}> {
		const r = await this.db.query<{ channel: Channel; verified: boolean; locale: string }>(
			`SELECT channel, verified_at IS NOT NULL AS verified, locale
			   FROM offline_notify_channels WHERE account = $1 ORDER BY channel`,
			[account]
		);
		return {
			channels: r.rows.map((x) => ({ channel: x.channel, state: x.verified ? 'on' : 'pending' })),
			locale: r.rows[0]?.locale ?? null
		};
	}

	/**
	 * Keep the address she typed, unverified, with a fresh code — if the limits
	 * allow one more code today, for this account and for this address. The
	 * check and the record are one transaction under locks on both, so requests
	 * sent all at once cannot slip past the limits. Until she types the code,
	 * this channel sends nothing. A confirmed address she had is kept aside
	 * (prev_*, still sealed) until the new one is confirmed, and put back if the
	 * change is cancelled or its code cannot be sent, expires or is guessed
	 * wrong five times ({@link restoreOrDrop}). Its Matrix room moves aside
	 * with it; a room no column holds any more is queued for the bot to leave
	 * (offline_notify_leave, {@link guardRooms}).
	 */
	async beginAddress(
		account: string,
		channel: AddressChannel,
		address: string,
		locale: string,
		code: string,
		linkNet: LinkNet,
		now: Date
	): Promise<{ ok: false } | { ok: true; codeMac: Buffer; send: boolean }> {
		const key = countingKey(channel, address);
		const addressMac = this.vault.mac('address', channel, key);
		// Her own count for this address, in the same table under another keyed
		// hash: no account is written next to an address.
		const pairMac = this.vault.mac('address-by', account, channel, key);
		const today = day(now);
		return this.tx(async (c) => {
			await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
				`offline-notify:account:${account}`
			]);
			await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
				`offline-notify:address:${addressMac.toString('hex')}`
			]);
			const counts = await c.query<{ by_account: string; by_pair: string; by_address: string }>(
				`SELECT (SELECT count(*) FROM offline_notify_code_log
				          WHERE account = $1 AND sent_on = $3::date)::text AS by_account,
				        (SELECT COALESCE(sum(sent), 0) FROM offline_notify_address_log
				          WHERE address_mac = $4 AND sent_on = $3::date)::text AS by_pair,
				        (SELECT COALESCE(sum(sent), 0) FROM offline_notify_address_log
				          WHERE address_mac = $2 AND sent_on = $3::date)::text AS by_address`,
				[account, addressMac, today, pairMac]
			);
			const n = counts.rows[0];
			if (
				Number(n?.by_account ?? 0) >= CODES_PER_ACCOUNT_PER_DAY ||
				Number(n?.by_pair ?? 0) >= CODES_PER_ACCOUNT_ADDRESS_PER_DAY
			)
				return { ok: false };
			const send = Number(n?.by_address ?? 0) < CODES_PER_ADDRESS_PER_DAY;
			const codeMac = this.vault.mac('code', account, channel, code);
			await this.guardRooms(c, 'account = $1 AND channel = $2', [account, channel], () =>
				c.query(
					`INSERT INTO offline_notify_channels
				   (account, channel, address_sealed, route_sealed, verified_at,
				    code_mac, code_expires_at, code_attempts, locale, link_net)
				 VALUES ($1, $2, $3, NULL, NULL, $4, $5, 0, $6, $7)
				 ON CONFLICT (account, channel) DO UPDATE SET
				   prev_address_sealed = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
				       THEN offline_notify_channels.address_sealed ELSE offline_notify_channels.prev_address_sealed END,
				   prev_route_sealed = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
				       THEN offline_notify_channels.route_sealed ELSE offline_notify_channels.prev_route_sealed END,
				   prev_verified_at = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
				       THEN offline_notify_channels.verified_at ELSE offline_notify_channels.prev_verified_at END,
				   prev_link_net = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
				       THEN offline_notify_channels.link_net ELSE offline_notify_channels.prev_link_net END,
				   address_sealed = EXCLUDED.address_sealed, route_sealed = NULL, verified_at = NULL,
				   code_mac = EXCLUDED.code_mac, code_expires_at = EXCLUDED.code_expires_at,
				   code_attempts = 0, locale = EXCLUDED.locale, link_net = EXCLUDED.link_net`,
					[
						account,
						channel,
						this.vault.seal(address, account, channel, 'address'),
						codeMac,
						new Date(now.getTime() + CODE_TTL_MS),
						locale,
						linkNet
					]
				)
			);
			await c.query(
				`INSERT INTO offline_notify_code_log (account, sent_on) VALUES ($1, $2::date)`,
				[account, today]
			);
			for (const mac of send ? [pairMac, addressMac] : [pairMac])
				await c.query(
					`INSERT INTO offline_notify_address_log (address_mac, sent_on, sent) VALUES ($1, $2::date, 1)
					 ON CONFLICT (address_mac, sent_on) DO UPDATE SET sent = offline_notify_address_log.sent + 1`,
					[mac, today]
				);
			// One language per account: the latest she chose.
			await c.query(`UPDATE offline_notify_channels SET locale = $2 WHERE account = $1`, [
				account,
				locale
			]);
			return { ok: true, codeMac, send };
		});
	}

	/**
	 * A change that will not be confirmed (cancelled; its code could not be
	 * sent, expired, or was guessed wrong five times): the confirmed address
	 * she had before goes back exactly as it was (still sealed — nothing is
	 * opened here), or, when there was none, the waiting one goes. With
	 * `codeMac`, only while the row still waits for THAT code (a newer request
	 * since then is left alone). Returns 'restored', 'dropped' or 'none'.
	 */
	async restoreOrDrop(
		account: string,
		channel: Channel,
		codeMac: Buffer | null = null,
		tx: Tx | null = null
	): Promise<'restored' | 'dropped' | 'none'> {
		const run = async (c: Tx): Promise<'restored' | 'dropped' | 'none'> =>
			this.guardRooms(c, 'account = $1 AND channel = $2', [account, channel], async () => {
				const back = await c.query(
					`UPDATE offline_notify_channels
					    SET address_sealed = prev_address_sealed, route_sealed = prev_route_sealed,
					        verified_at = prev_verified_at, link_net = prev_link_net,
					        prev_address_sealed = NULL, prev_route_sealed = NULL,
					        prev_verified_at = NULL, prev_link_net = NULL,
					        code_mac = NULL, code_expires_at = NULL, code_attempts = 0
					  WHERE account = $1 AND channel = $2 AND verified_at IS NULL
					    AND prev_verified_at IS NOT NULL AND ($3::bytea IS NULL OR code_mac = $3)`,
					[account, channel, codeMac]
				);
				if ((back.rowCount ?? 0) > 0) return 'restored';
				const gone = await c.query(
					`DELETE FROM offline_notify_channels
					  WHERE account = $1 AND channel = $2 AND verified_at IS NULL
					    AND ($3::bytea IS NULL OR code_mac = $3)`,
					[account, channel, codeMac]
				);
				return (gone.rowCount ?? 0) > 0 ? 'dropped' : 'none';
			});
		return tx !== null ? run(tx) : this.tx(run);
	}

	/**
	 * Telegram: a code she sends to the bot (unique among the waiting ones), or
	 * null when this account asked for too many codes today.
	 */
	async beginTelegram(
		account: string,
		locale: string,
		linkNet: LinkNet,
		now: Date
	): Promise<string | null> {
		const today = day(now);
		return this.tx(async (c) => {
			await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
				`offline-notify:account:${account}`
			]);
			const n = await c.query<{ n: string }>(
				`SELECT count(*)::text AS n FROM offline_notify_code_log WHERE account = $1 AND sent_on = $2::date`,
				[account, today]
			);
			if (Number(n.rows[0]?.n ?? 0) >= CODES_PER_ACCOUNT_PER_DAY) return null;
			for (let i = 0; i < 5; i++) {
				const code = newCode(8);
				const mac = this.vault.mac('telegram-code', code);
				const clash = await c.query(
					`SELECT 1 FROM offline_notify_channels WHERE channel = 'telegram' AND code_mac = $1 AND code_expires_at > $2`,
					[mac, now]
				);
				if ((clash.rowCount ?? 0) > 0) continue;
				await c.query(
					`INSERT INTO offline_notify_channels
					   (account, channel, address_sealed, route_sealed, verified_at,
					    code_mac, code_expires_at, code_attempts, locale, link_net)
					 VALUES ($1, 'telegram', NULL, NULL, NULL, $2, $3, 0, $4, $5)
					 ON CONFLICT (account, channel) DO UPDATE SET
					   prev_address_sealed = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
					       THEN offline_notify_channels.address_sealed ELSE offline_notify_channels.prev_address_sealed END,
					   prev_route_sealed = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
					       THEN offline_notify_channels.route_sealed ELSE offline_notify_channels.prev_route_sealed END,
					   prev_verified_at = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
					       THEN offline_notify_channels.verified_at ELSE offline_notify_channels.prev_verified_at END,
					   prev_link_net = CASE WHEN offline_notify_channels.verified_at IS NOT NULL
					       THEN offline_notify_channels.link_net ELSE offline_notify_channels.prev_link_net END,
					   address_sealed = NULL, route_sealed = NULL, verified_at = NULL,
					   code_mac = EXCLUDED.code_mac, code_expires_at = EXCLUDED.code_expires_at,
					   code_attempts = 0, locale = EXCLUDED.locale, link_net = EXCLUDED.link_net`,
					[account, mac, new Date(now.getTime() + CODE_TTL_MS), locale, linkNet]
				);
				await c.query(
					`INSERT INTO offline_notify_code_log (account, sent_on) VALUES ($1, $2::date)`,
					[account, today]
				);
				await c.query(`UPDATE offline_notify_channels SET locale = $2 WHERE account = $1`, [
					account,
					locale
				]);
				return code;
			}
			throw new Error('could not draw a free Telegram code');
		});
	}

	/** Is any Telegram code waiting (so the bot must be polled)? */
	async telegramCodeWaiting(now: Date): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM offline_notify_channels WHERE channel = 'telegram' AND verified_at IS NULL AND code_expires_at > $1 LIMIT 1`,
			[now]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/**
	 * Telegram: `code` arrived from `chatId` in a message sent at `sentAt`.
	 * Links the chat when a code matches that was waiting when the message was
	 * sent (a guess sent before the code existed never counts); returns her
	 * account and language, or null.
	 */
	async linkTelegram(
		code: string,
		chatId: string,
		sentAt: Date,
		now: Date
	): Promise<{ account: string; locale: string } | null> {
		const mac = this.vault.mac('telegram-code', code);
		const r = await this.db.query<{ account: string; locale: string }>(
			`SELECT account, locale FROM offline_notify_channels
			  WHERE channel = 'telegram' AND verified_at IS NULL AND code_mac = $1 AND code_expires_at > $2
			    AND code_expires_at - ($4::text || ' milliseconds')::interval <= $3`,
			[mac, now, sentAt, String(CODE_TTL_MS)]
		);
		const row = r.rows[0];
		if (!row) return null;
		await this.db.query(
			`UPDATE offline_notify_channels
			    SET address_sealed = $3, verified_at = $4,
			        code_mac = NULL, code_expires_at = NULL, code_attempts = 0,
			        prev_address_sealed = NULL, prev_route_sealed = NULL,
			        prev_verified_at = NULL, prev_link_net = NULL
			  WHERE account = $1 AND channel = $2`,
			[row.account, 'telegram', this.vault.seal(chatId, row.account, 'telegram', 'address'), now]
		);
		return row;
	}

	/** Check a code she typed. Row-locked: tries sent at once count one by one. */
	async verifyCode(
		account: string,
		channel: Channel,
		code: string,
		now: Date
	): Promise<'verified' | 'wrong' | 'expired' | 'none'> {
		return this.tx(async (c) => {
			// Before the row lock below, as every path that may change which
			// Matrix addresses rows hold (guardRooms) takes it: no deadlock.
			await lockMatrix(c);
			const r = await c.query<{
				code_mac: Buffer | null;
				code_expires_at: Date | null;
				code_attempts: number;
				verified: boolean;
			}>(
				`SELECT code_mac, code_expires_at, code_attempts, verified_at IS NOT NULL AS verified
				   FROM offline_notify_channels WHERE account = $1 AND channel = $2 FOR UPDATE`,
				[account, channel]
			);
			const row = r.rows[0];
			if (!row || row.verified || row.code_mac === null || row.code_expires_at === null)
				return 'none';
			if (
				row.code_expires_at.getTime() <= now.getTime() ||
				row.code_attempts >= CODE_MAX_ATTEMPTS
			) {
				// The address she had before (if any) comes back.
				await this.restoreOrDrop(account, channel, null, c);
				return 'expired';
			}
			if (!this.vault.sameMac(row.code_mac, this.vault.mac('code', account, channel, code))) {
				const left = CODE_MAX_ATTEMPTS - row.code_attempts - 1;
				if (left <= 0) {
					await this.restoreOrDrop(account, channel, null, c);
					return 'expired';
				}
				await c.query(
					`UPDATE offline_notify_channels SET code_attempts = code_attempts + 1 WHERE account = $1 AND channel = $2`,
					[account, channel]
				);
				return 'wrong';
			}
			// Confirmed: the address she had before is let go (its room too).
			await this.guardRooms(c, 'account = $1 AND channel = $2', [account, channel], () =>
				c.query(
					`UPDATE offline_notify_channels
					    SET verified_at = $3, code_mac = NULL, code_expires_at = NULL, code_attempts = 0,
					        prev_address_sealed = NULL, prev_route_sealed = NULL,
					        prev_verified_at = NULL, prev_link_net = NULL
					  WHERE account = $1 AND channel = $2`,
					[account, channel, now]
				)
			);
			return 'verified';
		});
	}

	/**
	 * Forget one channel, or everything ('all'): addresses, and with the last
	 * one her waiting notices and links. Her Matrix room goes
	 * to the leave queue ({@link guardRooms}, for every deleted row).
	 */
	async remove(account: string, channel: Channel | 'all'): Promise<void> {
		await this.tx(async (c) => {
			const where = channel === 'all' ? 'account = $1' : 'account = $1 AND channel = $2';
			const params = channel === 'all' ? [account] : [account, channel];
			await this.guardRooms(c, where, params, () =>
				c.query(`DELETE FROM offline_notify_channels WHERE ${where}`, params)
			);
			const left = await c.query(
				`SELECT 1 FROM offline_notify_channels WHERE account = $1 LIMIT 1`,
				[account]
			);
			if ((left.rowCount ?? 0) === 0) {
				await c.query(`DELETE FROM offline_notify_pending WHERE account = $1`, [account]);
				await c.query(`DELETE FROM offline_notify_links WHERE account = $1`, [account]);
				// Not her code count: it holds the day only, goes tomorrow, and
				// is the daily limit — deleting it would let anyone send codes
				// without end by removing and setting again.
			}
		});
	}

	/**
	 * Matrix rooms due to be left, claimed for ten minutes (two relays never
	 * leave the same room at once). A room that does not open (damaged, or
	 * another key) comes back as null: nothing can be done with it.
	 * `addressMac`: the address whose room it is (null: a room nothing uses).
	 */
	async claimLeaves(
		limit: number,
		now: Date
	): Promise<
		Array<{
			key: Buffer;
			tries: number;
			account: string;
			room: string | null;
			addressMac: Buffer | null;
		}>
	> {
		const r = await this.db.query<{
			route_sealed: Buffer;
			account: string;
			tries: number;
			address_mac: Buffer | null;
		}>(
			`UPDATE offline_notify_leave SET next_at = $2
			  WHERE route_sealed IN (
			          SELECT route_sealed FROM offline_notify_leave WHERE next_at <= $1
			           ORDER BY next_at LIMIT $3 FOR UPDATE SKIP LOCKED)
			 RETURNING route_sealed, account, tries, address_mac`,
			[now, new Date(now.getTime() + 10 * 60_000), limit]
		);
		return r.rows.map((x) => ({
			key: x.route_sealed,
			tries: x.tries,
			account: x.account,
			room: this.vault.open(x.route_sealed, x.account, 'matrix', 'route'),
			addressMac: x.address_mac
		}));
	}

	/**
	 * Leave a claimed room if nothing uses it. No transaction (and no lock) is
	 * held while the homeserver answers — that may take minutes, and the
	 * relay has a handful of database connections:
	 *   1. a short transaction decides: an address's room that a row took back
	 *      meanwhile is kept (off the queue, the bot stays); otherwise the room
	 *      is taken OUT of the mapping, so from then on no row can take it back
	 *      (a row that sets the address again gets a new room);
	 *   2. `leave` runs;
	 *   3. left: off the queue. Not left (`leave` threw): the room goes back
	 *      into the mapping (unless a newer room was claimed meanwhile) — kept,
	 *      off the queue, if a row holds the address again by now, else still
	 *      released, and the error goes to the caller (tried again later).
	 */
	async leaveIfUnused(
		item: {
			readonly key: Buffer;
			readonly room: string | null;
			readonly addressMac: Buffer | null;
		},
		leave: (room: string) => Promise<void>
	): Promise<'left' | 'kept'> {
		const room = item.room;
		const drop = `DELETE FROM offline_notify_leave WHERE route_sealed = $1`;
		const dropEntry = (c: Tx) => c.query(drop, [item.key]);
		if (room === null) {
			await this.db.query(drop, [item.key]);
			return 'kept';
		}
		const mac = item.addressMac;
		const taken = await this.tx(async (c) => {
			if (mac === null) return { kept: false, mapping: null };
			const m = await c.query<{
				room_sealed: Buffer;
				released: boolean;
				bot_only_invites: boolean;
			}>(
				`SELECT room_sealed, released_at IS NOT NULL AS released, bot_only_invites
				   FROM offline_notify_matrix_rooms WHERE address_mac = $1 FOR UPDATE`,
				[mac]
			);
			const row = m.rows[0];
			if (row === undefined || this.openRoom(row.room_sealed) !== room)
				return { kept: false, mapping: null };
			if (!row.released) {
				await dropEntry(c);
				return { kept: true, mapping: null };
			}
			await c.query(`DELETE FROM offline_notify_matrix_rooms WHERE address_mac = $1`, [mac]);
			return { kept: false, mapping: row };
		});
		if (taken.kept) return 'kept';
		try {
			await leave(room);
		} catch (err) {
			const mapping = taken.mapping;
			if (mac === null || mapping === null) throw err;
			const kept = await this.tx(async (c) => {
				await lockMatrix(c);
				const held = [...(await this.heldAddresses(c))].some((a) => this.roomMac(a).equals(mac));
				const back = await c.query(
					`INSERT INTO offline_notify_matrix_rooms (address_mac, room_sealed, bot_only_invites, released_at)
					 VALUES ($1, $2, $3, CASE WHEN $4 THEN NULL ELSE now() END)
					 ON CONFLICT (address_mac) DO NOTHING`,
					[mac, mapping.room_sealed, mapping.bot_only_invites, held]
				);
				if (held && (back.rowCount ?? 0) > 0) {
					await dropEntry(c);
					return true;
				}
				return false;
			});
			if (kept) return 'kept';
			throw err;
		}
		await this.db.query(drop, [item.key]);
		return 'left';
	}

	/** The rooms the mapping keeps (for tests and the operator's counts). */
	async matrixRoomCount(): Promise<{ rooms: number; released: number }> {
		const r = await this.db.query<{ rooms: number; released: number }>(
			`SELECT count(*)::int AS rooms, count(released_at)::int AS released
			   FROM offline_notify_matrix_rooms`
		);
		return r.rows[0] ?? { rooms: 0, released: 0 };
	}

	/**
	 * The operator's Matrix test note (`sudo morphit-ops offline-notify`): the
	 * address it goes to is kept as a row of {@link TEST_ACCOUNT} (sealed, like
	 * a user's), so its room is held like a user's — the next test note comes
	 * in the same chat, and nothing users do with that address makes the bot
	 * leave it. Only the latest test address is kept (an earlier one is let
	 * go, like any address no row holds); turning Matrix off deletes it with
	 * the rest. Call it BEFORE sending the test note.
	 */
	async holdTestAddress(address: string, now: Date): Promise<void> {
		await this.tx(async (c) => {
			await lockMatrix(c);
			const cur = await c.query<{ address_sealed: Buffer | null }>(
				`SELECT address_sealed FROM offline_notify_channels
				  WHERE account = $1 AND channel = 'matrix' FOR UPDATE`,
				[TEST_ACCOUNT]
			);
			const a = cur.rows[0]?.address_sealed;
			if (a != null && this.vault.open(a, TEST_ACCOUNT, 'matrix', 'address') === address) return;
			await this.guardRooms(c, 'account = $1', [TEST_ACCOUNT], () =>
				c.query(
					`INSERT INTO offline_notify_channels (account, channel, address_sealed, verified_at)
					 VALUES ($1, 'matrix', $2, $3)
					 ON CONFLICT (account, channel) DO UPDATE SET
					   address_sealed = EXCLUDED.address_sealed, route_sealed = NULL,
					   verified_at = EXCLUDED.verified_at, code_mac = NULL, code_expires_at = NULL,
					   prev_address_sealed = NULL, prev_route_sealed = NULL,
					   prev_verified_at = NULL, prev_link_net = NULL`,
					[TEST_ACCOUNT, this.vault.seal(address, TEST_ACCOUNT, 'matrix', 'address'), now]
				)
			);
		});
	}

	/** The leave was given up: off the queue, and an address's room that no
	 *  row took back is no longer kept with that address either (the bot is
	 *  still in it on its homeserver; nothing here names it any more). */
	async leaveDone(item: {
		readonly key: Buffer;
		readonly room: string | null;
		readonly addressMac: Buffer | null;
	}): Promise<void> {
		await this.tx(async (c) => {
			if (item.addressMac !== null && item.room !== null) {
				const m = await c.query<{ room_sealed: Buffer }>(
					`SELECT room_sealed FROM offline_notify_matrix_rooms
					  WHERE address_mac = $1 AND released_at IS NOT NULL FOR UPDATE`,
					[item.addressMac]
				);
				const row = m.rows[0];
				if (row !== undefined && this.openRoom(row.room_sealed) === item.room)
					await c.query(`DELETE FROM offline_notify_matrix_rooms WHERE address_mac = $1`, [
						item.addressMac
					]);
			}
			await c.query(`DELETE FROM offline_notify_leave WHERE route_sealed = $1`, [item.key]);
		});
	}

	/** The homeserver did not answer: try again later. */
	async leaveLater(key: Buffer, tries: number, at: Date): Promise<void> {
		await this.db.query(
			`UPDATE offline_notify_leave SET tries = $2, next_at = $3 WHERE route_sealed = $1`,
			[key, tries, at]
		);
	}

	/** Has this account at least one verified address? */
	async hasVerified(account: string): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM offline_notify_channels WHERE account = $1 AND ${CONFIRMED} LIMIT 1`,
			[account]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/** Her confirmed addresses, opened — during a change, the one she had.
	 *  A confirmed value that does not open (damaged) is skipped and its row
	 *  removed: she sets it again. */
	async verifiedChannels(
		account: string
	): Promise<{ channels: VerifiedChannel[]; locale: string }> {
		const r = await this.db.query<{
			channel: Channel;
			verified: boolean;
			address_sealed: Buffer | null;
			link_net: LinkNet;
			prev_address_sealed: Buffer | null;
			prev_link_net: LinkNet | null;
			locale: string;
		}>(
			`SELECT channel, verified_at IS NOT NULL AS verified, address_sealed, link_net,
			        prev_address_sealed, prev_link_net, locale
			   FROM offline_notify_channels
			  WHERE account = $1 AND ${CONFIRMED} ORDER BY channel`,
			[account]
		);
		const out: VerifiedChannel[] = [];
		for (const row of r.rows) {
			const prev = !row.verified;
			const sealed = prev ? row.prev_address_sealed : row.address_sealed;
			const address = sealed ? this.vault.open(sealed, account, row.channel, 'address') : null;
			if (address === null || sealed === null) {
				// A damaged confirmed address goes; a damaged one kept aside
				// during a change is simply not used.
				if (!prev)
					await this.tx((c) =>
						this.guardRooms(c, 'account = $1 AND channel = $2', [account, row.channel], () =>
							c.query(`DELETE FROM offline_notify_channels WHERE account = $1 AND channel = $2`, [
								account,
								row.channel
							])
						)
					);
				continue;
			}
			out.push({
				channel: row.channel,
				address,
				linkNet: (prev ? row.prev_link_net : row.link_net) ?? row.link_net,
				prev
			});
		}
		return { channels: out, locale: r.rows[0]?.locale ?? 'en' };
	}

	/** Count one notice against today's cap; false when the cap is reached. */
	async takeDailySlot(account: string, now: Date): Promise<boolean> {
		// The count lives on her first CONFIRMED address: a row still waiting
		// for its code comes and goes (cancelled, expired) and would take the
		// count with it.
		const r = await this.db.query<{ n: number }>(
			`UPDATE offline_notify_channels
			    SET sent_count = CASE WHEN sent_day = $2::date THEN sent_count + 1 ELSE 1 END,
			        sent_day = $2::date
			  WHERE account = $1 AND channel = (
			          SELECT min(channel) FROM offline_notify_channels
			           WHERE account = $1 AND ${CONFIRMED})
			    AND (sent_day IS DISTINCT FROM $2::date OR sent_count < $3)
			 RETURNING sent_count AS n`,
			[account, day(now), NOTICES_PER_DAY]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/** Take (and remove) up to `limit` due messages. Taken before sending, so
	 *  two relays never send the same one; the price, accepted: a relay that
	 *  dies mid-round loses those (at most `limit`) notices — never sends one
	 *  twice. A failed send is put back by the worker ({@link requeue}). */
	async takeDue(limit: number, now: Date): Promise<DueNotice[]> {
		const r = await this.db.query<{
			account: string;
			sender: string;
			order_permlink: string;
			event_at: Date;
			attempts: number;
		}>(
			`DELETE FROM offline_notify_pending
			  WHERE (account, sender, order_permlink) IN (
			          SELECT account, sender, order_permlink FROM offline_notify_pending
			           WHERE due_at <= $1 ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED)
			 RETURNING account, sender, order_permlink, event_at, attempts`,
			[now, limit]
		);
		return r.rows.map((x) => ({
			account: x.account,
			sender: x.sender,
			orderPermlink: x.order_permlink,
			eventAt: x.event_at,
			attempts: x.attempts
		}));
	}

	async requeue(n: DueNotice, due: Date, countAsAttempt = true): Promise<void> {
		// A newer message in the thread may have been queued meanwhile: one row
		// stands for both — the later message's time (what "has she read or
		// replied since" must be measured from) and the retry's count.
		await this.db.query(
			`INSERT INTO offline_notify_pending (account, sender, order_permlink, event_at, due_at, attempts)
			 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (account, sender, order_permlink) DO UPDATE SET
			   event_at = GREATEST(offline_notify_pending.event_at, EXCLUDED.event_at),
			   due_at = LEAST(offline_notify_pending.due_at, EXCLUDED.due_at),
			   attempts = GREATEST(offline_notify_pending.attempts, EXCLUDED.attempts)`,
			[n.account, n.sender, n.orderPermlink, n.eventAt, due, n.attempts + (countAsAttempt ? 1 : 0)]
		);
	}

	/** A notice that reached no app: its link goes, so it does not count as a
	 *  notice she was given (one per thread, strangers one a day). */
	async dropLink(token: string): Promise<void> {
		await this.db.query(`DELETE FROM offline_notify_links WHERE token_hash = $1`, [
			this.vault.mac('link', token)
		]);
	}

	/** Has she blocked `peer` (after the message was queued, say)? */
	async blocked(account: string, peer: string): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM blocks WHERE blocker = $1 AND blocked = $2 AND state = 'blocked' LIMIT 1`,
			[account, peer]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/** Has she written to `peer` (in any thread) since `since`? */
	async repliedSince(account: string, peer: string, since: Date): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM chat_messages WHERE sender = $1 AND recipient = $2 AND created_at > $3 LIMIT 1`,
			[account, peer, since]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/**
	 * Is there a stored (durable, on-chain) message from `peer` to her in this
	 * thread that she has not read or answered yet? Any one, not only the
	 * newest: a queued notice carries its thread's LATEST message time, and a
	 * real unread message must not lose its notice because a later one never
	 * reached the chain (independent review of the audit fixes, finding 6).
	 */
	async unreadStoredFrom(account: string, peer: string, orderPermlink: string): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM chat_messages m
			  WHERE m.sender = $2 AND m.recipient = $1 AND COALESCE(m.order_permlink, '') = $3
			    AND m.created_at > COALESCE((
			          SELECT max(last_read_at) FROM chat_read_state
			           WHERE reader_account = $1 AND peer_account = $2 AND order_permlink IN ($3, '*')),
			          '-infinity'::timestamptz)
			    AND m.created_at > COALESCE((
			          SELECT max(created_at) FROM chat_messages WHERE sender = $1 AND recipient = $2),
			          '-infinity'::timestamptz)
			  LIMIT 1`,
			[account, peer, orderPermlink]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/** Has she ever written to `peer`? */
	async everWrote(account: string, peer: string): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM chat_messages WHERE sender = $1 AND recipient = $2 LIMIT 1`,
			[account, peer]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/** Has she read this thread (or everything from `peer`) up to `at`? */
	async readSince(
		account: string,
		peer: string,
		orderPermlink: string,
		at: Date
	): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM chat_read_state
			  WHERE reader_account = $1 AND peer_account = $2 AND order_permlink IN ($3, '*')
			    AND last_read_at >= $4 LIMIT 1`,
			[account, peer, orderPermlink, at]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/**
	 * Was she already sent a notice about this thread that she has not acted
	 * on — sent after she last read it and after she last wrote to `peer`?
	 * Then a new message in it needs no second notice: one per thread until
	 * she looks.
	 */
	async alreadyNoticed(account: string, peer: string, orderPermlink: string): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM offline_notify_links l
			  WHERE l.account = $1 AND l.peer = $2 AND l.order_permlink = $3
			    AND l.created_at > COALESCE((
			          SELECT max(last_read_at) FROM chat_read_state
			           WHERE reader_account = $1 AND peer_account = $2 AND order_permlink IN ($3, '*')),
			          '-infinity'::timestamptz)
			    AND l.created_at > COALESCE((
			          SELECT max(created_at) FROM chat_messages WHERE sender = $1 AND recipient = $2),
			          '-infinity'::timestamptz)
			  LIMIT 1`,
			[account, peer, orderPermlink]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/** Was she sent a notice about `peer` since `since`? */
	async noticedSince(account: string, peer: string, since: Date): Promise<boolean> {
		const r = await this.db.query(
			`SELECT 1 FROM offline_notify_links WHERE account = $1 AND peer = $2 AND created_at > $3 LIMIT 1`,
			[account, peer, since]
		);
		return (r.rowCount ?? 0) > 0;
	}

	/** A fresh link token for (account, peer, thread); only its hash is kept. */
	async createLink(
		account: string,
		peer: string,
		orderPermlink: string,
		now: Date
	): Promise<string> {
		const token = randomBytes(18).toString('base64url');
		await this.db.query(
			`INSERT INTO offline_notify_links (token_hash, account, peer, order_permlink, created_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				this.vault.mac('link', token),
				account,
				peer,
				orderPermlink,
				now,
				new Date(now.getTime() + LINK_TTL_MS)
			]
		);
		return token;
	}

	/** The conversation a link opens, for the account it was sent to only. */
	async resolveLink(
		account: string,
		token: string,
		now: Date
	): Promise<{ peer: string; orderPermlink: string } | null> {
		const r = await this.db.query<{ peer: string; order_permlink: string }>(
			`SELECT peer, order_permlink FROM offline_notify_links
			  WHERE token_hash = $1 AND account = $2 AND expires_at > $3`,
			[this.vault.mac('link', token), account, now]
		);
		const row = r.rows[0];
		return row ? { peer: row.peer, orderPermlink: row.order_permlink } : null;
	}

	/** Remove what has run its course. */
	async purge(now: Date): Promise<void> {
		const today = day(now);
		await this.db.query(`DELETE FROM offline_notify_code_log WHERE sent_on < $1::date`, [today]);
		await this.db.query(`DELETE FROM offline_notify_address_log WHERE sent_on < $1::date`, [today]);
		await this.db.query(`DELETE FROM offline_notify_links WHERE expires_at < $1`, [now]);
		// A message that could not be announced within a day is not announced.
		await this.db.query(`DELETE FROM offline_notify_pending WHERE event_at < $1`, [
			new Date(now.getTime() - 24 * 60 * 60_000)
		]);
		// Codes nobody typed: a change gives back the address she had; a new
		// address goes (with what it held).
		const expired = 'verified_at IS NULL AND (code_expires_at IS NULL OR code_expires_at < $1)';
		await this.tx((c) =>
			this.guardRooms(c, expired, [now], async () => {
				await c.query(
					`UPDATE offline_notify_channels
			    SET address_sealed = prev_address_sealed, route_sealed = prev_route_sealed,
			        verified_at = prev_verified_at, link_net = prev_link_net,
			        prev_address_sealed = NULL, prev_route_sealed = NULL,
			        prev_verified_at = NULL, prev_link_net = NULL,
			        code_mac = NULL, code_expires_at = NULL, code_attempts = 0
			  WHERE verified_at IS NULL AND prev_verified_at IS NOT NULL
			    AND (code_expires_at IS NULL OR code_expires_at < $1)`,
					[now]
				);
				await c.query(`DELETE FROM offline_notify_channels WHERE ${expired}`, [now]);
			})
		);
	}

	/**
	 * The operator turned a channel off: every address users gave for it goes
	 * (and the operator's test address): with Matrix, every room of the
	 * mapping goes to the leave queue, as for any address no row holds.
	 * `removed` counts users' addresses.
	 */
	async purgeChannel(channel: Channel): Promise<{ removed: number }> {
		const gone = await this.tx((c) =>
			this.guardRooms(c, 'channel = $1', [channel], () =>
				c.query<{ account: string }>(
					`DELETE FROM offline_notify_channels WHERE channel = $1 RETURNING account`,
					[channel]
				)
			)
		);
		// Accounts left with nothing: their queue and links go too.
		await this.db.query(
			`DELETE FROM offline_notify_pending p WHERE NOT EXISTS (
			   SELECT 1 FROM offline_notify_channels c WHERE c.account = p.account)`
		);
		await this.db.query(
			`DELETE FROM offline_notify_links l WHERE NOT EXISTS (
			   SELECT 1 FROM offline_notify_channels c WHERE c.account = l.account)`
		);
		// Users' addresses: the operator's own test address is not one.
		return { removed: gone.rows.filter((r) => r.account !== TEST_ACCOUNT).length };
	}
}

/**
 * Start over: forget every address, code count, waiting notice and link, and
 * which key sealed them. The next start makes a new key. For a relay whose
 * key file was lost (`sudo morphit-ops offline-notify` → Start over).
 */
export async function resetOfflineNotify(db: Database): Promise<void> {
	await db.withTx(async (c) => {
		for (const t of [
			'offline_notify_channels',
			'offline_notify_code_log',
			'offline_notify_address_log',
			'offline_notify_pending',
			'offline_notify_links',
			'offline_notify_leave',
			'offline_notify_matrix_rooms',
			'offline_notify_key'
		])
			await c.query(`DELETE FROM ${t}`);
	});
}
