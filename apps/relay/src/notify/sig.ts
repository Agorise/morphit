/**
 * Offline notices — every request about a user's notices is signed with her
 * posting key, like the Web Push subscribe (policy/pushSubscribeSig.ts).
 *
 * Canonical message, joined by ':' and hashed (SHA-256) before signing:
 *
 *   morphit:notify:<action>:<audience>:<account>:<nonce>:<sha256 hex of the payload>:<timestamp>
 *
 * The ACTION keeps one request's signature from being replayed as another; the
 * AUDIENCE is this site (GET /v1/notify/channels says which), so a request she
 * signed for another instance she uses cannot be replayed here by its
 * operator; the payload hash binds the fields (the channel, the address, the
 * code, the link token); the timestamp limits a signature to five minutes, and
 * within them each one is accepted ONCE (the random nonce makes every request
 * unique, so two identical ones in the same second still differ). Even the
 * status read is signed: whether an account has offline notices on is hers.
 *
 * The posting public key comes from the chain, cached for two minutes (the
 * presence heartbeat signs once a minute; a key she rotates stops working
 * within two).
 */

import { createHash } from 'node:crypto';
import { PublicKey, Signature } from '@beblurt/dblurt';

/** All the verifier needs from the chain client (BlurtClient.postingKeyAgreed
 *  satisfies it). Declared here so this module imports nothing else of the
 *  relay: the web app's test runs the browser's signing against this very
 *  verifier. `{ key }` — null when there is no such account or no posting
 *  key; null when the RPC operators could not be asked or did not agree. */
export interface PostingKeySource {
	postingKeyAgreed(name: string): Promise<{ readonly key: string | null } | null>;
}

export const NOTIFY_ACTIONS = [
	'status',
	'set',
	'verify',
	'remove',
	'cancel',
	'here',
	'open',
	'telegram'
] as const;
export type NotifyAction = (typeof NOTIFY_ACTIONS)[number];

const MAX_SKEW_SECONDS = 5 * 60;
/** Short: a key she rotated (say, after it leaked) must stop working soon. */
const KEY_CACHE_MS = 2 * 60_000;
/** How long a key last seen on the chain may still be used, without asking
 *  the chain again, by a request from an IP that has used up its failures
 *  (one IP may be every Tor visitor): her request is not held back by
 *  someone else's flood. The first request it lets through refreshes it. */
export const KEY_STALE_OK_MS = 24 * 60 * 60_000;
/** Keys remembered at most; the least recently used go first. */
export const MAX_KEYS = 50_000;
/** Accepted requests remembered at most (each for ten minutes at most)… */
export const MAX_REMEMBERED = 100_000;
/** …and at most this many per account, so one account filling the memory
 *  refuses only itself (the per-account limits allow far fewer). */
export const MAX_REMEMBERED_PER_ACCOUNT = 300;

export type NotifySigError =
	| 'timestamp_out_of_range'
	| 'unknown_account'
	| 'no_posting_key_on_chain'
	| 'malformed_signature'
	| 'signature_mismatch'
	| 'chain_unreachable'
	| 'replayed';

/** The message a client signs. PURE; mirrored in apps/web/src/lib/notifications/offlineNotify.ts. */
export function notifyCanonical(
	action: NotifyAction,
	audience: string,
	account: string,
	nonce: string,
	payload: string,
	timestamp: number
): string {
	const payloadHash = createHash('sha256').update(payload, 'utf8').digest('hex');
	return `morphit:notify:${action}:${audience}:${account}:${nonce}:${payloadHash}:${timestamp}`;
}

/** The signed payload of each action. PURE; mirrored in the web client. */
export function notifyPayload(action: NotifyAction, b: Record<string, unknown>): string {
	switch (action) {
		case 'set':
			return `${String(b.channel)}\n${String(b.address ?? '')}\n${String(b.locale)}\n${String(b.net ?? 'clearnet')}`;
		case 'verify':
			return `${String(b.channel)}\n${String(b.code)}`;
		case 'remove':
		case 'cancel':
			return String(b.channel);
		case 'open':
			return String(b.token);
		default:
			return '';
	}
}

