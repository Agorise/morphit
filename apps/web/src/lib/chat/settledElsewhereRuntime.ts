/**
 * Runtime deps for the "order settled with someone else" auto-reply sender.
 * Kept SEPARATE from settledElsewhere.ts so the announcer's pure
 * logic stays unit-testable without dragging in the chat/crypto/indexer stack.
 *
 * The chat primitives (posting keys, envelope, broadcast, client-tag) don't
 * depend on the controller's bound `peer` — they all take the recipient as an
 * argument — so we borrow them from a single `runtimeDeps` rather than
 * re-implementing the (security-sensitive) pin and envelope logic here.
 */
import type { LiveIdentity } from '$crypto/keygen';
import { runtimeDeps } from '$lib/chat/chatService';
import { getOrderCounterparties } from '$lib/indexer/client';
import type { SettledElsewhereDeps } from '$lib/chat/settledElsewhere';

export function runtimeSettledElsewhereDeps(
	me: string,
	getLive: () => LiveIdentity | null
): SettledElsewhereDeps {
	const base = runtimeDeps(me, me, getLive);
	return {
		fetchOrderInquirers: async (owner: string, orderPermlink: string) => {
			// limit 500 (the endpoint's hard cap) so we reach EVERY inquirer on a
			// popular order, not just the default candidate slice /my/orders uses.
			const r = await getOrderCounterparties(owner, orderPermlink, { limit: 500 });
			return r.ok ? r.data.items.map((i) => i.peer) : [];
		},
		broadcast: base.broadcast,
		generateClientTag: base.generateClientTag,
		fetchPostingPubs: base.fetchPostingPubs,
		pinPostingKey: base.pinPostingKey,
		encryptPosting: base.encryptPosting,
		...(base.chainNowSeconds !== undefined ? { chainNowSeconds: base.chainNowSeconds } : {})
	};
}
