/**
 * Morphit chat — "order settled with someone else" auto-reply SENDER (t.txt #5).
 *
 * When an order owner completes their order with a chosen trader — they leave
 * feedback for that counterparty, which is what closes the trade — every OTHER
 * person who messaged about that order gets a friendly, localized auto-reply so
 * they aren't left hanging. The owner writes nothing: the message is a
 * text-free `order_settled_elsewhere` structured payload (see payload.ts), and
 * each recipient's client renders the (Ken-approved) copy in THEIR own locale.
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

/** The encrypted envelope shape returned by `encrypt`. */
interface ChatEnvelope {
	readonly ciphertext: string;
	readonly ephemeralPub: string;
	readonly nonce: string;
	readonly selfCiphertext?: string;
	readonly selfNonce?: string;
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
	/** Encrypt plaintext to a recipient. */
	encrypt(
		plaintext: string,
		recipientPub: Uint8Array,
		senderAccount: string,
		recipientAccount: string,
		senderChatPub: Uint8Array,
		includeSelfCopy: boolean
	): Promise<ChatEnvelope>;
	/** Broadcast a chat custom_json op. */
	broadcast(
		live: LiveIdentity,
		payload: Record<string, unknown>,
		blurtAccount: string
	): Promise<{ block_num: number; trx_id: string }>;
	/** 32-char hex client tag. */
	generateClientTag(): string;
}

export interface SettledElsewhereResult {
	/** Inquirers we successfully sent the auto-reply to. */
	readonly sent: number;
	/** Inquirers skipped because they never published a chat identity (we
	 *  can't encrypt to them; harmless — they simply get no auto-reply). */
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
	for (const peer of inquirers) {
		try {
			const peerPub = await deps.fetchPeerChatPub(peer);
			if (peerPub === null) {
				// The inquirer never published a chat identity — can't encrypt to
				// them. Harmless: they simply receive no auto-reply.
				skipped++;
				continue;
			}
			// Keep a sender self-copy so the owner can reread the auto-reply in
			// their own thread with this inquirer (matches keep-history default).
			const envelope = await deps.encrypt(wire, peerPub, me, peer, myId.pub, true);
			const payload: Record<string, unknown> = {
				recipient: peer,
				ciphertext: envelope.ciphertext,
				header: {
					client_tag: deps.generateClientTag(),
					ephemeral_pub: envelope.ephemeralPub,
					nonce: envelope.nonce,
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

