#!/usr/bin/env tsx
/**
 * Classifier smoke — pins the alert-tier policy.
 *
 * Each scenario is a (alert payload → expected tier) pair.  Event
 * names + payload keys match what the indexer + relay emitters
 * actually produce (apps/{indexer,relay}/src/log) — NOT
 * aspirational names.  Tier policy changes require explicit
 * scenario updates here.
 */

import { classify, type StructuredAlert, type AlertTier } from '../src/classifier.ts';

interface Scenario {
	readonly name: string;
	readonly alert: StructuredAlert;
	readonly expectedTier: AlertTier;
}

function a(
	module: string,
	event: string,
	payload?: Record<string, unknown>
): StructuredAlert {
	return { module, event, payload, ts: '2026-05-14T12:00:00.000Z' };
}

const scenarios: Scenario[] = [
	// ─── CRITICAL — wired in code today ───────────────────────
	{
		name: 'operator-balance low_balance at 0 → CRITICAL (relay halted)',
		alert: a('operator-balance', 'low_balance', {
			account: 'morphit-relay',
			role: 'relay',
			balance_blurt: 0,
			threshold_blurt: 100
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'operator-balance low_balance negative → CRITICAL',
		alert: a('operator-balance', 'low_balance', {
			account: 'morphit-relay',
			role: 'relay',
			balance_blurt: -0.001,
			threshold_blurt: 100
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'operator-balance rpc_sustained_failure → CRITICAL (alerting blind)',
		alert: a('operator-balance', 'rpc_sustained_failure', {
			consecutive_failures: 5,
			last_error: 'ECONNREFUSED'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'operator-balance shape_error → CRITICAL (chain upgrade)',
		alert: a('operator-balance', 'shape_error', {
			account: 'morphit-relay',
			raw_balance: 'malformed'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'signup-ceiling ceiling_reached → CRITICAL (active attack)',
		alert: a('signup-ceiling', 'ceiling_reached', {
			ceiling: 50,
			reached_at: '2026-05-14T18:30:00.000Z',
			resets_at: '2026-05-15T00:00:00.000Z'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'kill-switch kill_switch_activated → CRITICAL',
		alert: a('kill-switch', 'kill_switch_activated', {
			path: '/var/lib/morphit-relay/kill-switch'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'kill-switch kill_switch_active_at_startup → CRITICAL',
		alert: a('kill-switch', 'kill_switch_active_at_startup', {
			path: '/var/lib/morphit-relay/kill-switch'
		}),
		expectedTier: 'CRITICAL'
	},

	// ─── CRITICAL — aspirational (matcher reserved) ──────────
	{
		name: 'witness-fee rpc_sustained_failure → CRITICAL',
		alert: a('witness-fee', 'rpc_sustained_failure'),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'tamper bundle_hash_mismatch → CRITICAL',
		alert: a('tamper', 'bundle_hash_mismatch'),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'tamper pubkey_mismatch → CRITICAL',
		alert: a('tamper', 'pubkey_mismatch'),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'tamper invalid_payload → CRITICAL',
		alert: a('tamper', 'invalid_payload'),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'backup failed → CRITICAL',
		alert: a('backup', 'failed', { reason: 'disk_full' }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'aide integrity_violation → CRITICAL',
		alert: a('aide', 'integrity_violation', { changed: 5 }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'fee-verifier invalid_fee_method → CRITICAL (Memory #23 USDT block)',
		alert: a('fee-verifier', 'invalid_fee_method', { attempted: 'usdt' }),
		expectedTier: 'CRITICAL'
	},

	// ─── CRITICAL — cp10 host-resource ────────────────────────
	{
		name: 'host-resource disk_critical → CRITICAL',
		alert: a('host-resource', 'disk_critical', {
			path: '/',
			percent: 96,
			threshold: 95
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'host-resource mem_critical → CRITICAL',
		alert: a('host-resource', 'mem_critical', { percent: 96, threshold: 95 }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'host-resource swap_critical → CRITICAL',
		alert: a('host-resource', 'swap_critical', { percent: 80, threshold: 75 }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'host-resource swap_thrashing_critical → CRITICAL',
		alert: a('host-resource', 'swap_thrashing_critical', {
			pages_per_sec: 1500,
			pages_in: 800,
			pages_out: 700
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'host-resource cpu_saturated_critical → CRITICAL',
		alert: a('host-resource', 'cpu_saturated_critical', {
			load1: 20.5,
			cores: 4,
			ratio: 5.13,
			threshold: 5
		}),
		expectedTier: 'CRITICAL'
	},

	// ─── WARN — wired in code today ───────────────────────────
	{
		name: 'operator-balance low_balance positive (above zero) → WARN',
		alert: a('operator-balance', 'low_balance', {
			account: 'morphit-relay',
			role: 'relay',
			balance_blurt: 47.2,
			threshold_blurt: 100
		}),
		expectedTier: 'WARN'
	},

	// ─── WARN — aspirational ──────────────────────────────────
	{
		name: 'witness-fee changed → WARN',
		alert: a('witness-fee', 'changed', { old: 100, new: 110 }),
		expectedTier: 'WARN'
	},
	{
		name: 'price feed_stale → WARN (verification unaffected)',
		alert: a('price', 'feed_stale', { last_update_age_min: 90 }),
		expectedTier: 'WARN'
	},
	{
		name: 'price-coingecko feed_stale → WARN',
		alert: a('price-coingecko', 'feed_stale', { last_update_age_min: 60 }),
		expectedTier: 'WARN'
	},
	{
		name: 'price-klingex feed_stale → WARN',
		alert: a('price-klingex', 'feed_stale', { last_update_age_min: 60 }),
		expectedTier: 'WARN'
	},
	{
		name: 'signup-anomaly single_ip_spike → WARN',
		alert: a('signup-anomaly', 'single_ip_spike', {
			ip: '198.51.100.1',
			count: 7
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'federation-probe peer_down_24h → WARN',
		alert: a('federation-probe', 'peer_down_24h', { peer: 'other.example' }),
		expectedTier: 'WARN'
	},
	{
		name: 'sequential-detector pattern_detected → WARN',
		alert: a('sequential-detector', 'pattern_detected', {
			prefix: 'spam',
			count: 3
		}),
		expectedTier: 'WARN'
	},

	// ─── WARN — cp10 host-resource ────────────────────────────
	{
		name: 'host-resource disk_warn → WARN',
		alert: a('host-resource', 'disk_warn', {
			path: '/',
			percent: 87,
			threshold: 85
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'host-resource mem_warn → WARN',
		alert: a('host-resource', 'mem_warn', { percent: 87, threshold: 85 }),
		expectedTier: 'WARN'
	},
	{
		name: 'host-resource swap_warn → WARN',
		alert: a('host-resource', 'swap_warn', { percent: 55, threshold: 50 }),
		expectedTier: 'WARN'
	},
	{
		name: 'host-resource swap_thrashing_warn → WARN',
		alert: a('host-resource', 'swap_thrashing_warn', {
			pages_per_sec: 250,
			pages_in: 150,
			pages_out: 100
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'host-resource cpu_saturated_warn → WARN',
		alert: a('host-resource', 'cpu_saturated_warn', {
			load1: 13.2,
			cores: 4,
			ratio: 3.3,
			threshold: 3
		}),
		expectedTier: 'WARN'
	},

	// ─── INFO (catch-all + reserved kinds) ────────────────────
	{
		name: 'operator-balance balance_recovered → INFO',
		alert: a('operator-balance', 'balance_recovered', {
			account: 'morphit-relay',
			role: 'relay',
			balance_blurt: 250,
			threshold_blurt: 100
		}),
		expectedTier: 'INFO'
	},
	{
		name: 'kill-switch kill_switch_deactivated → INFO',
		alert: a('kill-switch', 'kill_switch_deactivated', {
			path: '/var/lib/morphit-relay/kill-switch'
		}),
		expectedTier: 'INFO'
	},
	{
		name: 'backup succeeded → INFO',
		alert: a('backup', 'succeeded', { size_mb: 432 }),
		expectedTier: 'INFO'
	},
	{
		name: 'federation-probe discovered → INFO',
		alert: a('federation-probe', 'discovered', { peer: 'new.example' }),
		expectedTier: 'INFO'
	},
	{
		name: 'unknown module → INFO (safe default, surface but no rate-limit lookup)',
		alert: a('totally-new-module', 'whatever_event'),
		expectedTier: 'INFO'
	},
	{
		name: 'host-resource disk_info → INFO',
		alert: a('host-resource', 'disk_info', {
			path: '/',
			percent: 72,
			threshold: 70
		}),
		expectedTier: 'INFO'
	},
	{
		name: 'host-resource mem_info → INFO',
		alert: a('host-resource', 'mem_info', { percent: 72, threshold: 70 }),
		expectedTier: 'INFO'
	},
	{
		name: 'host-resource swap_info → INFO',
		alert: a('host-resource', 'swap_info', { percent: 28, threshold: 25 }),
		expectedTier: 'INFO'
	},
	{
		name: 'host-resource cpu_saturated_info → INFO',
		alert: a('host-resource', 'cpu_saturated_info', {
			load1: 7.0,
			cores: 4,
			ratio: 1.75,
			threshold: 1.5
		}),
		expectedTier: 'INFO'
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
