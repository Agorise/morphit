/**
 * Morphit indexer — /v1/chat/:a/:b endpoint.
 *
 * Ciphertext chat messages between two accounts, in either
 * direction. The path parameters are canonicalized before the
 * query so /chat/alice/bob and /chat/bob/alice return the same
 * data.
 *
 * Authentication: none (ADR-0008). The indexer has no session
 * concept; any user can request any pair's ciphertext. This is
 * safe because only the two participants hold the X25519
 * chat-identity keys (derived from posting; see ADR-0015) needed
 * to decrypt the ECIES envelope — everyone else sees opaque
 * base64 blobs.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Database } from '$db/pool';
import { decodeCursor, encodeCursor, errorBody, isAccountName } from '$api/shared';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
	cursor: z.string().min(1).max(512).optional()
});

interface Cursor {
	readonly c: string; // created_at ISO
	readonly i: number; // message id
}

function narrowCursor(v: unknown): Cursor | null {
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.c !== 'string' || typeof o.i !== 'number') return null;
	if (!Number.isFinite(o.i)) return null;
	if (Number.isNaN(new Date(o.c).getTime())) return null;
	return { c: o.c, i: o.i };
}

interface MsgRow {
	id: string;
	sender: string;
	recipient: string;
	ciphertext: string;
	header: unknown;
	created_at: Date;
}

export function chatRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:a/:b', async (c) => {
		const a = c.req.param('a');
		const b = c.req.param('b');
		if (!isAccountName(a) || !isAccountName(b)) {
			return c.json(errorBody('bad_request', 'invalid account name(s)'), 400);
		}
		if (a === b) {
			return c.json(errorBody('bad_request', 'self-chat not allowed'), 400);
		}

		// Canonicalize so both /a/b and /b/a hit the same conversation.
		const [lo, hi] = a < b ? [a, b] : [b, a];

		const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
		if (!parsed.success) {
			return c.json(
				errorBody('bad_request', parsed.error.issues.map((i) => i.message).join('; ')),
				400
			);
		}
		const q = parsed.data;
		const limit = q.limit ?? DEFAULT_LIMIT;

		const params: unknown[] = [lo, hi];
		let cursorClause = '';
		if (q.cursor) {
			const cur = narrowCursor(decodeCursor(q.cursor));
			if (!cur) {
				return c.json(errorBody('bad_request', 'invalid cursor'), 400);
			}
			params.push(new Date(cur.c), cur.i);
			cursorClause = ` AND (created_at < $3 OR (created_at = $3 AND id > $4))`;
		}
		params.push(limit + 1);
		const limitParam = `$${params.length}`;

		const sql = `SELECT id::text, sender, recipient, ciphertext, header, created_at
			 FROM chat_messages
			 WHERE LEAST(sender, recipient) = $1
			   AND GREATEST(sender, recipient) = $2${cursorClause}
			 ORDER BY created_at DESC, id ASC
			 LIMIT ${limitParam}`;

		const result = await db.query<MsgRow>(sql, params);
		const rows = result.rows;

		let nextCursor: string | null = null;
		if (rows.length > limit) {
			rows.pop();
			const last = rows[rows.length - 1]!;
			nextCursor = encodeCursor({
				c: last.created_at.toISOString(),
				i: parseInt(last.id, 10)
			});
		}

		return c.json({
			items: rows.map((r) => ({
				id: parseInt(r.id, 10),
				sender: r.sender,
				recipient: r.recipient,
				ciphertext: r.ciphertext,
				header: r.header,
				created_at: r.created_at.toISOString()
			})),
			next_cursor: nextCursor
		});
	});

	return app;
}
