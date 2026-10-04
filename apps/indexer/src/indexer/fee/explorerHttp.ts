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

/** The body parsed as JSON, under the same cap. Throws on either failure. */
export async function readExplorerJson(res: Response, ac?: AbortController): Promise<unknown> {
	return JSON.parse(await readExplorerText(res, ac)) as unknown;
}
