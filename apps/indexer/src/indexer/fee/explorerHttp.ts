/**
 * Morphit indexer — how a fee verifier talks to a BTC / XMR block explorer.
 *
 * An explorer is a third party whose answer decides whether a fee is paid, so
 * it is trusted for exactly its own answer and nothing more:
 *   - REDIRECTS ARE NOT FOLLOWED (`redirect: 'manual'`; a 3xx is a failed
 *     request). Following one sent the request — on the XMR txprove path, the
 *     payer's transaction key — to whatever host the explorer named, internal
 *     services included, and the JSON that came back was taken as the
 *     explorer's verdict;
 *   - THE BODY IS CAPPED (EXPLORER_MAX_BODY_BYTES), checked against
 *     Content-Length first and enforced while streaming: a hostile explorer
 *     could otherwise make every indexer buffer an answer of any size;
 *   - a fixed User-Agent, so no runtime version is sent.
 */

/** Largest explorer answer read. An address's transaction page is the biggest
 *  legitimate one (a few hundred KB); 2 MiB leaves room and still bounds it. */
export const EXPLORER_MAX_BODY_BYTES = 2 * 1024 * 1024;

export const EXPLORER_USER_AGENT = 'morphit-indexer/fee-verify';

/** Thrown when an explorer's answer exceeds EXPLORER_MAX_BODY_BYTES. */
export class ExplorerBodyTooLarge extends Error {
	constructor() {
		super('explorer answer exceeds the size cap');
		this.name = 'ExplorerBodyTooLarge';
	}
}

/** The RequestInit every explorer request uses: no redirects, a fixed UA. */
export function explorerInit(
	init: { method: 'GET' | 'POST'; accept: string; body?: string; contentType?: string },
	signal: AbortSignal | null
): RequestInit {
	const headers: Record<string, string> = {
		accept: init.accept,
		'user-agent': EXPLORER_USER_AGENT
	};
	if (init.contentType !== undefined) headers['content-type'] = init.contentType;
	return {
		method: init.method,
		headers,
		...(init.body !== undefined ? { body: init.body } : {}),
		signal,
		redirect: 'manual'
	};
}

/** The body as text, at most `max` bytes; throws ExplorerBodyTooLarge past it
 *  (aborting the request through `ac` when given). */
export async function readExplorerText(
	res: Response,
	ac?: AbortController,
	max = EXPLORER_MAX_BODY_BYTES
): Promise<string> {
	const cl = res.headers.get('content-length');
	if (cl !== null) {
		const n = Number(cl);
		if (Number.isFinite(n) && n > max) {
			ac?.abort();
			throw new ExplorerBodyTooLarge();
		}
	}
	const reader = res.body?.getReader();
	if (!reader) {
		const text = await res.text();
		if (Buffer.byteLength(text) > max) throw new ExplorerBodyTooLarge();
		return text;
	}
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let total = 0;
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		total += r.value.byteLength;
		if (total > max) {
			ac?.abort();
			await reader.cancel().catch(() => undefined);
			throw new ExplorerBodyTooLarge();
		}
		parts.push(decoder.decode(r.value, { stream: true }));
	}
	parts.push(decoder.decode());
	return parts.join('');
}

/** Context keys a PRIVATE lookup may log: which explorer, and the HTTP status
 *  it answered. A listing fee's txid and tx key are public in its order op, so
 *  the fee path logs the txid; a trade payment's are not (they travel only in
 *  an encrypted chat), so a verifier built for the payment check
 *  (fee/paymentCheck.ts) logs nothing else. */
const PRIVATE_LOG_KEYS: ReadonlySet<string> = new Set(['explorer', 'status']);

/** A warning's context reduced for a private lookup: only PRIVATE_LOG_KEYS,
 *  and of an error only its name — a fetch error's message or stack can quote
 *  the request URL, which carries the txid, the address and (XMR) the tx key. */
export function privateLogContext(
	ctx: Record<string, unknown>,
	err?: unknown
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(ctx)) if (PRIVATE_LOG_KEYS.has(k)) out[k] = v;
	if (err !== undefined) out.error = err instanceof Error ? err.name : typeof err;
	return out;
}

/** The body parsed as JSON, under the same cap. Throws on either failure. */
export async function readExplorerJson(res: Response, ac?: AbortController): Promise<unknown> {
	return JSON.parse(await readExplorerText(res, ac)) as unknown;
}

/** A block time (unix seconds) an explorer gives, or null when it is not a
 *  plausible one: a positive whole number that a Date can hold. */
export function blockTimeOf(t: unknown): number | null {
	return typeof t === 'number' && Number.isSafeInteger(t) && t > 0 && t <= 253_402_300_799
		? t
		: null;
}
