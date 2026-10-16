/**
 * Offline notices — Session (getsession.org), from the instance's own Session
 * account.
 *
 * Session.js (@session.js/client, MIT) builds and end-to-end encrypts the
 * message exactly as a Session app does; this file is the part it leaves to the
 * runtime — how its requests reach Session's network — written for Node with
 * Morphit's rules, instead of its Bun module:
 *
 *   - EVERY request goes through this box's Tor. The Session nodes that store
 *     her notice therefore never see which instance sent it (Session's own
 *     apps hide that with onion requests; Tor does the same job here).
 *   - The list of nodes comes from Session's seed servers over HTTPS with their
 *     certificates PINNED (the self-signed certificates Session Desktop ships),
 *     never over plain http — a forged list would decide which nodes see the
 *     notice go out.
 *   - Only what sending needs is implemented (node list, swarm lookup, store).
 *     Nothing is ever polled or downloaded, so the instance reads no messages.
 *   - On a zero-clearnet box Session is unavailable: Session's nodes have no
 *     .onion addresses (net.ts refuses them there).
 *
 * The node's own TLS certificate is self-signed and cannot be checked (nothing
 * in the node list ties it to the node). Session's apps do not rely on it —
 * their onion requests encrypt to the node's x25519 key — but these requests
 * go to the node directly, through Tor. So the Tor exit could read what the
 * node itself reads: her Session ID, the time, and a message encrypted to her
 * (which it cannot open or forge). It learns nothing about this site: the
 * request names no site, and comes out of Tor like any other. It could drop
 * the message, as the node could. Accepted; the onion-request encryption
 * would close it.
 */

import net from 'node:net';
import type { Session } from '@session.js/client';
import { httpRequest, type NetPolicy } from '../net.ts';
import { loadSessionLib, type SessionLib } from './sessionLoader.ts';

/** Session's seed servers and their pinned certificates (from Session Desktop,
 *  preload.js + SeedNodeAPI.ts: port 4443, ten-year self-signed certificates). */
