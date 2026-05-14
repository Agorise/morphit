#!/usr/bin/env tsx
/**
 * Classifier smoke — pins the alert-tier policy.
 *
 * Each scenario is a (alert payload → expected tier) pair.  The
 * tier policy controls what wakes an operator at 3 AM, so drift
 * here is non-trivial.  This smoke locks it in: every tier
 * change must come with an explicit scenario update.
 */

import { classify, type StructuredAlert, type AlertTier } from '../src/classifier.ts';

interface Scenario {
	readonly name: string;
	readonly alert: StructuredAlert;
	readonly expectedTier: AlertTier;
}

function alert(
	module: string,
	kind: string,
	payload?: Record<string, unknown>
): StructuredAlert {
	return { module, kind, payload, ts: '2026-05-14T12:00:00.000Z' };
}

const scenarios: Scenario[] = [
	// ─── CRITICAL ─────────────────────────────────────────────
	{
		name: 'tamper bundle-hash mismatch → CRITICAL',
		alert: alert('tamper', 'BUNDLE_HASH_MISMATCH'),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'tamper pubkey mismatch → CRITICAL',
		alert: alert('tamper', 'PUBKEY_MISMATCH'),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'kill-switch fired → CRITICAL',
		alert: alert('kill-switch', 'FIRED', { reason: 'manual' }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'sustained RPC failure → CRITICAL (alerting itself is blind)',
		alert: alert('operator-balance', 'SUSTAINED_RPC_FAILURE', { consecutive: 5 }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'witness-fee SUSTAINED_RPC_FAILURE → CRITICAL',
		alert: alert('witness-fee', 'SUSTAINED_RPC_FAILURE'),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'signup daily ceiling reached → CRITICAL (active attack signal)',
		alert: alert('signup-ceiling', 'ceiling_reached', { ceiling: 20, count: 20 }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'fee-verifier INVALID_FEE_METHOD → CRITICAL (Memory #23 — USDT attempted as listing fee)',
		alert: alert('fee-verifier', 'INVALID_FEE_METHOD', { attempted: 'usdt' }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'backup FAILED → CRITICAL',
		alert: alert('backup', 'FAILED', { reason: 'disk_full' }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'AIDE integrity violation → CRITICAL',
		alert: alert('aide', 'INTEGRITY_VIOLATION', { changed: 5 }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'operator-balance LOW_BALANCE at 0 → CRITICAL (relay halted)',
		alert: alert('operator-balance', 'LOW_BALANCE', {
			current_blurt: 0,
			threshold_blurt: 100,
			account: 'my-relay',
			role: 'relay'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'operator-balance LOW_BALANCE negative → CRITICAL',
		alert: alert('operator-balance', 'LOW_BALANCE', {
			current_blurt: -0.001,
			threshold_blurt: 100
		}),
		expectedTier: 'CRITICAL'
	},

	// ─── WARN ─────────────────────────────────────────────────
	{
		name: 'operator-balance LOW_BALANCE positive but below threshold → WARN',
		alert: alert('operator-balance', 'LOW_BALANCE', {
			current_blurt: 47.2,
			threshold_blurt: 100,
			account: 'my-relay',
			role: 'relay'
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'witness-fee CHANGED → WARN',
		alert: alert('witness-fee', 'CHANGED', { old: 100, new: 110 }),
		expectedTier: 'WARN'
	},
	{
		name: 'price-feed STALE → WARN (fee verification unaffected)',
		alert: alert('price-feed', 'STALE', { last_update_age_min: 90 }),
		expectedTier: 'WARN'
	},
	{
		name: 'signup-anomaly SINGLE_IP_SPIKE → WARN',
		alert: alert('signup-anomaly', 'SINGLE_IP_SPIKE', { ip: '198.51.100.1', count: 7 }),
		expectedTier: 'WARN'
	},
	{
		name: 'federation-probe PEER_DOWN_24H → WARN',
		alert: alert('federation-probe', 'PEER_DOWN_24H', { peer: 'other.example' }),
		expectedTier: 'WARN'
	},
	{
		name: 'sequential-detector PATTERN_DETECTED → WARN',
		alert: alert('sequential-detector', 'PATTERN_DETECTED', { prefix: 'spam', count: 3 }),
		expectedTier: 'WARN'
	},

	// ─── INFO (catch-all) ─────────────────────────────────────
	{
		name: 'operator-balance RECOVERED → INFO',
		alert: alert('operator-balance', 'RECOVERED', { current_blurt: 250 }),
		expectedTier: 'INFO'
	},
	{
		name: 'backup SUCCEEDED → INFO',
		alert: alert('backup', 'SUCCEEDED', { size_mb: 432 }),
		expectedTier: 'INFO'
	},
	{
		name: 'federation-probe DISCOVERED → INFO',
		alert: alert('federation-probe', 'DISCOVERED', { peer: 'new.example' }),
		expectedTier: 'INFO'
	},
	{
		name: 'unknown module → INFO (safe default — surface but no rate limit lookup)',
		alert: alert('totally-new-module', 'WHATEVER_EVENT'),
		expectedTier: 'INFO'
	},

	// ─── adversarial: empty payload ───────────────────────────
	{
		name: 'tamper BUNDLE_HASH_MISMATCH with no payload still classifies CRITICAL',
		alert: alert('tamper', 'BUNDLE_HASH_MISMATCH'),
		expectedTier: 'CRITICAL'
	}
];

let pass = 0;
let fail = 0;
console.log('classifier smoke:\n');
for (const s of scenarios) {
	const result = classify(s.alert);
	const ok = result.tier === s.expectedTier;
	if (ok) {
		console.log(`  ✓ ${s.name}`);
		pass++;
	} else {
		console.error(`  ✗ ${s.name}`);
		console.error(`      expected ${s.expectedTier}, got ${result.tier}`);
		fail++;
	}
}
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} tier-policy scenarios hold`);
	process.exit(0);
} else {
	console.error(`✗ ${fail} failed, ${pass} passed — TIER POLICY DRIFT`);
	process.exit(1);
}
