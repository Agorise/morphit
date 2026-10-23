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
import { WRITE_ENVELOPE_V4, type EnvelopeBinding } from '$lib/chat/crypto';
import { sendBinding } from '$lib/chat/envelopeBinding';

/** The encrypted envelope shape returned by `encryptPosting`. */
interface ChatEnvelope {
	/** The envelope version: encryptPosting makes 3 (the posting-key
	 *  envelope, the only one sent since v1.21.14), or 4 when given a binding
	 *  (v3 bound to the order and the send time `t`, review C-M2). */
	readonly v?: 2 | 3 | 4;
	readonly t?: number;
	readonly o?: string;
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
	/** The posting-key envelope (v3), exactly as a conversation sends
	 *  (chatService.seal): since v1.21.14 the only format a message is sent in
	 *  — chat relies on the posting key only. The inquirer's posting keys as
	 *  the chain lists them; [] when it has none of its own, null when there
	 *  is no such account. */
	fetchPostingPubs(account: string): Promise<Uint8Array[] | null>;
	/** The posting keys to use for `peer`, through the same pins as the
	 *  conversation: trusted on first use; a changed set throws, and that
	 *  inquirer is not written to. Absent: the chain's keys (tests). */
	pinPostingKey?(peer: string, chainKeys: readonly Uint8Array[]): Promise<Uint8Array[]>;
	encryptPosting(
		plaintext: string,
		recipientPostingPubs: readonly Uint8Array[],
		live: LiveIdentity,
		senderAccount: string,
		recipientAccount: string,
		includeSelfCopy: boolean,
		binding?: EnvelopeBinding
	): Promise<ChatEnvelope>;
	/** Write v4 (WRITE_ENVELOPE_V4 when absent; tests turn it on). */
	writeEnvelopeV4?: boolean;
	/** The chain's head time, whole seconds (v4's bound send time). Absent:
	 *  this device's clock. */
	chainNowSeconds?(): Promise<number>;
}

export interface SettledElsewhereResult {
	/** Inquirers we successfully sent the auto-reply to. */
	readonly sent: number;
	/** Inquirers skipped because they could not be encrypted to: no such
	 *  account on chain, or no posting key of its own. Harmless — they simply
	 *  get no auto-reply. */
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

	// 2. Encode the text-free wire once — the same payload goes to everyone;
	//    only the per-recipient encryption differs.
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
	for (const peer of inquirers) {
		try {
			// Always the posting-key envelope (v3) to the inquirer's PINNED posting
			// keys, like every message of a conversation (chatService.seal) —
			// trusted on first use whatever chat key of theirs is pinned here.
			// Keep a sender self-copy so the owner can reread the auto-reply in
			// their own thread with this inquirer (matches keep-history default).
			const pubs = await deps.fetchPostingPubs(peer);
			if (pubs === null || pubs.length === 0) {
				skipped++;
				continue;
			}
			const targets =
				deps.pinPostingKey !== undefined ? await deps.pinPostingKey(peer, pubs) : pubs;
			// v4: bound to the order thread it goes to (ours: we posted the
			// order), and the chain's time — or v3 (sendBinding).
			const binding: EnvelopeBinding | undefined = await sendBinding({
				write: deps.writeEnvelopeV4 ?? WRITE_ENVELOPE_V4,
				order: orderPermlink,
				ownerOf: () => Promise.resolve(me),
				chainNowSeconds:
					deps.chainNowSeconds ?? (() => Promise.resolve(Math.floor(Date.now() / 1000)))
			});
			const envelope = await deps.encryptPosting(
				wire,
				targets,
				live,
				me,
				peer,
				true,
				...(binding !== undefined ? [binding] : [])
			);
			const payload: Record<string, unknown> = {
				recipient: peer,
				ciphertext: envelope.ciphertext,
				header: {
					...(envelope.v !== undefined ? { v: envelope.v } : {}),
					...(envelope.v === 4 ? { t: envelope.t, o: envelope.o } : {}),
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