const SEEDS: ReadonlyArray<{ host: string; cert: string }> = [
	{
		host: 'seed1.getsession.org',
		cert: `-----BEGIN CERTIFICATE-----
MIIEDTCCAvWgAwIBAgIUWk96HLAovn4uFSI057KhnMxqosowDQYJKoZIhvcNAQEL
BQAwejELMAkGA1UEBhMCQVUxETAPBgNVBAgMCFZpY3RvcmlhMRIwEAYDVQQHDAlN
ZWxib3VybmUxJTAjBgNVBAoMHE94ZW4gUHJpdmFjeSBUZWNoIEZvdW5kYXRpb24x
HTAbBgNVBAMMFHNlZWQxLmdldHNlc3Npb24ub3JnMB4XDTIzMDQwNTAxMjQzNVoX
DTMzMDQwNTAxMjQzNVowejELMAkGA1UEBhMCQVUxETAPBgNVBAgMCFZpY3Rvcmlh
MRIwEAYDVQQHDAlNZWxib3VybmUxJTAjBgNVBAoMHE94ZW4gUHJpdmFjeSBUZWNo
IEZvdW5kYXRpb24xHTAbBgNVBAMMFHNlZWQxLmdldHNlc3Npb24ub3JnMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2wlGkR2aDOHoizik4mqvWEwDPOQG
o/Afd/6VqKzo4BpNerVZQNgdMgdLTedZE4FRfetubonYu6iSYALK2iKoGsIlru1u
Q9dUl0abA9v+yg6duh1aHw8oS16JPL0zdq8QevJaTxd0MeDnx4eXfFjtv8L0xO4r
CRFH+H6ATcJy+zhVBcWLjiNPe6mGSHM4trx3hwJY6OuuWX5FkO0tMqj9aKJtJ+l0
NArra0BZ9MaMwAFE7AxWwyD0jWIcSvwK06eap+6jBcZIr+cr7fPO5mAlT+CoGB68
yUFwh1wglcVdNPoa1mbFQssCsCRa3MWgpzbMq+KregVzjVEtilwLFjx7FQIDAQAB
o4GKMIGHMB0GA1UdDgQWBBQ1XAjGKhyIU22mYdUEIlzlktogNzAfBgNVHSMEGDAW
gBQ1XAjGKhyIU22mYdUEIlzlktogNzAPBgNVHRMBAf8EBTADAQH/MB8GA1UdEQQY
MBaCFHNlZWQxLmdldHNlc3Npb24ub3JnMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA0G
CSqGSIb3DQEBCwUAA4IBAQC4PRiu4LyxK71Gk+f3dDvjinuE9F0XtAamKfRlLMEo
KxK8dtLrT8p62rME7QiigSv15AmSNyqAp751N/j0th1prOnxBoG38BXKLBDDClri
u91MR4h034G6LIYCiM99ldc8Q5a5WCKu9/9z6CtVxZcNlfe477d6lKHSwb3mQ581
1Ui3RnpkkU1n4XULI+TW2n/Hb8gN6IyTHFB9y2jb4kdg7N7PZIN8FS3n3XGiup9r
b/Rujkuy7rFW78Q1BuHWrQPbJ3RU2CKh1j5o6mtcJFRqP1PfqWmbuaomam48s5hU
4JEiR9tyxP+ewl/bToFcet+5Lp9wRLxn0afm/3V00WyP
-----END CERTIFICATE-----
`
	},
	{
		host: 'seed2.getsession.org',
		cert: `-----BEGIN CERTIFICATE-----
MIIEDTCCAvWgAwIBAgIUXkVaUNO/G727mNeaiso9MjvBEm4wDQYJKoZIhvcNAQEL
BQAwejELMAkGA1UEBhMCQVUxETAPBgNVBAgMCFZpY3RvcmlhMRIwEAYDVQQHDAlN
ZWxib3VybmUxJTAjBgNVBAoMHE94ZW4gUHJpdmFjeSBUZWNoIEZvdW5kYXRpb24x
HTAbBgNVBAMMFHNlZWQyLmdldHNlc3Npb24ub3JnMB4XDTIzMDQwNTAxMjI0MloX
DTMzMDQwNTAxMjI0MlowejELMAkGA1UEBhMCQVUxETAPBgNVBAgMCFZpY3Rvcmlh
MRIwEAYDVQQHDAlNZWxib3VybmUxJTAjBgNVBAoMHE94ZW4gUHJpdmFjeSBUZWNo
IEZvdW5kYXRpb24xHTAbBgNVBAMMFHNlZWQyLmdldHNlc3Npb24ub3JnMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvT493tt1EWdyIa++X59ffrQt+ghK
+3Hv/guCPmR0FxPUeVnayoLbeKgbe8dduThh7nlmlYnpwbulvDnMF/rRpX51AZiT
A8UGktBzGXi17/D/X71EXGqlM41QZfVm5MCdQcghvbwO8MP0nWmbV4DdiNYAwSNh
fpGMEiblCvKtGN71clTkOW+8Moq4eOxT9tKIlOv97uvkUS21NgmSzsj453hrb6oj
XR3rtW264zn99+Gv83rDE1jk0qfDjxCkaUb0BvRDREc+1q3p8GZ6euEFBM3AcXe7
Yl0qbJgIXd5I+W5nMJJCyJHPTxQNvS+uJqL4kLvdwQRFAkwEM+t9GCH1PQIDAQAB
o4GKMIGHMB0GA1UdDgQWBBQOdqxllTHj+fmGjmdgIXBl+k0PRDAfBgNVHSMEGDAW
gBQOdqxllTHj+fmGjmdgIXBl+k0PRDAPBgNVHRMBAf8EBTADAQH/MB8GA1UdEQQY
MBaCFHNlZWQyLmdldHNlc3Npb24ub3JnMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA0G
CSqGSIb3DQEBCwUAA4IBAQBkmmX+mopdnhzQC5b5rgbU7wVhlDaG7eJCRgUvqkYm
Pbv6XFfvtshykhw2BjSyQetofJaBh5KOR7g0MGRSn3AqRPBeEpXfkBI9urhqFwBF
F5atmp1rTCeHuAS6w4mL6rmj7wHl2CRSom7czRdUCNM+Tu1iK6xOrtOLwQ1H1ps1
KK3siJb3W0eKykHnheQPn77RulVBNLz1yedEUTVkkuVhzSUj5yc8tiwrcagwWX6m
BlfVCJgsBbrJ754rg0AJ0k59wriRamimcUIBvKIo3g3UhJHDI8bt4+SvsRYkSmbi
rzVthAlJjSlRA28X/OLnknWcgEdkGhu0F1tkBtVjIQXd
-----END CERTIFICATE-----
`
	},
	{
		host: 'seed3.getsession.org',
		cert: `-----BEGIN CERTIFICATE-----
MIIEDTCCAvWgAwIBAgIUTz5rHKUe+VA9IM6vY6QACc0ORFkwDQYJKoZIhvcNAQEL
BQAwejELMAkGA1UEBhMCQVUxETAPBgNVBAgMCFZpY3RvcmlhMRIwEAYDVQQHDAlN
ZWxib3VybmUxJTAjBgNVBAoMHE94ZW4gUHJpdmFjeSBUZWNoIEZvdW5kYXRpb24x
HTAbBgNVBAMMFHNlZWQzLmdldHNlc3Npb24ub3JnMB4XDTIzMDQwNTAxMjYzMVoX
DTMzMDQwNTAxMjYzMVowejELMAkGA1UEBhMCQVUxETAPBgNVBAgMCFZpY3Rvcmlh
MRIwEAYDVQQHDAlNZWxib3VybmUxJTAjBgNVBAoMHE94ZW4gUHJpdmFjeSBUZWNo
IEZvdW5kYXRpb24xHTAbBgNVBAMMFHNlZWQzLmdldHNlc3Npb24ub3JnMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6FgxIk9KmYISL5fk7BLaGAW6lBx8
b4VL3DjlyrFMz7ZhSbcUcavWyyYB+iJxBRhfQGJ7vbwJZ1AwVJisjDFdiLcWzTF8
gzZ7LVXH8qlVnqcx0gksrWYFnG3Y2WJrxEBFdD29lP7LVN3xLQdplMitOciqg5jN
oRjtwGo+wzaMW6WNPzgTvxLzPce9Rl3oN4tSK7qlA9VtsyHwOWBMcogv9LC9IUFZ
2yu0RdcxPdlwLwywYtSRt/W87KbAWTcYY1DfN2VA68p9Cip7/dPOokRduMh1peux
swmIybpC/wz/Ql6J6scSOjDUp/2UsIdYIvyP/Dibi4nHRmD+oz9kb+J3AQIDAQAB
o4GKMIGHMB0GA1UdDgQWBBSQAFetDPIzVg9rfgOI7bfaeEHd8TAfBgNVHSMEGDAW
gBSQAFetDPIzVg9rfgOI7bfaeEHd8TAPBgNVHRMBAf8EBTADAQH/MB8GA1UdEQQY
MBaCFHNlZWQzLmdldHNlc3Npb24ub3JnMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA0G
CSqGSIb3DQEBCwUAA4IBAQCiBNdbKNSHyCZJKvC/V+pHy9E/igwvih2GQ5bNZJFA
daOiKBgaADxaxB4lhtzasr2LdgZdLrn0oONw+wYaui9Z12Yfdr9oWuOgktn8HKLY
oKkJc5EcMYFsd00FnnFcO2U8lQoL6PB/tdcEmpOfqtvShpNhp8SbadSNiqlttvtV
1dqvqSBiRdQm1kz2b8hA6GR6SPzSKlSuwI0J+ZcXEi232EJFbgJ3ESHFVHrhUZro
8A16/WDvZOMWCjOqJsFBw15WzosW9kyNwBtZinXVO3LW/7tVl08PDcarpH4IWjd0
LDpU7zGjcD/A19tfdfMFTOmETuq40I8xxtlR2NENFOAL
-----END CERTIFICATE-----
`
	}
];

