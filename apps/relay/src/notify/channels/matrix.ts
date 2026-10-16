/**
 * Offline notices — Matrix, through the operator's bot account (homeserver URL
 * + an access token). The first message to a user opens a direct room that
 * invites her; she accepts the invite once and later notices arrive in the
 * same room (its id is kept, sealed, with her address). If she left it, a new
 * room is opened.
 *
 * Client-server API v3 over plain HTTPS (or http to an .onion homeserver,
 * through Tor). No encryption library: the notice holds nothing secret.
 */

import { randomBytes } from 'node:crypto';
import { httpRequest, type NetPolicy } from '../net.ts';

export interface MatrixConfig {
	/** https://matrix.example.org or http://<name>.onion */
	readonly homeserver: string;
	readonly accessToken: string;
	/** The bot's own user id, shown on the card (@bot:example.org). */
	readonly userId: string;
}

export class MatrixError extends Error {
	constructor(
		readonly status: number,
		readonly errcode: string
	) {
		super(`Matrix homeserver answered ${status} ${errcode}`);
		this.name = 'MatrixError';
	}
}

/** Only a real Matrix error code (M_FORBIDDEN …) is kept: the field is the
 *  server's free text, and one could repeat the address it was asked about. */
export function errcodeOf(v: unknown): string {
	return typeof v === 'string' && /^M_[A-Z_]{1,40}$/.test(v) ? v : 'unknown';
}

/** A send that failed after the bot opened a room for it: the room is named so
 *  the caller can queue it to be left (it is in no row). */
export class MatrixRoomLeftOpen extends Error {
	constructor(
		readonly room: string,
		override readonly cause: unknown
	) {
		super(cause instanceof Error ? cause.message : 'Matrix send failed');
		this.name = cause instanceof Error ? cause.name : 'MatrixError';
	}
}

async function call(
	cfg: MatrixConfig,
	policy: NetPolicy,
	method: string,
	path: string,
	body?: unknown
): Promise<Record<string, unknown>> {
	const base = cfg.homeserver.replace(/\/+$/, '');
	const r = await httpRequest(`${base}${path}`, policy, {
		method,
		headers: {
			Authorization: `Bearer ${cfg.accessToken}`,
			'Content-Type': 'application/json',
			Accept: 'application/json'
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(r.body) as Record<string, unknown>;
	} catch {
		/* not JSON */
	}
	if (r.status < 200 || r.status >= 300) {
		throw new MatrixError(r.status, errcodeOf(parsed.errcode));
	}
	return parsed;
}

/** Open a direct room with `userId` (she is invited). */
export async function openRoom(
	cfg: MatrixConfig,
	policy: NetPolicy,
	userId: string
): Promise<string> {
	const r = await call(cfg, policy, 'POST', '/_matrix/client/v3/createRoom', {
		preset: 'trusted_private_chat',
		is_direct: true,
		invite: [userId],
		visibility: 'private'
	});
	if (typeof r.room_id !== 'string') throw new MatrixError(200, 'no_room_id');
	return r.room_id;
}

async function sendText(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	text: string
): Promise<void> {
	const txn = randomBytes(12).toString('hex');
	await call(
		cfg,
		policy,
		'PUT',
		`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
		{ msgtype: 'm.text', body: text }
	);
}

/**
 * Send `text` to `userId`, in `roomId` when there is one. Returns the room it
 * went to (a new one when the old is gone or there was none).
 */
export async function sendMatrix(
	cfg: MatrixConfig,
	policy: NetPolicy,
	userId: string,
	roomId: string | null,
	text: string
): Promise<string> {
	if (roomId !== null) {
		try {
			await sendText(cfg, policy, roomId, text);
			return roomId;
		} catch (err) {
			// She left the room, or it is gone: open a new one (and drop the old
			// one from the bot's list). Anything else (the homeserver is down)
			// is the caller's to retry.
			if (!(err instanceof MatrixError) || (err.status !== 403 && err.status !== 404)) throw err;
			await leaveRoom(cfg, policy, roomId).catch(() => undefined);
		}
	}
	const room = await openRoom(cfg, policy, userId);
	try {
		await sendText(cfg, policy, room, text);
	} catch (err) {
		throw new MatrixRoomLeftOpen(room, err);
	}
	return room;
}

/**
 * Leave a room and forget it, so the bot's account keeps no list of the users
 * it wrote to once they removed their address (or the operator turned Matrix
 * off). Forgetting asks the homeserver to drop the room's history for the bot.
 * A room already left still gets forgotten.
 */
export async function leaveRoom(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string
): Promise<void> {
	const room = encodeURIComponent(roomId);
	try {
		await call(cfg, policy, 'POST', `/_matrix/client/v3/rooms/${room}/leave`, {});
	} catch (err) {
		if (!(err instanceof MatrixError) || (err.status !== 403 && err.status !== 404)) throw err;
	}
	try {
		await call(cfg, policy, 'POST', `/_matrix/client/v3/rooms/${room}/forget`, {});
	} catch (err) {
		// Already forgotten (or never known): nothing is left to forget.
		if (!(err instanceof MatrixError) || (err.status !== 403 && err.status !== 404)) throw err;
	}
}

/** The bot's own user id, from its token (operator setup check). */
export async function whoAmI(cfg: MatrixConfig, policy: NetPolicy): Promise<string> {
	const r = await call(cfg, policy, 'GET', '/_matrix/client/v3/account/whoami');
	if (typeof r.user_id !== 'string') throw new MatrixError(200, 'no_user_id');
	return r.user_id;
}