/** A request's signed parts, as the browser sent them. */
export interface SignedRequest {
	readonly action: NotifyAction;
	readonly account: string;
	readonly nonce: string;
	readonly payload: string;
	readonly timestamp: number;
	readonly signature: string;
}

const NONCE_RE = /^[0-9a-f]{32}$/;

/** What a signature check found, and whether it cost anything. */
export type NotifyCheck =
	| { ok: true }
	| {
			ok: false;
			reason: NotifySigError;
			/** The chain was asked (an RPC call), or a signature was checked (CPU). */
			costly: boolean;
	  };

export class NotifySigVerifier {
	/** account → its posting key as the chain agreed (null: none), when the
	 *  chain said so. Map order = least recently used first. */
	private readonly keys = new Map<string, { key: string | null; at: number }>();
	/** account → (nonce → until): requests already accepted, until they could
	 *  no longer pass the clock check. */
	private readonly used = new Map<string, Map<string, number>>();
	private usedCount = 0;
	private readonly refreshing = new Set<string>();

	constructor(
		private readonly chain: PostingKeySource,
		/** This site, as GET /v1/notify/channels names it to the browser. */
		readonly audience: string,
		private readonly now: () => number = Date.now,
		private readonly maxKeys: number = MAX_KEYS
	) {}

	private remember(account: string, key: string | null): void {
		this.keys.delete(account);
		this.keys.set(account, { key, at: this.now() });
		if (this.keys.size > this.maxKeys) {
			// The least recently used first: an active user is never pushed out
			// by a flood of made-up names.
			const oldest = this.keys.keys().next().value;
			if (oldest !== undefined) this.keys.delete(oldest);
		}
	}

	private async lookUp(account: string): Promise<string | null | 'unreachable'> {
		let agreed: { readonly key: string | null } | null;
		try {
			agreed = await this.chain.postingKeyAgreed(account);
		} catch {
			return 'unreachable';
		}
		if (agreed === null) return 'unreachable';
		this.remember(account, agreed.key);
		return agreed.key;
	}

	/** Ask the chain again in the background (once at a time per account). */
	private refresh(account: string): void {
		if (this.refreshing.has(account)) return;
		this.refreshing.add(account);
		void this.lookUp(account).finally(() => this.refreshing.delete(account));
	}

	/**
	 * Is a key for this account known without asking the chain: fresh (two
	 * minutes), or — `staleOk` — seen on the chain within a day?
	 */
	knowsKey(account: string, staleOk = false): boolean {
		const hit = this.keys.get(account);
		if (hit === undefined || hit.key === null) return false;
		return this.now() - hit.at < (staleOk ? KEY_STALE_OK_MS : KEY_CACHE_MS);
	}

	/** Was this request (account and nonce) accepted before? */
	private seen(account: string, nonce: string): boolean {
		const until = this.used.get(account)?.get(nonce);
		return until !== undefined && until >= this.now();
	}

	/**
	 * Remember an accepted request by its account and nonce; false when that
	 * pair was accepted before, or the memory is full. NOT by the signature
	 * text: the same signature can be written several ways (upper-case hex,
	 * another recovery byte, trailing junk, the high-S twin) and every one
	 * verifies — but the nonce is inside what was signed, so any copy of one
	 * request carries the same pair. Entries live until their timestamp could
	 * no longer pass the clock check. An unexpired entry is never forgotten:
	 * when the memory is full of them, new requests are refused rather than
	 * old ones made replayable — per account first, so one account filling it
	 * refuses only itself. Call it only once the request is otherwise allowed
	 * (the per-account limits), so a refused request takes no room.
	 */
	commit(account: string, nonce: string, timestamp: number): boolean {
		const t = this.now();
		let mine = this.used.get(account);
		if (mine?.has(nonce) && (mine.get(nonce) ?? 0) >= t) return false;
		if (mine) {
			for (const [n, until] of mine)
				if (until < t) {
					mine.delete(n);
					this.usedCount--;
				}
			if (mine.size >= MAX_REMEMBERED_PER_ACCOUNT) return false;
		}
		if (this.usedCount >= MAX_REMEMBERED) {
			for (const [a, m] of this.used) {
				for (const [n, until] of m)
					if (until < t) {
						m.delete(n);
						this.usedCount--;
					}
				if (m.size === 0) this.used.delete(a);
			}
			if (this.usedCount >= MAX_REMEMBERED) return false;
		}
		if (!mine) {
			mine = new Map();
			this.used.set(account, mine);
		}
		mine.set(nonce, (timestamp + MAX_SKEW_SECONDS) * 1000 + 1000);
		this.usedCount++;
		return true;
	}