interface Snode {
	public_ip: string;
	storage_port: number;
	pubkey_x25519: string;
	pubkey_ed25519: string;
}

const SNODE_LIST_TTL_MS = 2 * 60 * 60_000;

/** A node address as a server gave it: an IPv4 address and a real port, or
 *  nothing. Seeds and nodes answer without authentication worth trusting
 *  for this (a node's TLS is not checked), so a name, a URL piece or a
 *  295-byte "ip" is refused here, never handed to a socket. */
function nodeAddress(ip: unknown, port: unknown): { ip: string; port: number } | null {
	const p = typeof port === 'string' && /^\d{1,5}$/.test(port) ? Number(port) : port;
	if (typeof ip !== 'string' || !net.isIPv4(ip) || ip === '0.0.0.0') return null;
	if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) return null;
	return { ip, port: p };
}

/** The stand-in "swarm" for this site's own Session ID (see ownId). */
const NOT_STORED_SWARM = { ip: '0.0.0.0', port: '0', pubkey_ed25519: '', pubkey_x25519: '' };

/** The Node network module Session.js calls for every request. */
export class TorSessionNetwork {
	private snodes: { at: number; list: Snode[] } | null = null;
	/**
	 * This site's own Session ID. Session.js stores a "sync" copy of every
	 * message on the SENDER's own account (for its other devices) — here that
	 * would be a list of every user it wrote to, readable by anyone with the
	 * site's recovery words, and out of reach of "Delete all". So nothing
	 * addressed to the site itself ever leaves this process: its swarm is not
	 * even looked up, and its store is answered here.
	 */
	ownId: string | null = null;
	constructor(
		private readonly lib: SessionLib,
		private readonly policy: NetPolicy,
		/** Session's seeds; replaced only by tests. */
		private readonly seeds: ReadonlyArray<{ host: string; cert: string; port?: number }> = SEEDS
	) {}

