/**
 * Offline notices — Matrix, through the operator's bot account (homeserver URL
 * + an access token).
 *
 * ONE direct room per Matrix address, kept. The first message to someone
 * opens a direct room that invites her; every later message to that address —
 * the operator's test note, codes, notices — goes to that same room, and
 * sending never makes the bot leave it. Which room is hers is kept in the
 * relay's own database ({@link MatrixRoomBook}: store.ts, the
 * offline_notify_matrix_rooms table), never asked of the homeserver: a new
 * room is claimed there only if the mapping still holds what this send read
 * (compare-and-set), so two senders at once — in one process or two — end up
 * in one room; the loser leaves the room it opened. Sends to one address run
 * one at a time in this process.
 *
 * Before each send the bot asks its homeserver whether she is in the room or
 * invited to it. If she left it (or declined), she is invited to the same room
 * again. A new room is opened only when that room cannot be used any more —
 * the bot is no longer in it (its own list of joined rooms says so), she
 * cannot be invited back into it (banned, or her homeserver refuses), or
 * (a room an older version opened) someone else is in it — never because
 * the homeserver answered with an error about the bot's account (suspended,
 * rate-limited, out of resources), was slow, or did not answer: that is the
 * caller's to retry.
 *
 * A room this opens can hold only the bot and her: only the bot may invite
 * (power levels), and someone invited sees the history from their invitation
 * on. So a code another account asked for, sent to her address's room, is
 * read by the address's owner and nobody else — as when each code had a room
 * of its own.
 *
 * The bot leaves (and forgets) a room only when no saved address uses it any
 * more (leaves.ts, store.ts). The bot's own `m.direct` list is not written:
 * the room is marked direct for HER by the invitation (is_direct), which is
 * what her Matrix app reads; the bot's list would only show in a Matrix app
 * signed in as the bot.
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

/** Time limits for the requests of one send or leave. */
export interface MatrixCtx {
	/** When it must all be done (ms since the epoch): each request gets what
	 *  is left, and none starts after it. */
	readonly deadline?: number;
	/** Each request at most this long (default {@link DEFAULT_CALL_MS}). */
	readonly callMs?: number;
}

/**
 * Where an address's one room is kept (store.ts implements it, in the
 * database). `version` is what the mapping held when read: a claim succeeds
 * only if it still does.
 */
