#!/usr/bin/env tsx
/*
 * push-dedup-survives-delivery — v1.5.5 (t155) guard.
 *
 * Ken: "kentest3 received the SYSTEM notification TWICE... the first system
 * notif arrives in under 6 seconds which is great. a second notif arrives
 * though about a minute later."
 *
 * ROOT CAUSE. Both delivery paths enqueue the same message keyed on its
 * on-chain trx id, and `ON CONFLICT (account, source_trx_id) DO NOTHING` is
 * what collapses them into one push. But the relay's sender DELETED the row as
 * soon as it delivered it (~5s), while the durable handler enqueues ~60s later
 * — by which time there was nothing left to conflict with, so it inserted and
 * fired a SECOND notification. The dedup could only ever have worked if the
 * durable insert lost a race it wins by ~55 seconds.
 *
 * WHY THE EXISTING SMOKE MISSED IT. chat-fast-notification-smoke pins the
 * enqueue's ON CONFLICT clause and passes — because it never runs the SENDER.
 * The bug lives in the interaction between the two, so this smoke models the
 * real SEQUENCE: enqueue fast → deliver → enqueue durable → count rows.
 *
 * Scenarios 1-7 are FUNCTIONAL tests against an in-memory stand-in for the
 * queue's semantics (claim / retire / conflict / prune). Scenario 8 pins the
 * REAL sender source, because a model alone can't stop someone reverting it to
 * DELETE — and a guard that can't fail on the regression it exists for is
 * theatre.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function ok(msg: string): void {
	pass++;
	console.log(`  ✓ ${msg}`);
}
function bad(scope: string, msg: string): void {
	fail++;
	console.log(`  ✗ ${scope}: ${msg}`);
}

interface Row {
	id: number;
	account: string;
	source_trx_id: string | null;
	sent_at: number | null;
}

/** Models push_pending + the partial UNIQUE (account, source_trx_id)
 *  WHERE source_trx_id IS NOT NULL, plus the sender's claim/retire. */
class Queue {
	rows: Row[] = [];
	private seq = 1;

	/** INSERT ... ON CONFLICT (account, source_trx_id) DO NOTHING. */
	enqueue(account: string, trx: string | null): boolean {
		if (trx !== null && this.rows.some((r) => r.account === account && r.source_trx_id === trx)) {
			return false; // conflict → no-op, exactly one notification
		}
		this.rows.push({ id: this.seq++, account, source_trx_id: trx, sent_at: null });
		return true;
	}

	/** The sender claims unsent rows and retires them by STAMPING. */
	deliver(nowMs: number): number {
		const claimed = this.rows.filter((r) => r.sent_at === null);
		for (const r of claimed) r.sent_at = nowMs;
		return claimed.length;
	}

	prune(nowMs: number, retentionMs: number): number {
		const before = this.rows.length;
		this.rows = this.rows.filter((r) => r.sent_at === null || nowMs - r.sent_at < retentionMs);
		return before - this.rows.length;
	}
}

const HOUR = 3600_000;
const TRX = 'abc123def456';

// ── 1. THE BUG: fast enqueue → delivered → durable enqueue ──────────
{
	const q = new Queue();
	q.enqueue('kentest3', TRX); // fast tailer, ~5s
	const delivered = q.deliver(5_000); // relay sends it → ONE notification
	q.enqueue('kentest3', TRX); // durable handler, ~60s later
	const notifications = delivered + q.rows.filter((r) => r.sent_at === null).length;
	if (notifications === 1) {
		ok('the durable enqueue after delivery does NOT produce a second notification');
	} else {
		bad(
			'duplicate',
			`${notifications} notifications for one message — the delivered row must survive as the dedup tombstone (this is exactly Ken's "first in 6s, second a minute later")`
		);
	}
}

// ── 2. The row must OUTLIVE delivery ────────────────────────────────
{
	const q = new Queue();
	q.enqueue('kentest3', TRX);
	q.deliver(5_000);
	if (q.rows.length === 1 && q.rows[0]!.sent_at !== null) {
		ok('a delivered row is retired by stamping sent_at, not deleted');
	} else {
		bad('tombstone', 'the row vanished on delivery — the dedup key dies with it');
	}
}