	private fetchError(o: { code: string | undefined; message: string }): Error {
		return new this.lib.SessionFetchError({ code: o.code ?? 'FetchFailed', message: o.message });
	}

	async onRequest(type: string, body: Record<string, unknown>): Promise<unknown> {
		switch (type) {
			case this.lib.RequestType.GetSnodes:
				return { snodes: await this.getSnodes() };
			case this.lib.RequestType.GetSwarms: {
				if (this.ownId !== null && body.pubkey === this.ownId)
					return { swarms: [NOT_STORED_SWARM] };
				const snode = body.snode as Snode;
				const r = await this.rpc(snode, 'batch', {
					requests: [{ method: 'get_swarm', params: { pubkey: body.pubkey } }]
				});
				const listed = (r[0]?.body as { snodes?: unknown[] })?.snodes;
				return {
					swarms: (Array.isArray(listed) ? listed : []).filter(
						(x) =>
							typeof x === 'object' &&
							x !== null &&
							nodeAddress((x as { ip?: unknown }).ip, (x as { port?: unknown }).port) !== null
					)
				};
			}
			case this.lib.RequestType.Store: {
				if (this.ownId !== null && body.destination === this.ownId) return { hash: 'not-stored' };
				const swarm = body.swarm as {
					ip: string;
					port: string | number;
					pubkey_ed25519: string;
					pubkey_x25519: string;
				};
				const r = await this.rpc(
					{
						public_ip: swarm.ip,
						storage_port: Number(swarm.port),
						pubkey_ed25519: swarm.pubkey_ed25519,
						pubkey_x25519: swarm.pubkey_x25519
					},
					'batch',
					{
						requests: [
							{
								method: 'store',
								params: {
									data: body.data64,
									namespace: body.namespace,
									pubkey: body.destination,
									timestamp: body.timestamp,
									ttl: body.ttl
								}
							}
						]
					}
				);
				const first = r[0];
				const hash = (first?.body as { hash?: unknown } | undefined)?.hash;
				if (first?.code !== 200 || typeof hash !== 'string' || hash === '') {
					throw this.fetchError({
						code: this.lib.SessionFetchErrorCode.InvalidResponse,
						message: `store refused (${first?.code ?? 'no answer'})`
					});
				}
				return { hash };
			}
			default:
				// Polling, attachments, open groups: never used to send a notice.
				throw this.fetchError({
					code: this.lib.SessionFetchErrorCode.UnknownMethod,
					message: 'not used for notices'
				});
		}
	}

	private async getSnodes(): Promise<Snode[]> {
		if (this.snodes && Date.now() - this.snodes.at < SNODE_LIST_TTL_MS) return this.snodes.list;
		let lastErr: unknown = null;
		for (const seed of [...this.seeds].sort(() => Math.random() - 0.5)) {
			try {
				const r = await httpRequest(
					`https://${seed.host}:${seed.port ?? 4443}/json_rpc`,
					this.policy,
					{
						method: 'POST',
						viaTor: true,
						tls: { ca: seed.cert, rejectUnauthorized: true },
						headers: { 'Content-Type': 'application/json', 'User-Agent': 'WhatsApp' },
						body: JSON.stringify({
							jsonrpc: '2.0',
							method: 'get_n_service_nodes',
							params: {
								active_only: true,
								fields: {
									public_ip: true,
									storage_port: true,
									pubkey_x25519: true,
									pubkey_ed25519: true
								}
							}
						})
					}
				);
				if (r.status !== 200) throw new Error(`seed answered ${r.status}`);
				const parsed = JSON.parse(r.body) as { result?: { service_node_states?: Snode[] } };
				const states = parsed.result?.service_node_states;
				const list = (Array.isArray(states) ? states : []).filter(
					(s) =>
						typeof s === 'object' && s !== null && nodeAddress(s.public_ip, s.storage_port) !== null
				);
				if (list.length === 0) throw new Error('seed returned no nodes');
				this.snodes = { at: Date.now(), list };
				return list;
			} catch (err) {
				lastErr = err;
			}
		}
		throw this.fetchError({
			code: this.lib.SessionFetchErrorCode.FetchFailed,
			message: `no Session seed answered (${String((lastErr as Error)?.message ?? lastErr)})`
		});
	}

