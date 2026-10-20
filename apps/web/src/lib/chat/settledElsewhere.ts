/**
 * Morphit chat — "order settled with someone else" auto-reply SENDER.
 *
 * When an order owner completes their order with a chosen trader — they leave
 * feedback for that counterparty, which is what closes the trade — every OTHER
 * person who messaged about that order gets a friendly, localized auto-reply so
 * they aren't left hanging. The owner writes nothing: the message is a
 * text-free `order_settled_elsewhere` structured payload (see payload.ts), and
 * each recipient's client renders the (approved) copy in THEIR own locale.
 *
 * Client-side because the message is E2E-encrypted PER recipient — the indexer
 * can't encrypt on anyone's behalf. Best-effort throughout: a failure for one
 * inquirer never blocks the others, and the whole thing never blocks the
 * completion (which is already irreversible on-chain by the time we run).
 *
 * ── Admission (why this lands) ──────────────────────────────────────────────
 * The auto-reply (owner → inquirer) does NOT use the order-response bypass:
 * that bypass requires the order to be owned by the RECIPIENT, but here the
 * owner is the SENDER. Instead it rides the stranger gate's "the recipient
 * already messaged me" condition (handlers/chat.ts) — which holds because the
 * inquirer sent the original message first. So the auto-reply is admitted iff
 * the original inquiry was stored. If a delivery fault dropped the inquiry, its
 * reply is dropped too: the two are coupled by construction, not by accident.
 * The order_permlink we attach is the THREAD TAG (checkChatOrder finds the
 * order — owned by the sender, one of the two parties — so the durable handler
 * keeps the tag), which pins the reply into the right (inquirer, order) thread.
 */
import type { LiveIdentity } from '$crypto/keygen';
import { encodeOrderSettledElsewherePayload } from '$lib/chat/payload';
import { unsealSettled } from '$lib/chat/unsealGate';

/** The encrypted envelope shape returned by `encrypt`. */
interface ChatEnvelope {
	/** 2 for the sender-authenticated envelope (chat keys), 3 for the
	 *  posting-key envelope. */
	readonly v?: 2 | 3;
	readonly ciphertext: string;
	readonly ephemeralPub: string;
	readonly nonce: string;
	readonly selfCiphertext?: string;
	readonly selfNonce?: string;
	readonly senderKey?: string;
	readonly recipientKeys?: readonly string[];
	readonly wraps?: readonly string[];
}

/** Injected so the announcer is unit-testable without the browser / chain. */
export interface SettledElsewhereDeps {
	/** The accounts who messaged the owner about THIS order (self already
	 *  excluded server-side). Sourced from the order-counterparties endpoint,
	 *  so it enumerates EVERY inquirer on the order and is NOT bounded by the
	 *  owner's total-inbox cap — a busy owner still reaches everyone. */
	fetchOrderInquirers(owner: string, orderPermlink: string): Promise<readonly string[]>;
	/** The peer's published X25519 chat pubkey, or null if never published. */
	fetchPeerChatPub(peer: string): Promise<Uint8Array | null>;
	/** The owner's chat identity (derived once, reused across recipients). */
	deriveMyChatIdentity(
		live: LiveIdentity,
		account: string
	): Promise<{ priv: Uint8Array; pub: Uint8Array }>;
	/** Encrypt plaintext to a recipient (v2: `sender` is the owner's own chat
	 *  identity, which authenticates the message). */
	encrypt(
		plaintext: string,
		recipientPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string,
		sender: { priv: Uint8Array; pub: Uint8Array },
		includeSelfCopy: boolean
	): Promise<ChatEnvelope>;
	/** Broadcast a chat custom_json op.
	 *
	 *  `block_num` is null because a chat message does not wait for a block —
	 *  see broadcastChatMessage. This announcer discards the result either way;
	 *  it awaits only so a failed send can be counted. */
	broadcast(
		live: LiveIdentity,
		payload: Record<string, unknown>,
		blurtAccount: string
	): Promise<{ block_num: number | null; trx_id: string }>;
	/** 32-char hex client tag. */
	generateClientTag(): string;
	/** v1.21.13 — the posting-key envelope (v3), as the conversation uses it
	 *  (chatService.seal): an inquirer with no chat key, or an owner with none,
	 *  still gets the auto-reply. Optional: absent, such inquirers are skipped
	 *  as before. */
	fetchPostingPubs?(account: string): Promise<Uint8Array[] | null>;
	/** Our own chat key's status (chatService.ownChatKeyStatus): only
	 *  'current' sends v2. Throws when unknown — then nothing is sent. */
	myChatKeyStatus?(): Promise<'current' | 'stale' | 'none'>;
	/** The posting keys to use for `peer`, through the same pins as the
	 *  conversation (a changed set throws, and that inquirer is not written
	 *  to). Absent: the chain's keys (tests). */
	pinPostingKey?(
		peer: string,
		chainKeys: readonly Uint8Array[],
		opts?: { needsConsent?: boolean }
	): Promise<Uint8Array[]>;
	/** The chat keys pinned for `peer`: a pinned peer whose key the indexer
	 *  now calls absent is not written to (no silent move to posting keys). */
	pinnedPeerPubs?(peer: string): readonly Uint8Array[];
	encryptPosting?(
		plaintext: string,
		recipientPostingPubs: readonly Uint8Array[],
		live: LiveIdentity,
		senderAccount: string,
		recipientAccount: string,
		includeSelfCopy: boolean
	): Promise<ChatEnvelope>;
}

