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
	// IPv6 loopback in compressed form (`::1` already caught above)
	// and the unspecified address `::` (caught above).  All other
	// public-routable IPv6 falls through to public.
	return false;
}