export interface MatrixRoomBook {
	get(
		userId: string
	): Promise<{ readonly room: string; readonly version: Buffer; readonly botOnly: boolean } | null>;
	/**
	 * Make `room` (just opened, only the bot may invite into it) her room, if
	 * the mapping still holds `version` (null: no room yet). Returns her room
	 * now: this one (`won`), or the one another sender claimed first — then
	 * `room` is queued to be left. Null when no saved address holds her
	 * address any more (a send that came too late): `room` is queued to be
	 * left. A room it replaces is queued to be left too.
	 */
	claim(
		userId: string,
		version: Buffer | null,
		room: string
	): Promise<{ readonly room: string; readonly botOnly: boolean; readonly won: boolean } | null>;
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

/** The homeserver took too long: one request past its time limit, or the
 *  caller's deadline ({@link MatrixCtx}). */
export class MatrixTimeoutError extends Error {
	constructor() {
		super('the homeserver took too long');
		this.name = 'TimeoutError';
	}
}

/** A note to an address no saved address holds any more (a code that came
 *  back after it was given up): nothing was sent, no room kept for it. */
export class MatrixAddressGoneError extends Error {
	constructor() {
		super('no saved address holds this Matrix address any more');
		this.name = 'MatrixAddressGoneError';
	}
}

/** Only a real Matrix error code (M_FORBIDDEN …) is kept: the field is the
 *  server's free text, and one could repeat the address it was asked about. */
export function errcodeOf(v: unknown): string {
	return typeof v === 'string' && /^M_[A-Z_]{1,40}$/.test(v) ? v : 'unknown';
}

/** Each request at most this long, unless the caller says otherwise. */
export const DEFAULT_CALL_MS = 30_000;
/** A request that failed this close to its time limit timed out (the
 *  network's timer and Date.now() may disagree by a moment). */
const TIMEOUT_SLACK_MS = 100;

/** The time one request may take under `ctx`; throws once its deadline passed. */
function timeFor(ctx: MatrixCtx): number {
	const cap = ctx.callMs ?? DEFAULT_CALL_MS;
	if (ctx.deadline === undefined) return cap;
	const left = ctx.deadline - Date.now();
	if (left < 1) throw new MatrixTimeoutError();
	return Math.min(cap, left);
}

async function call(
	cfg: MatrixConfig,
	policy: NetPolicy,
	method: string,
	path: string,
	body: unknown,
	ctx: MatrixCtx
): Promise<Record<string, unknown>> {
	const timeoutMs = timeFor(ctx);
	const base = cfg.homeserver.replace(/\/+$/, '');
	const started = Date.now();
	let r;
	try {
		r = await httpRequest(`${base}${path}`, policy, {
			method,
			timeoutMs,
			headers: {
				Authorization: `Bearer ${cfg.accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'application/json'
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {})
		});
	} catch (err) {
		// Ran into its time limit (connect, Tor, TLS or the answer): said as
		// such — "too slow", not an error of unknown kind.
		if (Date.now() - started >= timeoutMs - TIMEOUT_SLACK_MS) throw new MatrixTimeoutError();
		throw err;
	}
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

/** What a room-specific refusal looks like: the bot may not act in that room
 *  (403 M_FORBIDDEN) or the room or member is unknown (404 M_NOT_FOUND). An
 *  error about the bot's account itself (M_USER_SUSPENDED, M_USER_LOCKED,
 *  M_LIMIT_EXCEEDED, M_RESOURCE_LIMIT_EXCEEDED, M_UNKNOWN_TOKEN …) is not —
 *  and even M_FORBIDDEN counts only once the bot's own list of joined rooms
 *  confirms it ({@link botIn}): a suspended account may answer M_FORBIDDEN to
 *  everything. */
const roomRefusal = (err: unknown): boolean =>
	err instanceof MatrixError &&
	((err.status === 403 && err.errcode === 'M_FORBIDDEN') ||
		(err.status === 404 && err.errcode === 'M_NOT_FOUND'));

const room = (id: string): string => `/_matrix/client/v3/rooms/${encodeURIComponent(id)}`;

/** Is the bot in this room? Its own list of joined rooms (an account that
 *  cannot even read that throws: nothing is judged then). */
async function botIn(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	ctx: MatrixCtx
): Promise<boolean> {
	const r = await call(cfg, policy, 'GET', '/_matrix/client/v3/joined_rooms', undefined, ctx);
	return Array.isArray(r.joined_rooms) && r.joined_rooms.includes(roomId);
}

/** Open a direct room with `userId` (she is invited), that only she and the
 *  bot can ever be in: only the bot may invite (or kick, ban, change the
 *  room), and history is visible from one's invitation on. */
export async function openRoom(
	cfg: MatrixConfig,
	policy: NetPolicy,
	userId: string,
	ctx: MatrixCtx = {}
): Promise<string> {
	const r = await call(
		cfg,
		policy,
		'POST',
		'/_matrix/client/v3/createRoom',
		{
			preset: 'private_chat',
			is_direct: true,
			invite: [userId],
			visibility: 'private',
			initial_state: [
				{
					type: 'm.room.history_visibility',
					state_key: '',
					content: { history_visibility: 'invited' }
				},
				{ type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } }
			],
			power_level_content_override: {
				invite: 100,
				kick: 100,
				ban: 100,
				redact: 100,
				state_default: 100,
				users_default: 0
			}
		},
		ctx
	);
	if (typeof r.room_id !== 'string') throw new MatrixError(200, 'no_room_id');
	return r.room_id;
}

async function sendText(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	text: string,
	ctx: MatrixCtx
): Promise<void> {
	const txn = randomBytes(12).toString('hex');
	await call(
		cfg,
		policy,
		'PUT',
		`${room(roomId)}/send/m.room.message/${txn}`,
		{ msgtype: 'm.text', body: text },
		ctx
	);
}

// ── One send to an address at a time (in this process) ──────────────────────

const chains = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const before = chains.get(key) ?? Promise.resolve();
	const run = before.then(fn, fn);
	const tail = run.catch(() => undefined);
	chains.set(key, tail);
	try {
		return await run;
	} finally {
		if (chains.get(key) === tail) chains.delete(key);
	}
}

// ── Can a note to her go to this room? ──────────────────────────────────────

/**
 * 'ok': the note can go there (she is in it or invited — or she left or
 * declined, and is invited again now). 'dead': it cannot, and never will
 * (see the top of this file). Anything else throws.
 */
async function roomFor(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	userId: string,
	botOnly: boolean,
	ctx: MatrixCtx
): Promise<'ok' | 'dead'> {
	let membership: unknown;
	try {
		membership = (
			await call(
				cfg,
				policy,
				'GET',
				`${room(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
				undefined,
				ctx
			)
		).membership;
	} catch (err) {
		if (roomRefusal(err)) {
			// Not her room (she was never in it) or not the bot's any more —
			// or the bot's account is in trouble: its joined rooms tell.
			const inIt = await botIn(cfg, policy, roomId, ctx);
			if (!inIt || (err as MatrixError).status === 404) return 'dead';
		}
		throw err;
	}
	if (membership === 'ban') return 'dead';
	if (membership === 'leave') {
		try {
			await call(cfg, policy, 'POST', `${room(roomId)}/invite`, { user_id: userId }, ctx);
		} catch (err) {
			if (!roomRefusal(err)) throw err;
			// Refused: her homeserver refuses, or the bot is not in the room —
			// dead either way. But first make sure the bot's account can still
			// read its own joined rooms (if not, that throws: the account is in
			// trouble, nothing is judged).
			await botIn(cfg, policy, roomId, ctx);
			return 'dead';
		}
	} else if (membership !== 'join' && membership !== 'invite') return 'dead';
	if (!botOnly) {
		// A room an older version opened: she could invite others into it. A
		// code for her address must not be read by anyone else.
		const r = await call(cfg, policy, 'GET', `${room(roomId)}/members`, undefined, ctx);
		const chunk = Array.isArray(r.chunk) ? (r.chunk as Array<Record<string, unknown>>) : [];
		const others = chunk.some((e) => {
			const who = e.state_key;
			const m = (e.content as Record<string, unknown> | undefined)?.membership;
			return who !== cfg.userId && who !== userId && (m === 'join' || m === 'invite');
		});
		if (others) return 'dead';
	}
	return 'ok';
}

/** Send in a room `roomFor` said is hers: 'dead' when the bot turns out not
 *  to be in it after all. */
async function sendIn(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	text: string,
	ctx: MatrixCtx
): Promise<'sent' | 'dead'> {
	try {
		await sendText(cfg, policy, roomId, text, ctx);
		return 'sent';
	} catch (err) {
		if (roomRefusal(err) && !(await botIn(cfg, policy, roomId, ctx))) return 'dead';
		throw err;
	}
}

/**
 * Send `text` to `userId` in her room (the one `book` has for her address),
 * or — when it cannot be used any more, or there is none — in a new room
 * claimed for her address. Returns the room it went to. Never leaves a room
 * itself (one it replaces, or opened and lost to another sender, is queued
 * by `book`).
 */
export async function sendMatrix(
	cfg: MatrixConfig,
	policy: NetPolicy,
	userId: string,
	text: string,
	book: MatrixRoomBook,
	ctx: MatrixCtx = {}
): Promise<string> {
	return oneAtATime(`${cfg.homeserver}\n${cfg.userId}\n${userId}`, async () => {
		const cur = await book.get(userId);
		if (cur !== null) {
			if (
				(await roomFor(cfg, policy, cur.room, userId, cur.botOnly, ctx)) === 'ok' &&
				(await sendIn(cfg, policy, cur.room, text, ctx)) === 'sent'
			)
				return cur.room;
		}
		const fresh = await openRoom(cfg, policy, userId, ctx);
		const mine = await book.claim(userId, cur?.version ?? null, fresh);
		if (mine === null) throw new MatrixAddressGoneError();
		if (!mine.won && (await roomFor(cfg, policy, mine.room, userId, mine.botOnly, ctx)) !== 'ok')
			throw new MatrixError(409, 'room_claimed_elsewhere');
		if ((await sendIn(cfg, policy, mine.room, text, ctx)) !== 'sent')
			throw new MatrixError(409, 'room_gone');
		return mine.room;
	});
}

/**
 * Leave a room and forget it (which asks the homeserver to drop the room's
 * history for the bot). A room already left still gets forgotten. Only for a
 * room no saved address uses any more (leaves.ts): never after a note.
 */
export async function leaveRoom(
	cfg: MatrixConfig,
	policy: NetPolicy,
	roomId: string,
	ctx: MatrixCtx = {}
): Promise<void> {
	for (const step of ['leave', 'forget'] as const) {
		try {
			await call(cfg, policy, 'POST', `${room(roomId)}/${step}`, {}, ctx);
		} catch (err) {
			// Refused because the bot is not in it (any more): that step is done
			// (a room already left, or forgotten). Anything else — the bot's
			// account in trouble, no answer — is tried again later.
			const refusedHere = err instanceof MatrixError && (err.status === 403 || err.status === 404);
			if (!refusedHere || (await botIn(cfg, policy, roomId, ctx))) throw err;
		}
	}
}

/** `adminCli send matrix` (the operator's test note) is done this long after
 *  the tool started: morphit-ops stops it at 180 s, and starting tsx takes a
 *  few seconds. Every request has its own limit too ({@link DEFAULT_CALL_MS}). */
export const TEST_NOTE_BUDGET_MS = 150_000;

/** The budget in use: MORPHIT_NOTIFY_SEND_BUDGET_MS may only make it SHORTER
 *  (at least 1 s). PURE. */
export function testNoteBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
	const v = Number(env.MORPHIT_NOTIFY_SEND_BUDGET_MS);
	return Number.isFinite(v) && v >= 1_000 && v < TEST_NOTE_BUDGET_MS ? v : TEST_NOTE_BUDGET_MS;
}

/** The bot's own user id, from its token (operator setup check). */
export async function whoAmI(cfg: MatrixConfig, policy: NetPolicy): Promise<string> {
	const r = await call(cfg, policy, 'GET', '/_matrix/client/v3/account/whoami', undefined, {});
	if (typeof r.user_id !== 'string') throw new MatrixError(200, 'no_user_id');
	return r.user_id;
}
