/**
 * @morphit/net-defense self-test smoke.
 *
 * The package exports two pure functions consumed by both the
 * indexer (full SSRF lockdown) and the mcp-server (opt-in
 * private-address rejection).  This smoke is the canonical
 * regression test for the package — if either function ever
 * drifts, this smoke fires before any downstream consumer's
 * tamper test does.
 *
 * Mirrors the structure of the `scripts/strip-comments-smoke.ts`
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
 * byte identical to the older implementations in
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

// Hostnames with a trailing root dot (FQDN form) name the same host:
// `localhost.` and `printer.local.` are caught like their dotless forms
// (see the legacy-spelling scenarios below).

// Mixed-case hostnames are normalized via toLowerCase, so case
// variations don't bypass.
expect('mixed-case "127.0.0.1" → rejected', isPrivateHostname('127.0.0.1'));
expect('mixed-case "::FFFF:127.0.0.1" → IP-side rejected', isPrivateIp('::FFFF:127.0.0.1'));

/* ---------------- report ---------------- */

let failed = 0;
/* ---------------- (D13) ----------------
 * Forms the probe-time check used to MISS. The registration-time check (a
 * BlockList in hidden-transport) caught some of them, the probe did not: two
 * homes for one decision. Each is fed exactly as a consumer sees it — the
 * hostname from `new URL()` (which normalises ::ffff:127.0.0.1 to its hex
 * form) and a resolver-style bare address. */
const hostOf = (u: string) => new URL(u).hostname;
for (const [label, url] of [
	['IPv4-mapped loopback, hex form', 'https://[::ffff:127.0.0.1]/'],
	['IPv4-mapped RFC1918, hex form', 'https://[::ffff:10.0.0.1]:8081/'],
	['IPv4-mapped metadata, hex form', 'https://[::ffff:169.254.169.254]/'],
	['NAT64 64:ff9b::/96', 'https://[64:ff9b::7f00:1]/'],
	['6to4 2002::/16', 'https://[2002:7f00:1::1]/'],
	['site-local fec0::/10', 'https://[fec0::1]/'],
	['IPv6 multicast', 'https://[ff02::1]/'],
	['IPv4-compatible ::a.b.c.d', 'https://[::127.0.0.1]/'],
	['benchmarking 198.18.0.0/15', 'https://198.19.0.1/'],
	['IPv4 multicast 224/4', 'https://239.1.2.3/'],
	['0.0.0.0/8', 'https://0.0.0.1/'],
	['CGNAT 100.64/10', 'https://100.64.0.1/']
] as const) {
	expect(`isPrivateHostname rejects ${label}`, isPrivateHostname(hostOf(url)), `hostname=${hostOf(url)}`);
}
for (const [label, ip] of [
	['::ffff:7f00:1', '::ffff:7f00:1'],
	['::ffff:a00:1', '::ffff:a00:1'],
	['64:ff9b::7f00:1', '64:ff9b::7f00:1'],
	['2002:a00:1::1', '2002:a00:1::1'],
	['fec0::1', 'fec0::1'],
	['ff02::1', 'ff02::1'],
	['::7f00:1', '::7f00:1'],
	['198.18.0.1', '198.18.0.1'],
	['224.0.0.1', '224.0.0.1']
] as const) {
	expect(`isPrivateIp rejects ${label}`, isPrivateIp(ip));
}
// Legacy IPv4 spellings that inet_aton / getaddrinfo still resolve: decimal,
// hex, octal and short forms all reach the same address, so they are judged
// by the address they spell. A trailing root dot is the same name.
for (const h of [
	'2130706433',
	'0x7f000001',
	'0x7f.0.0.1',
	'0177.0.0.1',
	'127.1',
	'10.1',
	'0xa.0x0.0x0.0x1',
	'3232235777',
	'169.254.43518',
	'localhost.',
	'printer.local.'
]) {
	expect(`isPrivateHostname catches the spelling ${h}`, isPrivateHostname(h));
}
for (const h of ['16843009', '0x1010101', '1.1.257', 'example.com.', '1.2.3.4.5', '08.1.1.1']) {
	expect(`isPrivateHostname leaves ${h} alone`, !isPrivateHostname(h));
}
// And the check must not over-reach: real public addresses stay public.
for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:5db8:d822']) {
	expect(`isPrivateIp keeps ${ip} public`, !isPrivateIp(ip));
	expect(`isPrivateHostname keeps ${ip} public`, !isPrivateHostname(ip.includes(':') ? `[${ip}]` : ip));
}

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
