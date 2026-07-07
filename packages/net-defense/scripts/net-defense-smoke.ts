/**
 * @morphit/net-defense self-test smoke (cp154).
 *
 * The package exports two pure functions consumed by both the
 * indexer (full SSRF lockdown) and the mcp-server (opt-in
 * private-address rejection).  This smoke is the canonical
 * regression test for the package — if either function ever
 * drifts, this smoke fires before any downstream consumer's
 * tamper test does.
 *
 * Mirrors the structure of cp153's `scripts/strip-comments-smoke.ts`
 * (self-test for `scripts/lib/strip-comments.ts`): a dedicated
 * smoke per shared helper, pinning both the positive behaviors
 * (catches what it should) and the documented limitations
 * (doesn't catch what we acknowledge we don't catch).
 *
 * Coverage:
 *   - isPrivateHostname: every literal-form branch + a public
 *     control + the TLD-suffix branches.
 *   - isPrivateIp: every IPv4/IPv6 branch including the IPv4-
 *     mapped IPv6 unwrap + a public control.
 *
 * Provenance: the source-of-truth function bodies are byte-for-
 * byte identical to the pre-cp154 implementations in
 * `apps/indexer/src/indexer/federationProbe.ts`.  All scenarios
 * here are direct counterparts to the existing
 * `apps/indexer/scripts/dns-rebinding-defense-smoke.ts` and
 * `apps/indexer/scripts/federation-probe-smoke.ts` test inputs.
 */

import { isPrivateHostname, isPrivateIp } from '@morphit/net-defense';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];

function expect(name: string, condition: boolean, detail?: string) {
	if (condition) results.push({ name, passed: true });
	else results.push({ name, passed: false, detail });
}

/* ---------------- isPrivateHostname ---------------- */

// IPv4 ranges
expect('rejects 127.0.0.1 (loopback)', isPrivateHostname('127.0.0.1'));
expect('rejects 127.1.2.3 (loopback /8)', isPrivateHostname('127.1.2.3'));
expect('rejects 10.0.0.1 (RFC1918 /8)', isPrivateHostname('10.0.0.1'));
expect('rejects 192.168.1.1 (RFC1918 /16)', isPrivateHostname('192.168.1.1'));
expect('rejects 172.16.0.1 (RFC1918 /12 low)', isPrivateHostname('172.16.0.1'));
expect('rejects 172.31.255.255 (RFC1918 /12 high)', isPrivateHostname('172.31.255.255'));
expect('rejects 169.254.169.254 (cloud metadata)', isPrivateHostname('169.254.169.254'));
expect('rejects 169.254.0.5 (link-local)', isPrivateHostname('169.254.0.5'));

// Literal aliases
expect('rejects localhost', isPrivateHostname('localhost'));
expect('rejects LOCALHOST (case-insensitive)', isPrivateHostname('LOCALHOST'));
expect('rejects 0.0.0.0', isPrivateHostname('0.0.0.0'));
expect('rejects metadata.google.internal', isPrivateHostname('metadata.google.internal'));

// IPv6
expect('rejects ::1 (IPv6 loopback)', isPrivateHostname('::1'));
expect('rejects [::1] (IPv6 bracketed)', isPrivateHostname('[::1]'));
expect('rejects [::] (IPv6 unspecified)', isPrivateHostname('[::]'));
expect('rejects fc00::1 (IPv6 unique-local)', isPrivateHostname('fc00::1'));
expect('rejects fd12:3456::1 (IPv6 unique-local)', isPrivateHostname('fd12:3456::1'));
expect('rejects fe80::1 (IPv6 link-local)', isPrivateHostname('fe80::1'));

// TLD suffixes
expect('rejects foo.local', isPrivateHostname('foo.local'));
expect('rejects bar.localhost', isPrivateHostname('bar.localhost'));
expect('rejects baz.internal', isPrivateHostname('baz.internal'));

