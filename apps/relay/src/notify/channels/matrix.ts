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
	body?: unknown,
	timeoutMs?: number
): Promise<Record<string, unknown>> {
	const base = cfg.homeserver.replace(/\/+$/, '');
	const r = await httpRequest(`${base}${path}`, policy, {
		method,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
	roomId: string,
	timeoutMs?: number
): Promise<void> {
	const room = encodeURIComponent(roomId);
	try {
		await call(cfg, policy, 'POST', `/_matrix/client/v3/rooms/${room}/leave`, {}, timeoutMs);
	} catch (err) {
		if (!(err instanceof MatrixError) || (err.status !== 403 && err.status !== 404)) throw err;
	}
	try {
		await call(cfg, policy, 'POST', `/_matrix/client/v3/rooms/${room}/forget`, {}, timeoutMs);
	} catch (err) {
		// Already forgotten (or never known): nothing is left to forget.
		if (!(err instanceof MatrixError) || (err.status !== 403 && err.status !== 404)) throw err;
	}
}

/** Whether `userId` has joined `roomId` (asked of the bot's homeserver). */
export async function hasJoined(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	userId: string,
	timeoutMs?: number
): Promise<boolean> {
	const r = await call(
		cfg,
		policy,
		'GET',
		`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
		undefined,
		timeoutMs
	);
	const joined = r.joined;
	return typeof joined === 'object' && joined !== null && Object.hasOwn(joined as object, userId);
}

/** `adminCli send matrix` (the operator's test note) is done, the test chat
 *  left, this long after the tool started: morphit-ops stops it at 180 s, and
 *  starting tsx takes a few seconds. */
export const TEST_NOTE_BUDGET_MS = 150_000;

/** The budget in use: MORPHIT_NOTIFY_SEND_BUDGET_MS may only make it SHORTER
 *  (at least 1 s) — so its test runs in seconds against a homeserver slowed in
 *  proportion, not two and a half minutes on every CI run. PURE. */
export function testNoteBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
	const v = Number(env.MORPHIT_NOTIFY_SEND_BUDGET_MS);
	return Number.isFinite(v) && v >= 1_000 && v < TEST_NOTE_BUDGET_MS ? v : TEST_NOTE_BUDGET_MS;
}

/** How long an operator's test chat waits for them to join it. */
export const TEST_JOIN_WAIT_MS = 100_000;
const TEST_JOIN_POLL_MS = 3_000;
/** One join check, and each of leave and forget, may take this long at most. */
const TEST_CALL_MS = 15_000;

/**
 * After a test note: wait until the operator has joined the chat (or
 * `waitMs` passed), then leave and forget it. Once the bot has left, the
 * invitation can no longer be accepted ("the person who invited you has
 * already left"), so leaving at once would leave the note unreadable; once
 * they have joined, the note stays with them. Returns whether they joined.
 */
export async function leaveTestRoom(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	userId: string,
	opts: {
		readonly waitMs?: number;
		readonly pollMs?: number;
		readonly now?: () => number;
		readonly sleep?: (ms: number) => Promise<void>;
		/** When everything, the leave included, must be done (by `now`): the
		 *  caller's own time limit. The checks stop early enough for the leave. */
		readonly deadline?: number;
	} = {}
): Promise<boolean> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = opts.deadline ?? Infinity;
	// Leave and forget each get up to TEST_CALL_MS (a quarter of the time when
	// less is left), so checking stops that much earlier.
	const reserve = Math.min(TEST_CALL_MS, (deadline - now()) / 4);
	const lastCheck = deadline - 2 * reserve;
	const until = Math.min(now() + (opts.waitMs ?? TEST_JOIN_WAIT_MS), lastCheck);
	const callMs = (end: number): number => Math.max(1_000, Math.min(TEST_CALL_MS, end - now()));
	let joined = false;
	for (;;) {
		if (now() >= lastCheck) break;
		joined = await hasJoined(cfg, policy, roomId, userId, callMs(lastCheck)).catch(() => false);
		if (joined || now() >= until) break;
		await sleep(Math.min(opts.pollMs ?? TEST_JOIN_POLL_MS, Math.max(0, until - now())));
	}
	// Leave and forget share what is left (each at most TEST_CALL_MS).
	const leaveMs = Math.max(1_000, Math.min(TEST_CALL_MS, (deadline - now()) / 2));
	await leaveRoom(cfg, policy, roomId, leaveMs).catch(() => undefined);
	return joined;
}

/** The bot's own user id, from its token (operator setup check). */
export async function whoAmI(cfg: MatrixConfig, policy: NetPolicy): Promise<string> {
	const r = await call(cfg, policy, 'GET', '/_matrix/client/v3/account/whoami');
	if (typeof r.user_id !== 'string') throw new MatrixError(200, 'no_user_id');
	return r.user_id;
}
