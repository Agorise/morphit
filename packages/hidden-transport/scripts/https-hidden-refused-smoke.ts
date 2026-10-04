/**
 * Hidden-service connectors refuse `https:` instead of silently downgrading.
 *
 *
 * makeSocks5Connector / makeHttpConnectConnector hand undici a PLAIN socket
 * (they never wrap TLS) and default a missing port to 80. So an
 * `https://<host>.onion` URL — an operator-configured hidden RPC endpoint
 * written as https, say — was dialled as plaintext HTTP to port 80: not what
 * the URL says, and silently. Hidden networks encrypt and authenticate
 * themselves; their URLs are http://. The connectors now refuse `https:` with a
 * typed error BEFORE contacting the proxy, and an http:// URL still works.
 */
import net from 'node:net';
import { Agent, request } from 'undici';
import * as ht from '../src/index.ts';

const { makeSocks5Connector, makeHttpConnectConnector } = ht;
// Looked up rather than imported by name, so on a tree without the error class
// this smoke still RUNS and reports the behaviour instead of failing to load.
const HiddenHttpsUnsupportedError: new (...a: never[]) => Error =
	(ht as unknown as { HiddenHttpsUnsupportedError?: new (...a: never[]) => Error }).HiddenHttpsUnsupportedError ??
	class NotDefined extends Error {};

let failed = 0;
let n = 0;
function check(name: string, ok: boolean, detail = ''): void {
	n++;
	if (ok) console.log(`  ✓ ${name}`);
	else {
		failed++;
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}
/** A local "proxy" that only counts connections (and closes them). */
async function countingProxy(): Promise<{ port: number; hits: () => number; close: () => void }> {
	let hits = 0;
	const srv = net.createServer((s) => {
		hits++;
		s.destroy();
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	return { port: (srv.address() as net.AddressInfo).port, hits: () => hits, close: () => srv.close() };
}
const ONION = 'f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion';
const I2P = 'zgkfadmkqx75enpfhfrlfbwqk7c53uwmr55yplk3colaznepusxa.b32.i2p';

console.log('hidden https-refused smoke:\n');
for (const [label, make, host] of [
	['SOCKS (Tor)', makeSocks5Connector, ONION],
	['CONNECT (I2P)', makeHttpConnectConnector, I2P]
] as const) {
	const p = await countingProxy();
	const err = await new Promise<Error | null>((res) =>
		(make as (h: string, p: number) => (o: object, cb: (e: Error | null) => void) => void)('127.0.0.1', p.port)(
			{ hostname: host, port: '', protocol: 'https:' },
			(e) => res(e)
		)
	);
	check(
		`${label}: an https:// hidden URL is refused with a typed error, the proxy never contacted`,
		err !== null && (err as Error).name === 'HiddenHttpsUnsupportedError' && p.hits() === 0,
		`error=${err ? `${err.name}: ${err.message}` : 'none'} proxy connections=${p.hits()}`
	);
	// Through undici, the way every caller uses it.
	const agent = new Agent({ connect: make('127.0.0.1', p.port) as never });
	const viaUndici = await request(`https://${host}/`, { dispatcher: agent }).then(
		() => null,
		(e: unknown) => e as Error
	);
	const undiciMsg = viaUndici ? String(viaUndici.message) : 'none';
	const undiciCause = viaUndici ? (viaUndici as { cause?: unknown }).cause : undefined;
	check(
		`${label}: through undici the caller sees the refusal (cause), not a plaintext :80 attempt`,
		viaUndici !== null &&
			p.hits() === 0 &&
			(viaUndici instanceof HiddenHttpsUnsupportedError ||
				undiciCause instanceof HiddenHttpsUnsupportedError ||
				/https/.test(undiciMsg)),
		`error=${undiciMsg} proxy connections=${p.hits()}`
	);
	// http:// still reaches the proxy.
	await new Promise<void>((res) =>
		(make as (h: string, p: number) => (o: object, cb: (e: Error | null) => void) => void)('127.0.0.1', p.port)(
			{ hostname: host, port: '8091', protocol: 'http:' },
			() => res()
		)
	);
	check(`${label}: an http:// hidden URL still goes to the proxy`, p.hits() === 1, `proxy connections=${p.hits()}`);
	await agent.close();
	p.close();
}
console.log('');
if (failed > 0) {
	console.log(`✗ ${failed} of ${n} hidden https-refused scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${n} hidden https-refused scenarios passed`);
process.exit(0);
