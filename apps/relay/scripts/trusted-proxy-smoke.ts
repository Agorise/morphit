#!/usr/bin/env tsx
/**
 * apps/relay/scripts/trusted-proxy-smoke.ts
 *
 * Lock in the BunkerWeb / Docker / multi-host nginx trusted-proxy
 * compatibility behavior of clientIp().  A regression here would
 * silently break IPv4-CIDR matching, causing every signup behind
 * BunkerWeb-in-Docker to share the same /24 bucket — Layer 3 / 8
 * defenses would then collapse on a single user.
 *
 * Coverage:
 *   1. Default (no configureTrustedProxies call) trusts loopback
 *      only — direct-from-the-internet attackers cannot forge
 *      X-Forwarded-For.
 *   2. After configureTrustedProxies(['172.18.0.0/16']) the Docker
 *      bridge IPs are accepted as proxies (typical BunkerWeb
 *      compose deployment).
 *   3. Reconfigure resets — a SECOND call replaces the first; old
 *      entries don't linger.
 *   4. Bad CIDRs report rejection without crashing.
 *   5. The default loopback set survives reconfiguration so the
 *      canonical single-host nginx topology continues to work.
 */

import { configureTrustedProxies, clientIp, canonicalBucketKey } from '../src/middleware/ip.ts';

interface FakeContext {
	env: { incoming?: { socket?: { remoteAddress?: string } } };
	req: { header(name: string): string | undefined };
}

function makeCtx(peerIp: string, headers: Record<string, string> = {}): FakeContext {
	return {
		env: { incoming: { socket: { remoteAddress: peerIp } } },
		req: {
			header(name: string): string | undefined {
				return headers[name.toLowerCase()];
			}
		}
	};
}

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.log(`  ✗ ${label}${detail ? `\n    ${detail}` : ''}`);
	}
}

console.log('\n── trusted-proxy CIDR smoke ────────────────────────────\n');

// 1. Reset to default loopback-only state (an empty configure call
//    re-initializes from defaults).
configureTrustedProxies([]);
{
	// A direct-from-internet attacker setting X-Forwarded-For must
	// be ignored — the relay sees the SOCKET peer, not the forged
	// header.
	const ctx = makeCtx('203.0.113.42', {
		'x-forwarded-for': '1.2.3.4',
		'x-real-ip': '1.2.3.4'
	});
	const ip = clientIp(ctx as never);
	check(
		'direct-from-internet attacker cannot forge X-Forwarded-For',
		ip === '203.0.113.42',
		`expected 203.0.113.42, got ${ip}`
	);
}
{
	// Loopback peer: forwarded-for IS honored (canonical single-
	// host nginx topology).
	const ctx = makeCtx('127.0.0.1', {
		'x-forwarded-for': '1.2.3.4'
	});
	const ip = clientIp(ctx as never);
	check(
		'loopback peer: X-Forwarded-For is honored (canonical nginx)',
		ip === '1.2.3.4',
		`expected 1.2.3.4, got ${ip}`
	);
}

// 2. Configure Docker bridge — typical BunkerWeb compose
//    deployment.
configureTrustedProxies(['172.18.0.0/16']);
{
	const ctx = makeCtx('172.18.0.5', {
		'x-forwarded-for': '203.0.113.42'
	});
	const ip = clientIp(ctx as never);
	check(
		'Docker bridge IP (172.18.0.5) trusted after CIDR config',
		ip === '203.0.113.42',
		`expected 203.0.113.42, got ${ip}`
	);
}
{
	// CIDR boundary: 172.18.0.0/16 covers 172.18.0.0 to 172.18.255.255.
	// Test the upper edge.
	const ctx = makeCtx('172.18.255.254', { 'x-forwarded-for': '203.0.113.99' });
	const ip = clientIp(ctx as never);
	check(
		'Docker bridge upper edge (172.18.255.254) is in /16',
		ip === '203.0.113.99',
		`expected 203.0.113.99, got ${ip}`
	);
}
{
	// Outside the /16 — should NOT be trusted.
	const ctx = makeCtx('172.19.0.1', { 'x-forwarded-for': '6.6.6.6' });
	const ip = clientIp(ctx as never);
	check(
		'IP outside the configured /16 (172.19.0.1) NOT trusted',
		ip === '172.19.0.1',
		`expected 172.19.0.1, got ${ip}`
	);
}

// 3. Reconfigure — old entries are flushed.
configureTrustedProxies(['10.0.0.0/8']);
{
	// Old 172.18.x.x range should NO LONGER be trusted.
	const ctx = makeCtx('172.18.0.5', { 'x-forwarded-for': '6.6.6.6' });
	const ip = clientIp(ctx as never);
	check(
		'reconfigure flushes old CIDRs (172.18 no longer trusted)',
		ip === '172.18.0.5',
		`expected 172.18.0.5, got ${ip}`
	);
}
{
	// New 10.x.x.x range IS trusted.
	const ctx = makeCtx('10.5.5.5', { 'x-forwarded-for': '203.0.113.99' });
	const ip = clientIp(ctx as never);
	check(
		'reconfigure adds new CIDR (10.0.0.0/8 now trusted)',
		ip === '203.0.113.99',
		`expected 203.0.113.99, got ${ip}`
	);
}

// 4. Bad CIDR — rejected without crashing.
const result = configureTrustedProxies(['172.18.0.0/16', 'not-an-ip', '999.999.999.999/24']);
check(
	'malformed CIDRs are reported as rejected, not silently ignored',
	result.rejected.length === 2,
	`expected 2 rejected, got ${result.rejected.length}: ${JSON.stringify(result.rejected)}`
);
check(
	'good CIDR survives despite bad ones in the same call',
	result.cidrCount === 1,
	`expected 1 valid CIDR, got ${result.cidrCount}`
);

// 5. Default loopback set survives reconfiguration.
configureTrustedProxies([]);
{
	const ctx = makeCtx('127.0.0.1', { 'x-forwarded-for': '203.0.113.42' });
	const ip = clientIp(ctx as never);
	check(
		'loopback (127.0.0.1) is trusted by default after empty reconfig',
		ip === '203.0.113.42',
		`expected 203.0.113.42, got ${ip}`
	);
}
{
	const ctx = makeCtx('::1', { 'x-forwarded-for': '203.0.113.42' });
	const ip = clientIp(ctx as never);
	check(
		'IPv6 loopback (::1) is trusted by default',
		ip === '203.0.113.42',
		`expected 203.0.113.42, got ${ip}`
	);
}

// 6. canonicalBucketKey of a configured-trusted IP returns the
//    address verbatim (so trusted-peer detection keeps working
//    if someone tries to bucket the proxy itself).
configureTrustedProxies([]); // back to default
check(
	'canonicalBucketKey rounds-trips loopback verbatim',
	canonicalBucketKey('127.0.0.1') === '127.0.0.1',
	'loopback was bucket-key transformed'
);
check(
	'canonicalBucketKey rounds-trips ::1 verbatim',
	canonicalBucketKey('::1') === '::1',
	'::1 was bucket-key transformed'
);

console.log('\n──────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${failures} scenarios failed`);
	process.exit(1);
} else {
	console.log('✓ all 13 scenarios passed');
}