	private async rpc(
		node: Snode,
		method: string,
		params: unknown
	): Promise<Array<{ code: number; body: unknown }>> {
		const at = nodeAddress(node.public_ip, node.storage_port);
		if (at === null) {
			throw this.fetchError({
				code: this.lib.SessionFetchErrorCode.InvalidResponse,
				message: 'not a node address'
			});
		}
		const r = await httpRequest(`https://${at.ip}:${at.port}/storage_rpc/v1`, this.policy, {
			method: 'POST',
			viaTor: true,
			tls: { rejectUnauthorized: false },
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': 'WhatsApp',
				'Accept-Language': 'en-us'
			},
			body: JSON.stringify({ jsonrpc: '2.0', method, params }),
			timeoutMs: 30_000
		});
		if (r.status === 421) {
			throw this.fetchError({
				code: this.lib.SessionFetchErrorCode.RetryWithOtherNode421Error,
				message: '421 handled. Retry this request with a new snode.'
			});
		}
		if (r.status !== 200) {
			throw this.fetchError({
				code: this.lib.SessionFetchErrorCode.FetchFailed,
				message: `node answered ${r.status}`
			});
		}
		const parsed = JSON.parse(r.body) as { results?: Array<{ code: number; body: unknown }> };
		if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
			throw this.fetchError({
				code: this.lib.SessionFetchErrorCode.InvalidResponse,
				message: 'empty batch answer'
			});
		}
		return parsed.results;
	}
}

export interface SessionConfig {
	/** The instance's Session account (13 words). */
	readonly mnemonic: string;
}

/** A new Session account for an instance: its 13 words and Session ID. */
export async function newSessionIdentity(): Promise<{ mnemonic: string; sessionId: string }> {
	const lib = await loadSessionLib();
	const seed = lib.generateSeedHex();
	return {
		mnemonic: lib.encodeMnemonic(seed),
		sessionId: Buffer.from(lib.getKeysFromSeed(seed).x25519.publicKey).toString('hex')
	};
}

/** The Session ID these words belong to; null when they are not 13 valid words. */
export async function sessionIdOf(mnemonic: string): Promise<string | null> {
	try {
		const lib = await loadSessionLib();
		const s = new lib.Session({ network: { onRequest: async () => ({}) } } as never);
		s.setMnemonic(mnemonic.trim());
		return s.getSessionID();
	} catch {
		return null;
	}
}

type Seeds = ReadonlyArray<{ host: string; cert: string; port?: number }>;
let cached: {
	key: string;
	seeds: Seeds | undefined;
	at: number;
	session: Session;
	network: TorSessionNetwork;
} | null = null;

export async function sendSession(
	cfg: SessionConfig,
	siteName: string,
	policy: NetPolicy,
	to: string,
	text: string,
	seeds?: ReadonlyArray<{ host: string; cert: string; port?: number }>
): Promise<void> {
	const key = `${cfg.mnemonic}\u0000${siteName}`;
	// Session.js keeps its node list for as long as the instance lives: a new
	// instance every two hours, and after any failed send, asks the seeds again.
	if (
		cached === null ||
		cached.key !== key ||
		cached.seeds !== seeds ||
		Date.now() - cached.at > SNODE_LIST_TTL_MS
	) {
		const lib = await loadSessionLib();
		const network = new TorSessionNetwork(lib, policy, seeds);
		const session = new lib.Session({ network } as never);
		session.setMnemonic(cfg.mnemonic.trim());
		network.ownId = session.getSessionID();
		// The name her app shows for this sender: the site's name, set locally
		// (each message carries the profile), no extra message sent.
		(session as unknown as { displayName: string }).displayName = siteName.slice(0, 64);
		cached = { key, seeds, at: Date.now(), session, network };
	}
	const current = cached;
	try {
		await current.session.sendMessage({ to, text });
	} catch (err) {
		if (cached === current) cached = null;
		throw err;
	}
}
