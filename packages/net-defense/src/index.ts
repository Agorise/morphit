/**
 * Network-defense primitives — private-address detection.
 *
 * Lifted from `apps/indexer/src/indexer/federationProbe.ts` at
 * cp154 (cp146 F-mcp-1 Tier-B closure).  The full indexer probe
 * implementation has six SSRF defense layers; this package
 * extracts the two PURE building blocks so multiple consumers
 * can compose their own policies:
 *
 *   - apps/indexer/src/indexer/federationProbe.ts continues to
 *     use the full six-layer lockdown (HTTPS-only, denylist,
 *     DNS + every-record-public, IP-pin dispatcher, manual
 *     redirect, body cap).
 *   - apps/mcp-server/src/indexerClient.ts uses these primitives
 *     to reject private-address instance URLs by default, with
 *     an env-var opt-in for legitimate localhost/Tor use.
 *
 * Why split: the consumers have DIFFERENT THREAT MODELS:
 *
 *   indexer: peer-supplied origins.  Federation discovery may
 *            pull URLs from chain-stored `known_instances` rows
 *            written by other operators.  Hard reject private —
 *            no operator should be able to use the indexer to
 *            probe internal networks.
 *
 *   mcp-server: user-supplied origin.  MORPHIT_MCP_INSTANCE_URL
 *            comes from the user's MCP client config.  Default
 *            reject private (defense-in-depth against malicious
 *            config), allow opt-in via env var (legit localhost
 *            self-hosted instances, Tor onions, dev setups).
 *
 * Same primitives, different policy compositions.  This package
 * does NOT compose either policy — it gives the building blocks
 * to consumers.
 *
 * Provenance: the helpers below are byte-for-byte identical to
 * the indexer's original implementation at the lift point.  Any
 * future changes should land here and propagate to consumers,
 * not be applied separately at the consumer level (drift would
 * recreate exactly the duplication this package was created to
 * eliminate).
 */

import { BlockList, isIP } from 'node:net';

// ─── THE non-public address set (v1.20.0 fix wave, D13) ─────────────────────
//
// One definition for every "is this address public?" decision in the repo:
// this package's two checks below, and @morphit/hidden-transport's
// isNonPublicAddressLiteral (which delegates here). There used to be two —
// regexes here, a BlockList there — and they disagreed: the probe-time check
// (these regexes, "the authoritative one") passed `[::ffff:7f00:1]`, which is
// how `new URL()` writes ::ffff:127.0.0.1, and NAT64 / 6to4 / fec0:: /
// multicast / 198.18/15 forms. A BlockList matches by VALUE, so every textual
// form of an address (including IPv4-mapped IPv6 in dotted or hex form) is
// judged the same. Pure node:net — this package stays dependency-free (the
// mcp-server deploy vendors it alone).

/** IPv4 ranges that are not public unicast destinations. */
export const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
	['0.0.0.0', 8], // "this network"
	['10.0.0.0', 8], // RFC 1918
	['100.64.0.0', 10], // CGNAT (RFC 6598)
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local, cloud metadata
	['172.16.0.0', 12], // RFC 1918
	['192.0.0.0', 24], // IETF protocol assignments
	['192.168.0.0', 16], // RFC 1918
	['198.18.0.0', 15], // benchmarking
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4] // reserved + 255.255.255.255 broadcast
];
/** IPv6 ranges that are not public unicast destinations, or that embed an
 *  IPv4 address a gateway would translate to (so they can reach anything the
 *  IPv4 list blocks). */
export const NON_PUBLIC_V6: ReadonlyArray<readonly [string, number]> = [
	['::', 96], // unspecified, loopback ::1, IPv4-compatible ::a.b.c.d
	// (IPv4-MAPPED ::ffff:0:0/96 is deliberately NOT listed: node's BlockList
	// treats a mapped address and its IPv4 as the same value, so listing the
	// whole /96 would block every IPv4. Mapped forms are judged by the IPv4
	// they carry — see isNonPublicIpLiteral.)
	['64:ff9b::', 96], // NAT64 well-known prefix
	['64:ff9b:1::', 48], // NAT64 local-use
	['2001::', 32], // Teredo (embeds an IPv4 server + client)
	['2002::', 16], // 6to4 (embeds an IPv4)
	['fc00::', 7], // unique-local
	['fe80::', 10], // link-local
	['fec0::', 10], // site-local (deprecated, still routed on some LANs)
	['ff00::', 8] // multicast
];

const NON_PUBLIC = (() => {
	const b = new BlockList();
	for (const [a, p] of NON_PUBLIC_V4) b.addSubnet(a, p, 'ipv4');
	for (const [a, p] of NON_PUBLIC_V6) b.addSubnet(a, p, 'ipv6');
	return b;
})();

