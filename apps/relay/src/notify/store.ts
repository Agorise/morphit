/**
 * Offline notices — the database side (tables from indexer migration v69).
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
	readonly route: string | null;
	readonly linkNet: LinkNet;
	/** The sealed address as read: a route found on the way is saved only to
	 *  the row that still holds exactly this address ({@link setRoute}). */
	readonly addressSealed: Buffer;
	/** The confirmed address she had, kept while she changes it. */
	readonly prev: boolean;
}

/** Which row a route found while sending belongs to: the one still waiting
 *  for this code, or the one still holding this confirmed address. */
export type RouteOwner =
	| { readonly codeMac: Buffer }
	| { readonly addressSealed: Buffer; readonly prev: boolean };

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
	return { store: new OfflineNotifyStore(db, vault), created };
}

export class OfflineNotifyStore {
	constructor(
		private readonly db: Database,
		readonly vault: Vault
	) {}

	/**
	 * Run `fn` (statements that may delete Matrix rows, or replace or clear
	 * their rooms) and queue for the bot to leave every room that the rows
	 * matching `where` held before and no row of that account holds after —
	 * whatever the statements were. Same transaction as `fn`. This is the one
	 * place that decides which rooms are given up; every path that changes a
	 * room goes through it.
	 */
	private async guardRooms<T>(
		c: Tx,
		where: string,
		params: readonly unknown[],
		fn: () => Promise<T>
	): Promise<T> {
		const before = await c.query<{
			account: string;
			route_sealed: Buffer | null;
			prev_route_sealed: Buffer | null;
		}>(
			`SELECT account, route_sealed, prev_route_sealed FROM offline_notify_channels
			  WHERE channel = 'matrix' AND (${where}) FOR UPDATE`,
			params as unknown[]
		);
		const result = await fn();
		const held = before.rows.flatMap((r) =>
			[r.route_sealed, r.prev_route_sealed]
				.filter((x): x is Buffer => x !== null)
				.map((room) => ({ account: r.account, room }))
		);
		if (held.length === 0) return result;
		const after = await c.query<{
			account: string;
			route_sealed: Buffer | null;
			prev_route_sealed: Buffer | null;
		}>(
			`SELECT account, route_sealed, prev_route_sealed FROM offline_notify_channels
			  WHERE channel = 'matrix' AND account = ANY($1::text[])`,
			[[...new Set(held.map((h) => h.account))]]
		);
		// Compared by the room each value OPENS to, not by its sealed bytes:
		// the same room sealed again (a fresh nonce) is still her room.
		const roomOf = (account: string, sealed: Buffer): string =>
			this.vault.open(sealed, account, 'matrix', 'route') ?? `sealed:${sealed.toString('hex')}`;
		const still = new Set(
			after.rows.flatMap((r) =>
				[r.route_sealed, r.prev_route_sealed]
					.filter((x): x is Buffer => x !== null)
					.map((x) => `${r.account}\n${roomOf(r.account, x)}`)
			)
		);
		for (const h of held) {
			if (still.has(`${h.account}\n${roomOf(h.account, h.room)}`)) continue;
			await c.query(
				`INSERT INTO offline_notify_leave (route_sealed, account) VALUES ($1, $2)
				 ON CONFLICT (route_sealed) DO NOTHING`,
				[h.room, h.account]
			);
		}
		return result;
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
		return this.db.withTx(async (c) => {
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
		return tx !== null ? run(tx) : this.db.withTx(run);
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
		return this.db.withTx(async (c) => {
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
		return this.db.withTx(async (c) => {
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
		await this.db.withTx(async (c) => {
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

	/** A Matrix room the bot opened but that no row holds (its first message
	 *  failed, or it arrived after the caller gave up): queue it to leave. */
	async queueLeave(account: string, room: string): Promise<void> {
		await this.db.query(
			`INSERT INTO offline_notify_leave (route_sealed, account) VALUES ($1, $2)
			 ON CONFLICT (route_sealed) DO NOTHING`,
			[this.vault.seal(room, account, 'matrix', 'route'), account]
		);
	}

	/**
	 * Matrix rooms due to be left, claimed for ten minutes (two relays never
	 * leave the same room at once). A room that does not open (damaged, or
	 * another key) comes back as null: nothing can be done with it.
	 */
	async claimLeaves(
		limit: number,
		now: Date
	): Promise<Array<{ key: Buffer; tries: number; account: string; room: string | null }>> {
		const r = await this.db.query<{ route_sealed: Buffer; account: string; tries: number }>(
			`UPDATE offline_notify_leave SET next_at = $2
			  WHERE route_sealed IN (
			          SELECT route_sealed FROM offline_notify_leave WHERE next_at <= $1
			           ORDER BY next_at LIMIT $3 FOR UPDATE SKIP LOCKED)
			 RETURNING route_sealed, account, tries`,
			[now, new Date(now.getTime() + 10 * 60_000), limit]
		);
		return r.rows.map((x) => ({
			key: x.route_sealed,
			tries: x.tries,
			account: x.account,
			room: this.vault.open(x.route_sealed, x.account, 'matrix', 'route')
		}));
	}

	/** Does a row of hers still hold this room (as hers, or kept aside during
	 *  a change)? Checked again just before the bot leaves a room. */
	async roomHeld(account: string, room: string): Promise<boolean> {
		const r = await this.db.query<{
			route_sealed: Buffer | null;
			prev_route_sealed: Buffer | null;
		}>(
			`SELECT route_sealed, prev_route_sealed FROM offline_notify_channels
			  WHERE account = $1 AND channel = 'matrix'`,
			[account]
		);
		return r.rows.some((x) =>
			[x.route_sealed, x.prev_route_sealed].some(
				(v) => v !== null && this.vault.open(v, account, 'matrix', 'route') === room
			)
		);
	}

	/** The room was left (or cannot ever be): off the queue. */
	async leaveDone(key: Buffer): Promise<void> {
		await this.db.query(`DELETE FROM offline_notify_leave WHERE route_sealed = $1`, [key]);
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
			route_sealed: Buffer | null;
			link_net: LinkNet;
			prev_address_sealed: Buffer | null;
			prev_route_sealed: Buffer | null;
			prev_link_net: LinkNet | null;
			locale: string;
		}>(
			`SELECT channel, verified_at IS NOT NULL AS verified, address_sealed, route_sealed, link_net,
			        prev_address_sealed, prev_route_sealed, prev_link_net, locale
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
					await this.db.withTx((c) =>
						this.guardRooms(c, 'account = $1 AND channel = $2', [account, row.channel], () =>
							c.query(`DELETE FROM offline_notify_channels WHERE account = $1 AND channel = $2`, [
								account,
								row.channel
							])
						)
					);
				continue;
			}
			const routeSealed = prev ? row.prev_route_sealed : row.route_sealed;
			const route = routeSealed
				? this.vault.open(routeSealed, account, row.channel, 'route')
				: null;
			out.push({
				channel: row.channel,
				address,
				route,
				linkNet: (prev ? row.prev_link_net : row.link_net) ?? row.link_net,
				addressSealed: sealed,
				prev
			});
		}
		return { channels: out, locale: r.rows[0]?.locale ?? 'en' };
	}

	/**
	 * Keep the Matrix room a send opened — only on the row it was opened for:
	 * the one still waiting for that code, or the one still holding that
	 * confirmed address. A send that finishes after she cancelled, typed
	 * another address or confirmed a new one must not give that row a room
	 * with someone else in it. True when it was kept; when not, the room is
	 * queued for the bot to leave.
	 */
	async setRoute(
		account: string,
		channel: Channel,
		route: string,
		owner: RouteOwner
	): Promise<boolean> {
		const sealed = this.vault.seal(route, account, channel, 'route');
		const kept = await this.db.withTx((c) =>
			this.guardRooms(c, 'account = $1 AND channel = $2', [account, channel], () =>
				'codeMac' in owner
					? c.query(
							`UPDATE offline_notify_channels SET route_sealed = $3
							  WHERE account = $1 AND channel = $2 AND verified_at IS NULL AND code_mac = $4`,
							[account, channel, sealed, owner.codeMac]
						)
					: owner.prev
						? c.query(
								`UPDATE offline_notify_channels SET prev_route_sealed = $3
								  WHERE account = $1 AND channel = $2 AND verified_at IS NULL
								    AND prev_verified_at IS NOT NULL AND prev_address_sealed = $4`,
								[account, channel, sealed, owner.addressSealed]
							)
						: c.query(
								`UPDATE offline_notify_channels SET route_sealed = $3
								  WHERE account = $1 AND channel = $2 AND verified_at IS NOT NULL
								    AND address_sealed = $4`,
								[account, channel, sealed, owner.addressSealed]
							)
			)
		);
		if ((kept.rowCount ?? 0) > 0) return true;
		await this.queueLeave(account, route);
		return false;
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
		await this.db.withTx((c) =>
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
	 * (Matrix rooms to the leave queue, as for any deleted row).
	 */
	async purgeChannel(channel: Channel): Promise<{ removed: number }> {
		const gone = await this.db.withTx((c) =>
			this.guardRooms(c, 'channel = $1', [channel], () =>
				c.query(`DELETE FROM offline_notify_channels WHERE channel = $1`, [channel])
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
		return { removed: gone.rowCount ?? 0 };
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
			'offline_notify_key'
		])
			await c.query(`DELETE FROM ${t}`);
	});
}
