/**
 * fastNotifyBudget — a ceiling on how many fast NOTIFICATIONS one account can be
 * sent by people they have not yet answered.
 *
 * WHY THIS EXISTS
 *
 * The anti-stranger policy is unchanged and deliberately so: a person can still
 * be reached by someone they have never spoken to, as long as the message is
 * about one of their own live orders. That is the marketplace working — a buyer
 * has to be able to open a conversation with a seller, and the seller has to see
 * it within seconds or the feature is pointless.
 *
 * What changed in v1.18.0 is the PRICE of sending one. Before, every chat
 * message reached its recipient through a block, so it cost resource credits,
 * sat under the chain's own rate limiting, and left a public record. A message
 * pushed peer-to-peer costs a signature and a POST: free, unmetered, repeatable,
 * and invisible to anyone auditing the chain. Nothing about the GATE changed,
 * but a gate that was sized against an expensive channel is not the same gate on
 * a free one — the same policy, applied to unlimited attempts, is not the same
 * policy.
 *
 * So this restores the property the chain was quietly providing, and nothing
 * more: it does not decide WHO may notify whom, only how fast that may happen.
 *
 * WHAT IT DOES NOT TOUCH
 *
 *   - DELIVERY. A message still reaches an open chatroom unconditionally. A
 *     conversation the two people are looking at is not a notification, and
 *     throttling it would break the thing this release exists to make fast.
 *   - ESTABLISHED PAIRS. Once a recipient has replied — or once this instance
 *     has relayed a message from them to this sender — the pair is exempt. Two
 *     people in a conversation are not strangers, and a busy negotiation is
 *     exactly when you least want a cap.
 *   - THE DURABLE PATH. The chain delivers every one of these messages anyway,
 *     with its own admission rules. Spending the budget costs a notification's
 *     promptness, never the message.
 *
 * Bounded in both size and time, because it is attacker-facing: an attacker who
 * can make a table grow is an attacker who can exhaust memory, and a defence
 * that becomes the vulnerability is worse than none.
 */

/** Window over which unreplied first-contact notifications are counted. */
const WINDOW_MS = 60 * 1000;

/**
 * How many such notifications ONE SENDER may deliver to ONE RECIPIENT in that
 * window.
 *
 * THE KEY IS THE PAIR, AND THAT IS THE WHOLE DESIGN. A budget held per
 * RECIPIENT would be spendable by anybody: order permlinks are public, the
 * endpoint is deliberately unauthenticated, and a signed chat op costs about
 * fifty microseconds to mint offline. So one hostile account could empty a
 * seller's allowance every minute for free, and the next REAL buyer to message
 * that seller would get no push, no badge and no replay — a targeted denial of
 * exactly the thing this release exists to provide, aimed at the victim rather
 * than at the attacker. Keying on the pair means a flooder exhausts only their
 * own channel to that person, and everyone else still arrives with a full
 * allowance.
 *
 * What that deliberately does NOT bound is fan-in: many accounts each sending a
 * little. That is the right division of labour — creating Blurt accounts costs
 * real money, which is the same wall the chain path puts up, and the durable
 * path's own fan-in cap judges the aggregate with state this path does not have.
 *
 * Twenty is sized against what one honest stranger sends before giving up.
 */
const PER_PAIR_PER_WINDOW = 20;

/** Distinct sender→recipient pairs tracked. Past this the least recently used
 *  is forgotten, which only hands that pair back a full allowance — so the
 *  failure is toward delivery. */
const MAX_PAIRS = 20_000;

/** sender\u0000recipient → timestamps of recent first-contact notifications. */
const budget = new Map<string, number[]>();

function prune(now: number): void {
	// Only runs when the table is over its cap, which ordinary traffic never
	// reaches. Two passes: expired entries first, then least-recently-touched.
	if (budget.size <= MAX_PAIRS) return;
	const over = budget.size - MAX_PAIRS;
	let removed = 0;
	for (const [k, stamps] of budget) {
		if (removed >= over) break;
		const last = stamps[stamps.length - 1] ?? 0;
		if (now - last > WINDOW_MS) {
			budget.delete(k);
			removed++;
		}
	}
	// Still over (everything is recent): drop from the front. Every write below
	// re-anchors its key by deleting before setting, so insertion order really is
	// least-recently-touched order.
	for (const k of budget.keys()) {
		if (budget.size <= MAX_PAIRS) break;
		budget.delete(k);
	}
}

/**
 * Spend one unit of this SENDER's first-contact allowance toward this RECIPIENT.
 *
 * Returns whether the notification may go ahead. Call this ONLY for a sender the
 * recipient has not already engaged with — an established pair must never reach
 * it, or a lively conversation would throttle itself.
 */
export function spendFastNotifyBudget(
	sender: string,
	recipient: string,
	now: number = Date.now()
): boolean {
	const key = `${sender.toLowerCase()}\u0000${recipient.toLowerCase()}`;
	const cutoff = now - WINDOW_MS;
	const stamps = budget.get(key) ?? [];
	// Timestamps are appended in arrival order, so the expired ones are a prefix.
	let expired = 0;
	while (expired < stamps.length && (stamps[expired] ?? 0) <= cutoff) expired++;
	const live = expired > 0 ? stamps.slice(expired) : stamps;
	if (live.length >= PER_PAIR_PER_WINDOW) {
		// Re-anchored — delete THEN set, because `set` on a key that already
		// exists leaves it where it is in insertion order. Without the delete, a
		// pair under sustained refusal looks idle to the eviction above and is
		// thrown out first, which hands the flooder a fresh allowance. Not
		// recording the refused attempt is deliberate and separate: the window has
		// to drain on its own rather than be held open by the flood that filled
		// it.
		budget.delete(key);
		budget.set(key, live);
		return false;
	}
	live.push(now);
	budget.delete(key);
	budget.set(key, live);
	prune(now);
	return true;
}

/** Current number of tracked pairs. For /v1/health and for tests. */
export function fastNotifyBudgetSize(): number {
	return budget.size;
}

/** Test seam. */
export function _resetFastNotifyBudgetForTest(): void {
	budget.clear();
}