// ── 3. The sender must not re-send a retired row ────────────────────
{
	const q = new Queue();
	q.enqueue('kentest3', TRX);
	q.deliver(5_000);
	const again = q.deliver(10_000);
	if (again === 0) {
		ok('the sender claims only unsent rows (a tombstone is never re-delivered)');
	} else {
		bad('re-send', 'a retired row was delivered again — retention would spam every tick');
	}
}

// ── 4. Retention must outlive the fast→durable gap ──────────────────
{
	const q = new Queue();
	q.enqueue('kentest3', TRX);
	q.deliver(5_000);
	q.prune(5_000 + 60_000, HOUR); // pruner runs while the durable path is still coming
	const inserted = q.enqueue('kentest3', TRX);
	if (!inserted) {
		ok('the tombstone still dedups a durable enqueue ~60s later (retention > the gap)');
	} else {
		bad(
			'retention',
			'the tombstone was pruned before the durable path arrived — the duplicate comes straight back'
		);
	}
}

// ── 5. …but the table still gets reclaimed ──────────────────────────
{
	const q = new Queue();
	q.enqueue('kentest3', TRX);
	q.deliver(5_000);
	const pruned = q.prune(5_000 + HOUR + 1, HOUR);
	if (pruned === 1 && q.rows.length === 0) {
		ok('tombstones are reclaimed once past the retention window (table stays bounded)');
	} else {
		bad('prune', 'retired rows are never reclaimed — push_pending grows without bound');
	}
}

// ── 6. NULL trx ids must not collapse into each other ───────────────
// featureBid/feedback enqueue with no source_trx_id; the partial index ignores
// NULLs, so two of them are two notifications, not one.
{
	const q = new Queue();
	q.enqueue('kentest3', null);
	q.enqueue('kentest3', null);
	if (q.rows.length === 2) {
		ok('rows without a trx id never dedup against each other (partial index ignores NULLs)');
	} else {
		bad('null-key', 'two independent notifications collapsed into one');
	}
}

// ── 7. Different accounts are independent ───────────────────────────
{
	const q = new Queue();
	q.enqueue('kentest3', TRX);
	q.enqueue('kentest2', TRX);
	if (q.rows.length === 2) {
		ok('the dedup key is (account, trx) — one message can notify both parties');
	} else {
		bad('key-scope', 'a second account was starved of its notification');
	}
}

// ── 8. …and the REAL sender must actually behave this way ───────────
// Scenarios 1-7 model the queue's semantics. That proves the DESIGN, but a
// model can't stop someone reverting the sender to `DELETE ... WHERE id` —
// the smoke would sail on while Ken's duplicate came straight back. So pin
// the real source too: a guard that can't fail on the actual regression it
// exists for is theatre.
{
	const src = readFileSync(resolve(HERE, '../src/policy/pushSender.ts'), 'utf8');
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const flat = code.replace(/\s+/g, ' ');

	if (!/DELETE FROM push_pending WHERE id/.test(flat)) {
		ok('the real sender never DELETEs a row on delivery');
	} else {
		bad(
			'source',
			'pushSender still deletes the row it just delivered — that destroys the (account, source_trx_id) dedup key ~55s before the durable enqueue arrives, which IS the duplicate-notification bug'
		);
	}

	if (/FROM push_pending WHERE sent_at IS NULL/.test(flat)) {
		ok('the real sender claims only unsent rows');
	} else {
		bad('source', 'the claim query does not filter on sent_at IS NULL — retained tombstones would be re-delivered every tick');
	}

	if (/UPDATE push_pending SET sent_at = NOW\(\) WHERE id/.test(flat)) {
		ok('the real sender retires rows by stamping sent_at');
	} else {
		bad('source', 'no sent_at stamp found — rows must outlive delivery to act as dedup tombstones');
	}

	if (/DELETE FROM push_pending WHERE sent_at IS NOT NULL/.test(flat) && /await this\.prune\(\)/.test(flat)) {
		ok('a pruner exists AND is actually called from the loop');
	} else {
		bad(
			'source',
			'retained rows are never reclaimed (or prune() is defined but never invoked) — push_pending would grow without bound now that delivery no longer deletes'
		);
	}
}

console.log('\n' + '─'.repeat(58));
if (fail === 0) {
	console.log(`✓ all ${pass} push-dedup-survives-delivery scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