/**
 * Is `host` an IP LITERAL (bare or `[bracketed]`) that is NOT a public unicast
 * address? A DNS name is never judged here (returns false) — names are for the
 * resolver + {@link isPrivateIp} on every answer. PURE.
 */
export function isNonPublicIpLiteral(host: string): boolean {
	const h = host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
	const fam = isIP(h);
	if (fam === 0) return false;
	if (NON_PUBLIC.check(h, fam === 4 ? 'ipv4' : 'ipv6')) return true;
	// IPv4-mapped IPv6 in any form: judge the embedded IPv4 by value too.
	if (fam === 6) {
		const mapped = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/.exec(h);
		if (mapped) {
			const v4 =
				mapped[3] ??
				[
					parseInt(mapped[1]!, 16) >> 8,
					parseInt(mapped[1]!, 16) & 255,
					parseInt(mapped[2]!, 16) >> 8,
					parseInt(mapped[2]!, 16) & 255
				].join('.');
			return NON_PUBLIC.check(v4, 'ipv4');
		}
	}
	return false;
}

/**
 * Check whether a hostname string (as it appears in a URL) is
 * one of the obviously-private literal forms.  This is the FIRST
 * defense — catches `https://127.0.0.1/`, `https://localhost/`,
 * `https://[::1]/`, cloud-metadata addresses, and the
 * `.local`/`.localhost`/`.internal` TLDs.
 *
 * Use BEFORE any DNS work.  Catches the easy 99% of attacks at
 * zero cost; DNS-based defenses catch the rebinding-class
 * remainder.
 */
export function isPrivateHostname(hostnameRaw: string): boolean {
	const h = hostnameRaw.toLowerCase();
	if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
	if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
	if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/.test(h)) return true;
	if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
	if (h === 'localhost') return true;
	if (h === '0.0.0.0') return true;
	if (h === '[::]' || h === '[::1]' || h === '::1') return true;
	if (h === '169.254.169.254') return true;
	if (h === 'metadata.google.internal') return true;
	if (/^\[?(fc|fd)[0-9a-f]{2}:/i.test(h)) return true;
	if (/^\[?fe80:/i.test(h)) return true;
	if (h.endsWith('.local')) return true;
	if (h.endsWith('.localhost')) return true;
	if (h.endsWith('.internal')) return true;
	// Every other IP-literal form, judged by value (D13).
	if (isNonPublicIpLiteral(h)) return true;
	return false;
}

/**
 * Check whether a *resolved IP address* (as returned by DNS lookup,
 * canonical form — not user-supplied) is in a private range.
 *
 * Distinct from isPrivateHostname() because:
 *   - DNS gives us already-normalized IP strings (no `[]` brackets,
 *     no port, IPv6 in canonical form).
 *   - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) needs unwrap + re-check
 *     as IPv4.
 *   - We don't need TLD checks (no hostnames here).
 *
 * Used by DNS-rebinding defense: resolve hostname, then check
 * every returned IP via this function before connecting.
 */
export function isPrivateIp(ip: string): boolean {
	const v = ip.toLowerCase();
	// IPv4 patterns
	if (/^127\.\d+\.\d+\.\d+$/.test(v)) return true;
	if (/^10\.\d+\.\d+\.\d+$/.test(v)) return true;
	if (/^192\.168\.\d+\.\d+$/.test(v)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/.test(v)) return true;
	if (/^169\.254\.\d+\.\d+$/.test(v)) return true;
	if (/^0\.\d+\.\d+\.\d+$/.test(v)) return true; // 0.0.0.0/8
	if (v === '255.255.255.255') return true; // broadcast
	// Carrier-grade NAT (RFC 6598).  Operators sometimes have
	// internal services in this range; treat as private for safety.
	if (/^100\.(6[4-9]|[789][0-9]|1[01][0-9]|12[0-7])\.\d+\.\d+$/.test(v)) return true;
	// IPv6 patterns (DNS returns canonical form: no brackets, lowercase hex).
	if (v === '::' || v === '::1') return true;
	if (/^fc[0-9a-f]{2}:/.test(v)) return true; // unique-local
	if (/^fd[0-9a-f]{2}:/.test(v)) return true; // unique-local
	if (/^fe80:/.test(v)) return true; // link-local
	// IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap + re-validate as IPv4
	const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
	if (v4mapped !== null) return isPrivateIp(v4mapped[1]!);
	// Every remaining form — hex IPv4-mapped, NAT64, 6to4, Teredo,
	// site-local, multicast, benchmarking, reserved — by value (D13).
	return isNonPublicIpLiteral(v);
}