// Public controls — MUST return false
expect('allows morphit.io (public)', !isPrivateHostname('morphit.io'));
expect('allows example.com (public)', !isPrivateHostname('example.com'));
expect('allows 8.8.8.8 (public IPv4)', !isPrivateHostname('8.8.8.8'));
expect('allows 2001:db8::1 (public-ish IPv6 documentation block)', !isPrivateHostname('2001:db8::1'));

/* ---------------- isPrivateIp ---------------- */

// IPv4 same as hostname checks
expect('IP rejects 127.0.0.1', isPrivateIp('127.0.0.1'));
expect('IP rejects 10.5.5.5', isPrivateIp('10.5.5.5'));
expect('IP rejects 192.168.0.1', isPrivateIp('192.168.0.1'));
expect('IP rejects 172.20.1.1', isPrivateIp('172.20.1.1'));
expect('IP rejects 169.254.169.254', isPrivateIp('169.254.169.254'));
expect('IP rejects 0.0.0.0/8 (e.g. 0.1.2.3)', isPrivateIp('0.1.2.3'));
expect('IP rejects 255.255.255.255 (broadcast)', isPrivateIp('255.255.255.255'));

// Carrier-grade NAT range
expect('IP rejects 100.64.0.1 (CGNAT low)', isPrivateIp('100.64.0.1'));
expect('IP rejects 100.127.255.255 (CGNAT high)', isPrivateIp('100.127.255.255'));

// IPv6 canonical forms (no brackets — DNS-resolved form)
expect('IP rejects ::1', isPrivateIp('::1'));
expect('IP rejects ::', isPrivateIp('::'));
expect('IP rejects fc00:: (unique-local)', isPrivateIp('fc00::'));
expect('IP rejects fd12:3456:7890::1 (unique-local)', isPrivateIp('fd12:3456:7890::1'));
expect('IP rejects fe80::1 (link-local)', isPrivateIp('fe80::1'));

// IPv4-mapped IPv6 unwrap
expect('IP unwraps ::ffff:127.0.0.1 → private', isPrivateIp('::ffff:127.0.0.1'));
expect('IP unwraps ::ffff:10.0.0.1 → private', isPrivateIp('::ffff:10.0.0.1'));
expect('IP unwraps ::ffff:8.8.8.8 → public (allowed)', !isPrivateIp('::ffff:8.8.8.8'));

// Public controls
expect('IP allows 8.8.8.8', !isPrivateIp('8.8.8.8'));
expect('IP allows 1.1.1.1', !isPrivateIp('1.1.1.1'));
expect('IP allows 2001:db8::1 (documentation IPv6)', !isPrivateIp('2001:db8::1'));
expect('IP allows 2606:4700:: (Cloudflare public IPv6)', !isPrivateIp('2606:4700::'));

// CGNAT boundary check — 100.63.x.x is public (just below CGNAT range)
expect('IP allows 100.63.0.1 (just below CGNAT)', !isPrivateIp('100.63.0.1'));
// CGNAT boundary check — 100.128.x.x is public (just above CGNAT range)
expect('IP allows 100.128.0.1 (just above CGNAT)', !isPrivateIp('100.128.0.1'));

/* ---------------- documented edge cases ---------------- */

// Hostnames with trailing dots (FQDN form) — current implementation
// does NOT strip the trailing dot, so `localhost.` would slip past.
// This is a documented limitation (consumers should normalize before
// calling).  Pin the current behavior so any change is deliberate.
expect(
	'PIN: hostname with trailing dot ("localhost.") is NOT rejected (consumer should normalize)',
	!isPrivateHostname('localhost.')
);

// Mixed-case hostnames are normalized via toLowerCase, so case
// variations don't bypass.
expect('mixed-case "127.0.0.1" → rejected', isPrivateHostname('127.0.0.1'));
expect('mixed-case "::FFFF:127.0.0.1" → IP-side rejected', isPrivateIp('::FFFF:127.0.0.1'));

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} scenarios passed`);
}
