/**
 * scripts/canary/readCapped.ts
 *
 * Read an HTTP answer's body as text, but never more than `max` bytes
 * (v1.21.15). The canary asks explorers and nodes it does not run — over Tor
 * and I2P too — and a chain head is a few hundred bytes: an answer that keeps
 * streaming is cut off and counts as a failed source, so it cannot fill the
 * memory of the box that signs the canary.
 */

/** The body as UTF-8 text, or null when it is larger than `max` bytes (or
 *  cannot be read). */
export async function readTextCapped(resp: Response, max = 64 * 1024): Promise<string | null> {
	const declared = Number(resp.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > max) {
		await resp.body?.cancel().catch(() => {});
		return null;
	}
	if (resp.body === null) return '';
	const reader = resp.body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > max) {
				await reader.cancel().catch(() => {});
				return null;
			}
			parts.push(value);
		}
	} catch {
		return null;
	}
	return Buffer.concat(parts).toString('utf8');
}
