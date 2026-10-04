/**
 * Morphit indexer — the address a hidden-service origin is DIALLED at.
 *
 *
 * Tor, I2P and Lokinet authenticate the host and encrypt end to end, and this
 * indexer's hidden transports tunnel plain HTTP; they have never spoken TLS.
 * Registration now refuses `https://` for a hidden host, but rows registered
 * before that exist: `https://<onion>` was dialled as plaintext — to port 80
 * when no port was written, and as plaintext HTTP to port 443 when `:443` was
 * written, which a TLS listener can only refuse, so every push and probe
 * failed as the PEER's fault until the row was pruned.
 *
 * So a legacy https hidden origin is dialled as what the transport really
 * speaks: `http://`, on the http port (an explicit :443 is dropped; any other
 * explicit port is kept — it is the port the operator published). Said once
 * per origin in the log, so the reason a peer is reached on port 80 is
 * findable. Clearnet and http origins are returned unchanged. PURE apart from
 * the one-time warning.
 */
import { hiddenNetworkOf } from '@morphit/hidden-transport';
import { logger } from '$log';

const log = logger('hidden-origin');
const warned = new Set<string>();
const WARNED_MAX = 1_000;

export function hiddenOriginForDial(origin: string): string {
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return origin;
	}
	if (u.protocol !== 'https:' || hiddenNetworkOf(origin) === null) return origin;
	const port = u.port === '' || u.port === '443' ? '' : `:${u.port}`;
	const dial = `http://${u.hostname}${port}`;
	if (!warned.has(origin) && warned.size < WARNED_MAX) {
		warned.add(origin);
		log.warn('https_hidden_origin_dialled_as_http', {
			origin,
			dial,
			note: 'hidden transports carry plain HTTP (the network encrypts); this peer registered an https:// hidden origin before v1.20.0 refused them — it should re-register with http://'
		});
	}
	return dial;
}
