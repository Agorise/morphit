/**
 * Runtime deps for the "order settled with someone else" auto-reply sender
 * (t.txt #5). Kept SEPARATE from settledElsewhere.ts so the announcer's pure
 * logic stays unit-testable without dragging in the chat/crypto/indexer stack.
 *
 * The chat primitives (fetchPeerChatPub, encrypt, broadcast, identity, client-
 * tag) don't depend on the controller's bound `peer` — they all take the
 * recipient as an argument — so we borrow them from a single `runtimeDeps`
 * rather than re-implementing the (security-sensitive) TOFU-pin and envelope
 * logic here.
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
		fetchPeerChatPub: base.fetchPeerChatPub,
		deriveMyChatIdentity: base.deriveMyChatIdentity,
		encrypt: base.encrypt,
		broadcast: base.broadcast,
		generateClientTag: base.generateClientTag
	};
}
