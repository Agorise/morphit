/**
 * apps/indexer/src/blurt/snapshotKuboFetch.ts
 *
 * Fetch the snapshot through this server's own IPFS (kubo) node: `ipfs cat
 * <cid>`, run as the daemon's own user on its repo — the way the snapshot
 * mirror and the release seeder reach it (running kubo as root on another
 * user's repo fails). The daemon fetches from the public IPFS network; this
 * box's gateway cannot (Gateway.NoFetch), and the public gateways rate-limit
 * (2026-10-12: 404, 429, 429 on a fresh VPS). Only offered on a node that takes
 * part in the public IPFS network (snapshotMirrors.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, statSync } from 'node:fs';

/** A CIDv0 (Qm…) or CIDv1 in base32 (b…) — never anything a shell or kubo
 *  could read as more than one argument. */
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

export function kuboCatCommand(
	cid: string,
	o: { user: string; repo: string; runuser: boolean; maxBytes?: number }
): [string, string[]] {
	if (!CID_RE.test(cid)) throw new Error(`not an IPFS CID: ${JSON.stringify(cid)}`);
	const drop = o.runuser ? ['runuser', '-u', o.user, '--'] : ['sudo', '-n', '-u', o.user];
	// --length: never more than the signed size (the caller then checks it
	// is exactly that size).
	const cap =
		o.maxBytes !== undefined && Number.isSafeInteger(o.maxBytes) && o.maxBytes > 0
			? [`--length=${o.maxBytes}`]
			: [];
	return [
		drop[0]!,
		[...drop.slice(1), 'env', `IPFS_PATH=${o.repo}`, 'ipfs', '--timeout=30m', 'cat', ...cap, cid]
	];
}

/** The public IPFS gateways fast-sync falls back to. Not this box: kubo's
 *  stock gateway port, 8080, is the RELAY on a Morphit node (the fresh VPS's
 *  "127.0.0.1" source that answered 404, 2026-10-12); this box's own gateway is
 *  read from its config (kuboGatewayFrom). cloudflare-ipfs.com retired its
 *  public gateway. */
export function defaultIpfsGateways(): string[] {
	return ['https://ipfs.io', 'https://dweb.link'];
}

/** This box's gateway as http://host:port, from the text of the kubo repo's
 *  `config` file (it accepts one multiaddr or a list). null when there is none. */
export function kuboGatewayFrom(configText: string): string | null {
	let gw: unknown;
	try {
		gw = (JSON.parse(configText) as { Addresses?: { Gateway?: unknown } }).Addresses?.Gateway;
	} catch {
		return null;
	}
	const first = Array.isArray(gw) ? gw[0] : gw;
	if (typeof first !== 'string') return null;
	const m = /\/ip4\/([0-9.]+)\/tcp\/(\d{1,5})/.exec(first);
	if (!m) return null;
	// A gateway bound to 0.0.0.0 is still reached over loopback from here.
	const host = m[1] === '0.0.0.0' ? '127.0.0.1' : m[1];
	return `http://${host}:${m[2]}`;
}

/** No new bytes from kubo for this long: the next source is tried. */
export const KUBO_STALL_MS = 5 * 60_000;

/**
 * `ipfs cat` the snapshot into `dest` (at most `maxBytes`), given up when no
 * byte has arrived for `stallMs`: kubo prints nothing while it searches the
 * network, and a CID nobody serves would otherwise hold the run for the 30
 * minutes of `--timeout`. True when kubo finished with the whole file. Never
 * throws.
 */
export async function fetchViaKubo(
	cid: string,
	dest: string,
	o: {
		readonly user: string;
		readonly repo: string;
		readonly runuser: boolean;
		readonly maxBytes: number;
		readonly stallMs?: number;
		readonly pollMs?: number;
		/** The child while it runs (so a Ctrl+C can stop it too). */
		readonly onChild?: (child: ChildProcess | null) => void;
		readonly onStall?: () => void;
	}
): Promise<boolean> {
	const stallMs = o.stallMs ?? KUBO_STALL_MS;
	let fd: number | null = null;
	try {
		const [cmd, args] = kuboCatCommand(cid, o);
		fd = openSync(dest, 'w', 0o600);
		const out = fd;
		return await new Promise<boolean>((resolve) => {
			const child = spawn(cmd, args, { stdio: ['ignore', out, 'ignore'] });
			o.onChild?.(child);
			let size = 0;
			let lastGrowth = Date.now();
			let stalled = false;
			const watch = setInterval(() => {
				let now = 0;
				try {
					now = statSync(dest).size;
				} catch {
					/* not there yet */
				}
				if (now !== size) {
					size = now;
					lastGrowth = Date.now();
				} else if (!stalled && Date.now() - lastGrowth > stallMs) {
					stalled = true;
					o.onStall?.();
					child.kill('SIGTERM');
				}
			}, o.pollMs ?? 2_000);
			const finish = (ok: boolean): void => {
				clearInterval(watch);
				o.onChild?.(null);
				resolve(ok && !stalled);
			};
			child.on('error', () => finish(false));
			child.on('close', (code) => finish(code === 0));
		});
	} catch {
		return false;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}
