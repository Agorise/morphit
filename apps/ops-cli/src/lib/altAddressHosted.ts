/**
 * Does Tor / i2pd on THIS server really serve the address the operator just
 * saved for the footer?
 *
 * Saving an address only advertises it. Visitors reach the site through it
 * only when the router here holds that address's key. The two can drift
 * (morphitlat advertised a .b32.i2p its own i2pd no longer hosted, and nobody
 * noticed for a long time — see upgrade.ts, the seed-address check). Tor and
 * i2pd both publish the truth locally, so one comparison tells:
 *   - Tor: the `hostname` file in each hidden-service directory
 *     (/var/lib/tor/<dir>/hostname, root-readable);
 *   - i2pd: its web console's tunnel page, scoped to Morphit's own tunnel
 *     (`morphit-web`), never the first .b32.i2p on the page — a router can
 *     host other people's destinations too.
 * "Cannot tell" (null) is a real answer and is said as such: never a warning
 * for something that was not checked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withSpinner } from '../init/spinner.ts';
import { sanitizeForTerm } from '../render/term.ts';

export interface HostedDeps {
	/** The .onion addresses this server's Tor serves (empty: none found / unreadable). */
	readonly torHostnames?: () => string[];
	/** The .b32.i2p of Morphit's own i2pd tunnel, or null when it cannot be read. */
	readonly i2pTunnelB32?: () => Promise<string | null>;
}

export type HostedResult =
	| { readonly status: 'hosted' }
	| { readonly status: 'other'; readonly served: readonly string[] }
	| { readonly status: 'unknown' };

/** The Tor hidden-service directory Ansible manages (roles/tor). */
export const TOR_HS_DIR = '/var/lib/tor/morphit';

function envRoot(): string {
	return process.env.MORPHIT_ENV_ROOT ?? '';
}

function realTorHostnames(): string[] {
	const base = `${envRoot()}/var/lib/tor`;
	const out: string[] = [];
	let dirs: string[] = [];
	try {
		dirs = readdirSync(base);
	} catch {
		return out;
	}
	for (const d of dirs) {
		try {
			const m = /[a-z2-7]{56}\.onion/.exec(readFileSync(join(base, d, 'hostname'), 'utf8'));
			if (m) out.push(m[0]);
		} catch {
			/* not a hidden-service directory, or not readable */
		}
	}
	return out;
}

async function realI2pTunnelB32(): Promise<string | null> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 8_000);
	try {
		const res = await fetch('http://127.0.0.1:7070/?page=i2p_tunnels', { signal: ctrl.signal });
		if (!res.ok) return null;
		return morphitTunnelB32(await res.text());
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

/** Morphit's own tunnel's b32 from the i2pd console's tunnel page (each tunnel
 *  is one element holding its NAME and a `b32=` link), or null. PURE. */
export function morphitTunnelB32(html: string): string | null {
	for (const frag of html.split('<')) {
		if (!/morphit/i.test(frag)) continue;
		const m = /b32=([a-z2-7]{52})/.exec(frag);
		if (m) return `${m[1]}.b32.i2p`;
	}
	return null;
}

/** Is `address` served by this server's Tor (net 'tor') or i2pd (net 'i2p')? */
export async function hostedHere(
	net: 'tor' | 'i2p',
	address: string,
	deps: HostedDeps = {}
): Promise<HostedResult> {
	const want = address.trim().toLowerCase();
	if (net === 'tor') {
		const served = (deps.torHostnames ?? realTorHostnames)();
		if (served.length === 0) return { status: 'unknown' };
		return served.includes(want) ? { status: 'hosted' } : { status: 'other', served };
	}
	const b32 = await (deps.i2pTunnelB32 ?? realI2pTunnelB32)();
	if (b32 === null) return { status: 'unknown' };
	return b32 === want ? { status: 'hosted' } : { status: 'other', served: [b32] };
}

/** After a Tor / I2P address is saved: does this server's Tor / i2pd really
 *  serve it? Says what it found (under the spinner while it looks); a warning
 *  only for a mismatch it saw. */
export async function reportHosting(
	net: 'tor' | 'i2p',
	addr: string,
	opts: {
		readonly print?: (line: string) => void;
		/** What to do about a mismatch, from where the operator is. */
		readonly fix?: string;
		readonly deps?: HostedDeps;
	} = {}
): Promise<HostedResult> {
	const print = opts.print ?? ((l: string) => console.log(l));
	const r = await withSpinner(
		net === 'tor'
			? 'Checking which .onion Tor on this server serves…'
			: 'Checking which I2P address i2pd on this server serves…',
		() => hostedHere(net, addr, opts.deps)
	);
	const what = net === 'tor' ? 'Tor' : 'i2pd';
	if (r.status === 'hosted') {
		print(
			`  ✓ ${what} on this server serves ${sanitizeForTerm(addr)}: visitors can reach your site there.`
		);
	} else if (r.status === 'other') {
		print(
			`  ! ${what} on this server serves ${r.served.map(sanitizeForTerm).join(', ')}, not the address you saved.`
		);
		print('    Visitors who use the saved address reach nothing until its key is installed');
		print(
			`    here: ${opts.fix ?? 'on this server, run  sudo morphit-ops alt-address  and follow its steps.'}`
		);
		if (net === 'tor') print(`    Check what Tor serves with: sudo cat ${TOR_HS_DIR}/hostname`);
	} else {
		print(
			net === 'tor'
				? `  (Could not read which .onion Tor serves here. On this server: sudo cat ${TOR_HS_DIR}/hostname)`
				: "  (Could not read i2pd's tunnel page here; i2pd may still be starting. Check again later with: sudo morphit-ops alt-address)"
		);
	}
	return r;
}
