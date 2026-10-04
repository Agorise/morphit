#!/usr/bin/env tsx
/**
 * push-subscription-store-smoke — what the relay keeps per push device, and
 * the per-account cap under concurrency. Real PushSubscriptionStore, real
 * Postgres (TEST_DATABASE_URL, a database with the indexer schema; skipped
 * when unset). The table is created in a private schema, so the smoke needs
 * nothing but an empty database.
 *
 *   1. The cap of 20 subscriptions per account holds under concurrent
 *      subscribes. The COUNT-then-DELETE-then-INSERT ran in a READ COMMITTED
 *      transaction, which does not stop two upserts from both seeing "under
 *      the cap": 40 concurrent subscribes left 22 rows.
 *   2. No User-Agent is stored. The full UA (device, OS, browser build) sat
 *      next to the account and its push endpoint, read by nothing — an
 *      account ↔ device ↔ browser link in a seized database or backup.
 *   3. The locale is stored as one of the 10 supported codes, never the raw
 *      navigator.language tag (it narrowed the user's region).
 *   4. `self_hosted` is never stored: that mode was never wired to anything.
 */

import pg from 'pg';
import type { Database } from '../src/db/pool.ts';
import { PushSubscriptionStore } from '../src/policy/pushSubscriptions.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
	console.log('push-subscription-store-smoke: skipped — TEST_DATABASE_URL is not set');
	process.exit(0);
}

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

// A private schema with the production table definition (indexer schema.sql).
const SCHEMA = `push_store_smoke_${process.pid}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
await admin.query(`CREATE TABLE ${SCHEMA}.push_subscriptions (
	account TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
	user_agent TEXT, privacy_mode TEXT NOT NULL CHECK (privacy_mode IN ('standard', 'self_hosted')),
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_delivery_at TIMESTAMPTZ,
	consecutive_failures INTEGER NOT NULL DEFAULT 0, locale TEXT NOT NULL DEFAULT 'en',
	muted_categories TEXT[] NOT NULL DEFAULT '{}', PRIMARY KEY (account, endpoint))`);
// Same pool size as the relay's (db/pool.ts), so concurrency is real.
const pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${SCHEMA}` });
const db: Database = {
	async withTx(fn) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const r = await fn(client);
			await client.query('COMMIT');
			return r;
		} catch (err) {
			await client.query('ROLLBACK').catch(() => {});
			throw err;
		} finally {
			client.release();
		}
	},
	query: (t, p) => pool.query(t, p as unknown[] | undefined) as never,
	connect: () => pool.connect(),
	close: () => pool.end()
};
const store = new PushSubscriptionStore(db);
const ACCOUNT = 'smoke-push-cap';
const sub = (i: number, extra: Record<string, unknown> = {}) =>
	store.upsert({
		account: ACCOUNT,
		endpoint: `https://fcm.googleapis.com/fcm/send/smoke-${i}`,
		p256dh: 'p'.repeat(40),
		auth: 'a'.repeat(20),
		userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) Chrome/129.0',
		privacyMode: 'standard',
		locale: 'en',
		mutedCategories: [],
		...extra
	} as never);

try {
	console.log('push-subscription-store-smoke');
	await db.query('DELETE FROM push_subscriptions WHERE account = $1', [ACCOUNT]);

	await Promise.all(Array.from({ length: 40 }, (_, i) => sub(i)));
	const count = (
		await db.query<{ n: number }>(
			'SELECT count(*)::int AS n FROM push_subscriptions WHERE account = $1',
			[ACCOUNT]
		)
	).rows[0]!.n;
	check('40 concurrent subscribes leave at most 20 rows', count <= 20, `rows=${count}`);

	await sub(100, { locale: 'fa-IR', privacyMode: 'self_hosted' });
	const row = (
		await db.query<{ user_agent: string | null; locale: string; privacy_mode: string }>(
			'SELECT user_agent, locale, privacy_mode FROM push_subscriptions WHERE account = $1 AND endpoint = $2',
			[ACCOUNT, 'https://fcm.googleapis.com/fcm/send/smoke-100']
		)
	).rows[0];
	check(
		'no User-Agent is stored',
		row !== undefined && row.user_agent === null,
		`user_agent=${String(row?.user_agent)}`
	);
	check(
		'the locale is stored as a supported code',
		row?.locale === 'fa',
		`locale=${String(row?.locale)}`
	);
	check(
		'self_hosted is never stored',
		row?.privacy_mode === 'standard',
		`privacy_mode=${String(row?.privacy_mode)}`
	);

	await sub(101, { locale: 'zh-TW' });
	await sub(102, { locale: 'tlh' });
	const locales = (
		await db.query<{ endpoint: string; locale: string }>(
			"SELECT endpoint, locale FROM push_subscriptions WHERE account = $1 AND endpoint LIKE '%smoke-10_' ORDER BY endpoint",
			[ACCOUNT]
		)
	).rows.map((r) => r.locale);
	check(
		'zh-TW maps to zh-HK, an unknown tag to en',
		locales.join(',') === 'fa,zh-HK,en',
		`locales=${locales.join(',')}`
	);

	// Rows taken before the endpoint policy existed are removed on boot.
	await db.query('DELETE FROM push_subscriptions WHERE account = $1', [ACCOUNT]);
	for (const ep of [
		'https://fcm.googleapis.com/fcm/send/keep',
		'http://127.0.0.1:5432/',
		'https://10.0.0.5/x'
	]) {
		await db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode) VALUES ($1, $2, 'p', 'a', 'standard')`,
			[ACCOUNT, ep]
		);
	}
	const prune = (
		store as unknown as { pruneEndpointsOutsidePolicy?: (h: string[]) => Promise<number> }
	).pruneEndpointsOutsidePolicy;
	let pruned = -1;
	try {
		pruned = (await prune?.call(store, [])) ?? -1;
	} catch {
		pruned = -2;
	}
	const left = (
		await db.query<{ endpoint: string }>(
			'SELECT endpoint FROM push_subscriptions WHERE account = $1',
			[ACCOUNT]
		)
	).rows.map((r) => r.endpoint);
	check(
		'the boot sweep deletes stored endpoints outside the policy and keeps the rest',
		pruned === 2 && left.length === 1 && left[0] === 'https://fcm.googleapis.com/fcm/send/keep',
		`pruned=${pruned} left=${left.join(',')}`
	);
} finally {
	await pool.end().catch(() => {});
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
	await admin.end().catch(() => {});
}

console.log();
if (failures > 0) {
	console.log(`✗ ${failures} of ${n} push subscription store checks failed`);
	process.exit(1);
}
console.log(`✓ all ${n} push subscription store checks passed`);
