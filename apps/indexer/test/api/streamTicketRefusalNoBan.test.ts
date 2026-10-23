/**
 * A refused chat-stream ticket must not count toward BunkerWeb's bad-behavior
 * ban (v1.21.14 review B, F7).
 *
 * BunkerWeb bans an IP for an hour after 50 answers with a status in
 * BAD_BEHAVIOR_STATUS_CODES within a minute (the template's list; the upgrade
 * heal writes the same list). The stream refusal was 401 — in that list — and
 * after an upgrade every open tab from an older bundle, and every tab whose
 * ticket a slow clock made stale, asks for refused streams again and again.
 * Many visitors behind one address (CGNAT, an office, a Tor exit reaching the
 * clearnet name) would together ban that address from the whole site.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { chatActivityStreamRoute } from '$api/chatActivityStream';
import { chatStreamRoute } from '$api/chatStream';
import { streamTickets, TEST_STREAM_HOST } from '../testutils/streamTickets';

const T = await streamTickets();
const repo = join(__dirname, '..', '..', '..', '..');
const template = readFileSync(
	join(repo, 'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'),
	'utf8'
);
const banned = (/^BAD_BEHAVIOR_STATUS_CODES=(.*)$/m.exec(template)?.[1] ?? '')
	.trim()
	.split(/\s+/)
	.map(Number);

const db = { query: async () => ({ rows: [], rowCount: 0 }) };
const poller = { getStatus: () => ({ indexedBlock: 1 }) };

async function status(app: { request: Function }, path: string): Promise<number> {
	const res: Response = await app.request(
		path,
		{ headers: { host: TEST_STREAM_HOST } },
		{ incoming: { socket: { remoteAddress: '127.0.0.1' } } }
	);
	await res.body?.cancel();
	return res.status;
}

describe('stream ticket refusals and the BunkerWeb ban (review B, F7)', () => {
	it('the template list is read', () => {
		expect(banned.length).toBeGreaterThan(0);
		expect(banned.every(Number.isInteger)).toBe(true);
	});
	it('activity stream: no ticket, a foreign ticket, an expired ticket — never a counted status', async () => {
		const app = chatActivityStreamRoute(T.routeOpts);
		for (const path of [
			'/alice/stream',
			`/alice/stream?ticket=${encodeURIComponent(T.ticketFor('mallory'))}`,
			`/alice/stream?ticket=${encodeURIComponent(T.ticketFor('alice', { ttlS: -5 }))}`
		]) {
			const s = await status(app, path);
			expect(s, path).toBeGreaterThanOrEqual(400);
			expect(banned, `status ${s} is counted by BunkerWeb`).not.toContain(s);
		}
	});
	it('conversation stream: no ticket — never a counted status', async () => {
		const s = await status(
			chatStreamRoute(db as never, poller as never, T.routeOpts),
			'/alice/bob/stream'
		);
		expect(s).toBeGreaterThanOrEqual(400);
		expect(banned, `status ${s} is counted by BunkerWeb`).not.toContain(s);
	});
});