	/**
	 * Check a request's signature without accepting it ({@link commit} does).
	 * `cachedOnly`: never ask the chain (a known key or a refusal);
	 * `staleOk`: a key seen on the chain within a day will do.
	 */
	async check(
		r: SignedRequest,
		opts: { readonly cachedOnly?: boolean; readonly staleOk?: boolean } = {}
	): Promise<NotifyCheck> {
		const nowSec = Math.floor(this.now() / 1000);
		if (!Number.isFinite(r.timestamp) || Math.abs(nowSec - r.timestamp) > MAX_SKEW_SECONDS) {
			return { ok: false, reason: 'timestamp_out_of_range', costly: false };
		}
		if (!NONCE_RE.test(r.nonce)) return { ok: false, reason: 'malformed_signature', costly: false };
		let sig: Signature;
		try {
			sig = Signature.fromString(r.signature);
		} catch {
			return { ok: false, reason: 'malformed_signature', costly: false };
		}
		if (this.seen(r.account, r.nonce)) return { ok: false, reason: 'replayed', costly: false };
		const hit = this.keys.get(r.account);
		if (hit !== undefined) {
			// Recently used: last to go.
			this.keys.delete(r.account);
			this.keys.set(r.account, hit);
		}
		const age = hit === undefined ? Infinity : this.now() - hit.at;
		let key: string | null | 'unreachable';
		let asked = false;
		if (hit !== undefined && age < KEY_CACHE_MS) key = hit.key;
		else if (hit !== undefined && hit.key !== null && opts.staleOk && age < KEY_STALE_OK_MS)
			key = hit.key;
		else if (opts.cachedOnly) return { ok: false, reason: 'chain_unreachable', costly: false };
		else {
			key = await this.lookUp(r.account);
			asked = true;
		}
		if (key === 'unreachable') return { ok: false, reason: 'chain_unreachable', costly: asked };
		if (key === null) return { ok: false, reason: 'unknown_account', costly: asked };
		let pub: PublicKey;
		try {
			pub = PublicKey.fromString(key);
		} catch {
			return { ok: false, reason: 'no_posting_key_on_chain', costly: asked };
		}
		const digest = createHash('sha256')
			.update(
				notifyCanonical(r.action, this.audience, r.account, r.nonce, r.payload, r.timestamp),
				'utf8'
			)
			.digest();
		let valid = false;
		try {
			valid = pub.verify(digest, sig);
		} catch {
			valid = false;
		}
		if (!valid) return { ok: false, reason: 'signature_mismatch', costly: true };
		// A stale key just proved itself: fetch the current one for next time
		// (only a valid request triggers it, so junk cannot make the relay ask
		// the chain).
		if (!asked && age >= KEY_CACHE_MS) this.refresh(r.account);
		return { ok: true };
	}

	/** {@link check} and {@link commit} in one: accept the request once. */
	async verify(r: SignedRequest): Promise<{ ok: true } | { ok: false; reason: NotifySigError }> {
		const c = await this.check(r);
		if (!c.ok) return { ok: false, reason: c.reason };
		if (!this.commit(r.account, r.nonce, r.timestamp)) return { ok: false, reason: 'replayed' };
		return { ok: true };
	}
}
