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
	},

	// ─── CRITICAL — cp11 smartctl/fail2ban/mdadm ─────────────
	{
		name: 'smartctl smart_failed → CRITICAL',
		alert: a('smartctl', 'smart_failed', { device: '/dev/sda' }),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'smartctl self_test_failed → CRITICAL',
		alert: a('smartctl', 'self_test_failed', {
			device: '/dev/sda',
			result: 'Completed: read failure'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'smartctl temperature_critical → CRITICAL',
		alert: a('smartctl', 'temperature_critical', {
			device: '/dev/sda',
			temperature_c: 62,
			threshold: 60
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'fail2ban daemon_unreachable → CRITICAL (no protection!)',
		alert: a('fail2ban', 'daemon_unreachable', {
			error: 'Could not find server',
			hint: 'check sudo systemctl status fail2ban'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'fail2ban jail_critical_ban_count → CRITICAL',
		alert: a('fail2ban', 'jail_critical_ban_count', {
			jail: 'sshd',
			currently_banned: 55,
			threshold: 50
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'mdadm array_failed → CRITICAL (data loss imminent)',
		alert: a('mdadm', 'array_failed', {
			array: 'md0',
			level: 'raid1',
			state: '[__]'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'mdadm array_degraded → CRITICAL (redundancy lost)',
		alert: a('mdadm', 'array_degraded', {
			array: 'md0',
			level: 'raid1',
			state: '[U_]'
		}),
		expectedTier: 'CRITICAL'
	},

	// ─── WARN — cp11 smartctl/fail2ban ───────────────────────
	{
		name: 'smartctl reallocated_sectors → WARN',
		alert: a('smartctl', 'reallocated_sectors', {
			device: '/dev/sda',
			count: 12
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'smartctl pending_sectors → WARN',
		alert: a('smartctl', 'pending_sectors', {
			device: '/dev/sda',
			count: 3
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'smartctl temperature_warn → WARN',
		alert: a('smartctl', 'temperature_warn', {
			device: '/dev/sda',
			temperature_c: 52,
			threshold: 50
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'fail2ban jail_high_ban_count → WARN',
		alert: a('fail2ban', 'jail_high_ban_count', {
			jail: 'sshd',
			currently_banned: 20,
			threshold: 15
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'fail2ban jail_ban_rate_warn → WARN',
		alert: a('fail2ban', 'jail_ban_rate_warn', {
			jail: 'sshd',
			bans_per_hour: 150,
			delta: 12,
			elapsed_sec: 290
		}),
		expectedTier: 'WARN'
	},

	// ─── INFO — cp11 catch-alls ──────────────────────────────
	{
		name: 'mdadm array_resyncing → INFO (digest)',
		alert: a('mdadm', 'array_resyncing', {
			array: 'md0',
			level: 'raid1'
		}),
		expectedTier: 'INFO'
	},
	{
		name: 'smartctl smartctl_unavailable → INFO (digest)',
		alert: a('smartctl', 'smartctl_unavailable', {
			hint: 'install smartmontools'
		}),
		expectedTier: 'INFO'
	},
	{
		name: 'fail2ban fail2ban_unavailable → INFO (digest)',
		alert: a('fail2ban', 'fail2ban_unavailable', {
			hint: 'install fail2ban'
		}),
		expectedTier: 'INFO'
	},

	// ─── CRITICAL — cp12 dmesg ────────────────────────────────
	{
		name: 'dmesg oom_kill → CRITICAL',
		alert: a('dmesg', 'oom_kill', {
			victim_proc: 'morphit-relay',
			victim_pid: 1234,
			raw_line: 'Out of memory: Killed process 1234 (morphit-relay)...'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'dmesg kernel_oops → CRITICAL',
		alert: a('dmesg', 'kernel_oops', {
			raw_line: 'kernel: Oops: 0000 [#1] SMP NOPTI...'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'dmesg kernel_panic → CRITICAL',
		alert: a('dmesg', 'kernel_panic', {
			raw_line: 'Kernel panic - not syncing: Fatal exception...'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'dmesg hardware_error → CRITICAL',
		alert: a('dmesg', 'hardware_error', {
			raw_line: 'EDAC MC0: 1 CE memory error on socket 0...'
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'dmesg segfault_in_morphit → CRITICAL (a morphit service crashed)',
		alert: a('dmesg', 'segfault_in_morphit', {
			raw_line: 'node[5678]: segfault at 0 ip 00007fab...'
		}),
		expectedTier: 'CRITICAL'
	},

	// ─── CRITICAL — cp12 trivy + postfix ─────────────────────
	{
		name: 'trivy image_critical_vulns → CRITICAL',
		alert: a('trivy', 'image_critical_vulns', {
			image: 'bunkerity/bunkerweb:1.5.10',
			critical_count: 3,
			high_count: 12,
			threshold: 1
		}),
		expectedTier: 'CRITICAL'
	},
	{
		name: 'postfix queue_critical → CRITICAL (alerting may be silently failing)',
		alert: a('postfix', 'queue_critical', {
			queue_depth: 150,
			oldest_age_min: 240,
			queue_threshold: 100,
			age_threshold_min: 120
		}),
		expectedTier: 'CRITICAL'
	},

	// ─── WARN — cp12 ───────────────────────────────────────────
	{
		name: 'dmesg segfault_other → WARN',
		alert: a('dmesg', 'segfault_other', {
			raw_line: 'random-binary[9999]: segfault at...'
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'dmesg fd_exhausted → WARN',
		alert: a('dmesg', 'fd_exhausted', {
			raw_line: 'fork failed: Resource temporarily unavailable'
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'trivy image_high_vulns → WARN',
		alert: a('trivy', 'image_high_vulns', {
			image: 'bunkerity/bunkerweb:1.5.10',
			critical_count: 0,
			high_count: 8,
			threshold: 5
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'trivy image_scan_failed → WARN',
		alert: a('trivy', 'image_scan_failed', {
			image: 'some/image:latest',
			hint: 'check trivy CVE DB connectivity'
		}),
		expectedTier: 'WARN'
	},
	{
		name: 'postfix queue_warn → WARN',
		alert: a('postfix', 'queue_warn', {
			queue_depth: 30,
			oldest_age_min: 45,
			queue_threshold: 25,
			age_threshold_min: 30
		}),
		expectedTier: 'WARN'
	},

	// ─── INFO — cp12 catch-alls ───────────────────────────────
	{
		name: 'dmesg dmesg_unreadable → INFO (digest)',
		alert: a('dmesg', 'dmesg_unreadable', { hint: 'run as root' }),
		expectedTier: 'INFO'
	},
	{
		name: 'trivy image_scan_clean → INFO (digest)',
		alert: a('trivy', 'image_scan_clean', {
			image: 'bunkerity/bunkerweb:1.5.10',
			critical_count: 0,
			high_count: 1
		}),
		expectedTier: 'INFO'
	},
	{
		name: 'trivy trivy_unavailable → INFO (digest)',
		alert: a('trivy', 'trivy_unavailable', { hint: 'install trivy' }),
		expectedTier: 'INFO'
	},
	{
		name: 'postfix queue_clean → INFO (digest)',
		alert: a('postfix', 'queue_clean', { queue_depth: 0, oldest_age_min: 0 }),
		expectedTier: 'INFO'
	},
	{
		name: 'postfix postfix_unavailable → INFO (digest)',
		alert: a('postfix', 'postfix_unavailable', { hint: 'install postfix' }),
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
