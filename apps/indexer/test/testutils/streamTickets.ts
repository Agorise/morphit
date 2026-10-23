/**
 * Stream tickets for tests and smokes (src/api/streamTicket.ts): a real
 * posting key per account, a lookup that names it, and tickets signed by it.
 */
import { streamTicketDigest, type TicketKeyLookup } from '../../src/api/streamTicket';

export const TEST_STREAM_HOST = 'morphit.test';

export async function streamTickets() {
	const { PrivateKey } = await import('@beblurt/dblurt');
	const keyOf = (account: string) => PrivateKey.fromSeed(`stream-ticket-${account}`);
	const lookupKey: TicketKeyLookup = async (account) => keyOf(account).createPublic().toString();
	const ticketFor = (
		account: string,
		opts: { host?: string; ttlS?: number; signer?: string } = {}
	): string => {
		const payload = Buffer.from(
			JSON.stringify({
				v: 1,
				a: account,
				h: opts.host ?? TEST_STREAM_HOST,
				e: Math.floor(Date.now() / 1000) + (opts.ttlS ?? 3600)
			}),
			'utf8'
		).toString('base64url');
		const sig = keyOf(opts.signer ?? account)
			.sign(streamTicketDigest(payload))
			.toString();
		return `${payload}.${sig}`;
	};
	/** Request init for a stream request as `account` would make it. */
	const as = (account: string, extra: RequestInit = {}) => ({
		...extra,
		headers: { host: TEST_STREAM_HOST, ...(extra.headers ?? {}) }
	});
	const path = (p: string, account: string) =>
		`${p}?ticket=${encodeURIComponent(ticketFor(account))}`;
	/** What a stream route needs: the key lookup and this instance's names. */
	const routeOpts = { lookupKey, instanceHosts: [TEST_STREAM_HOST] };
	return { lookupKey, ticketFor, as, path, routeOpts };
}