export interface SettledElsewhereResult {
	/** Inquirers we successfully sent the auto-reply to. */
	readonly sent: number;
	/** Inquirers skipped because they could not be encrypted to: no chat key
	 *  and (without the posting-key envelope) nothing else, or no such account
	 *  on chain. Harmless — they simply get no auto-reply. */
	readonly skipped: number;
	/** Inquirers whose send threw (best-effort — did not block the rest). */
	readonly failed: number;
}

/**
 * Send the auto-reply to every OTHER inquirer on a just-completed order.
 * Enumerates the inquirers on `orderPermlink` (everyone who messaged the owner
 * about it), excludes the counterparty
 * they actually traded with (and the owner themselves), and E2E-sends each
 * remaining inquirer the text-free system message.
 *
 * Never throws; returns per-recipient tallies.
 */
export async function announceSettledElsewhere(
	deps: SettledElsewhereDeps,
	args: { orderPermlink: string; counterparty: string; me: string; live: LiveIdentity }
): Promise<SettledElsewhereResult> {
	const { orderPermlink, counterparty, me, live } = args;

	// 1. Enumerate the OTHER inquirers on this order — everyone who messaged us
	//    about it (per-order, so complete regardless of how busy our inbox is),
	//    minus the counterparty we actually traded with and ourselves (self is
	//    already excluded server-side; the check is defensive).
	let peers: readonly string[];
	try {
		peers = await deps.fetchOrderInquirers(me, orderPermlink);
	} catch {
		return { sent: 0, skipped: 0, failed: 0 };
	}
	const inquirers = new Set<string>();
	for (const peer of peers) {
		if (peer !== counterparty && peer !== me) inquirers.add(peer);
	}
	if (inquirers.size === 0) return { sent: 0, skipped: 0, failed: 0 };

	// 2. Derive our chat identity once (reused for every recipient), and encode
	//    the text-free wire once — the same payload goes to everyone; only the
	//    per-recipient encryption differs.
	let myId: { priv: Uint8Array; pub: Uint8Array };
	try {
		myId = await deps.deriveMyChatIdentity(live, me);
	} catch {
		return { sent: 0, skipped: 0, failed: 0 };
	}
	const wire = encodeOrderSettledElsewherePayload({
		v: 1,
		kind: 'morphit_order_settled_elsewhere',
		orderPermlink
	});

	// 3. E2E-send to each inquirer, best-effort.
	let sent = 0;
	let skipped = 0;
	let failed = 0;
	// The pins a Lock sealed are read only once the unlock's unseal landed.
	await unsealSettled();
	const postingCapable = deps.fetchPostingPubs !== undefined && deps.encryptPosting !== undefined;
	// The same choice as a conversation's send (chatService.seal): our own
	// status first; v2 only when ours is current and the inquirer has a chat
	// key; otherwise v3 to their PINNED posting keys, every one of them.
	let mine: 'current' | 'stale' | 'none' | null = 'current';
	if (postingCapable && deps.myChatKeyStatus !== undefined) {
		mine = await deps.myChatKeyStatus().catch(() => null);
	}
	for (const peer of inquirers) {
		try {
			if (mine === null) throw new Error('own chat key status unknown');
			const peerPub = mine === 'current' ? await deps.fetchPeerChatPub(peer) : null;
			if (
				mine === 'current' &&
				peerPub === null &&
				(deps.pinnedPeerPubs?.(peer) ?? []).length > 0
			) {
				throw new Error('a pinned chat key the indexer calls absent');
			}
			let envelope: ChatEnvelope;
			// Keep a sender self-copy so the owner can reread the auto-reply in
			// their own thread with this inquirer (matches keep-history default).
			if (peerPub !== null) {
				envelope = await deps.encrypt(wire, peerPub, me, peer, myId, true);
			} else if (postingCapable) {
				const pubs = await deps.fetchPostingPubs!(peer);
				if (pubs === null || pubs.length === 0) {
					skipped++;
					continue;
				}
				const targets =
					deps.pinPostingKey !== undefined
						? await deps.pinPostingKey(peer, pubs, {
								// A peer whose chat key is pinned: no posting keys on first use.
								needsConsent: (deps.pinnedPeerPubs?.(peer) ?? []).length > 0
							})
						: pubs;
				envelope = await deps.encryptPosting!(wire, targets, live, me, peer, true);
			} else {
				// No chat key and no other way to encrypt to them.
				skipped++;
				continue;
			}
			const payload: Record<string, unknown> = {
				recipient: peer,
				ciphertext: envelope.ciphertext,
				header: {
					...(envelope.v === 2 || envelope.v === 3 ? { v: envelope.v } : {}),
					client_tag: deps.generateClientTag(),
					ephemeral_pub: envelope.ephemeralPub,
					nonce: envelope.nonce,
					...(envelope.senderKey !== undefined &&
					envelope.recipientKeys !== undefined &&
					envelope.wraps !== undefined
						? { sk: envelope.senderKey, rk: [...envelope.recipientKeys], wk: [...envelope.wraps] }
						: {}),
					...(envelope.selfCiphertext !== undefined && envelope.selfNonce !== undefined
						? { self_ciphertext: envelope.selfCiphertext, self_nonce: envelope.selfNonce }
						: {})
				},
				// Thread tag — pins the reply into the (inquirer, order) thread.
				order_permlink: orderPermlink
			};
			await deps.broadcast(live, payload, me);
			sent++;
		} catch {
			// Best-effort: one recipient's failure never blocks the others.
			failed++;
		}
	}
	return { sent, skipped, failed };
}
