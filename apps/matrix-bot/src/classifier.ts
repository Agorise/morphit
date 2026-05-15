/**
 * Alert classifier — assigns each incoming structured-JSON alert
 * a tier (CRITICAL / WARN / INFO) that determines:
 *
 *   - CRITICAL: deliver immediately, NO rate limit, NO aggregation
 *   - WARN: rate-limited (1/hour per category), DM individually
 *   - INFO: aggregated into a daily digest, sent once at 09:00 UTC
 *
 * Event names + payload field names use the actual shape emitted
 * by the indexer + relay loggers (apps/{indexer,relay}/src/log).
 * Both emit JSON envelopes of the form:
 *
 *   { ts, level, module, event, context: {...payload}, error? }
 *
 * The bot's parseJournalLine maps `event` → StructuredAlert.event
 * and pulls payload from the `context` object.
 *
 * Tier policy = source-of-truth for what wakes the operator at
 * 3 AM.  Changing it requires updating classifier-smoke in the
 * same commit.
 */

export type AlertTier = 'CRITICAL' | 'WARN' | 'INFO';

/** A structured alert payload, as emitted by indexer/relay
 *  modules through the shared logger (apps/{indexer,relay}/src/log)
 *  and read off journalctl by the bot.  Event names are
 *  lowercase_with_underscores per the established convention. */
export interface StructuredAlert {
	readonly module: string;
	readonly event: string;
	readonly payload?: Record<string, unknown>;
	readonly source?: string;
	readonly ts: string;
}

export type AlertCategory = string;

export interface ClassifiedAlert {
	readonly tier: AlertTier;
	readonly category: AlertCategory;
	readonly alert: StructuredAlert;
}

// ─── Tier matchers ───────────────────────────────────────────────

const CRITICAL_MATCHERS: ReadonlyArray<(a: StructuredAlert) => boolean> = [
	// operator-balance: LOW_BALANCE at zero or below is CRITICAL
	// (relay halts welcome bonuses).  Above zero is WARN below.
	(a) =>
		a.module === 'operator-balance' &&
		a.event === 'low_balance' &&
		typeof a.payload?.['balance_blurt'] === 'number' &&
		(a.payload['balance_blurt'] as number) <= 0,
	// operator-balance: indexer can't reach the chain — alerting is BLIND.
	(a) => a.module === 'operator-balance' && a.event === 'rpc_sustained_failure',
	// operator-balance: balance shape unparseable — chain upgrade?
	(a) => a.module === 'operator-balance' && a.event === 'shape_error',
	// signup-ceiling: daily ceiling hit (likely under attack).
	(a) => a.module === 'signup-ceiling' && a.event === 'ceiling_reached',
	// kill-switch: signups halted (manual or auto-on-startup).
	(a) => a.module === 'kill-switch' && a.event === 'kill_switch_activated',
	(a) => a.module === 'kill-switch' && a.event === 'kill_switch_active_at_startup',
	// witness-fee poller blind (aspirational — emit code pending).
	(a) => a.module === 'witness-fee' && a.event === 'rpc_sustained_failure',
	// tamper detection (aspirational).
	(a) => a.module === 'tamper' && a.event === 'bundle_hash_mismatch',
	(a) => a.module === 'tamper' && a.event === 'pubkey_mismatch',
	(a) => a.module === 'tamper' && a.event === 'invalid_payload',
	// Backup unit failure.
	(a) => a.module === 'backup' && a.event === 'failed',
	// AIDE integrity violation.
	(a) => a.module === 'aide' && a.event === 'integrity_violation',
	// fee-verifier invariant violation attempt (Memory #23).
	(a) => a.module === 'fee-verifier' && a.event === 'invalid_fee_method',

	// cp10 host-resource — disk/mem/swap/swap-thrashing/cpu
	// at CRITICAL level.  Emit code: ops/scripts/morphit-host-monitor.sh.
	(a) => a.module === 'host-resource' && a.event === 'disk_critical',
	(a) => a.module === 'host-resource' && a.event === 'mem_critical',
	(a) => a.module === 'host-resource' && a.event === 'swap_critical',
	(a) => a.module === 'host-resource' && a.event === 'swap_thrashing_critical',
	(a) => a.module === 'host-resource' && a.event === 'cpu_saturated_critical',

	// cp11 extended monitoring — disk SMART, fail2ban, mdadm RAID.
	// Emit code: ops/scripts/morphit-{smartctl,fail2ban,mdadm}-monitor.sh.
	(a) => a.module === 'smartctl' && a.event === 'smart_failed',
	(a) => a.module === 'smartctl' && a.event === 'self_test_failed',
	(a) => a.module === 'smartctl' && a.event === 'temperature_critical',
	(a) => a.module === 'fail2ban' && a.event === 'daemon_unreachable',
	(a) => a.module === 'fail2ban' && a.event === 'jail_critical_ban_count',
	(a) => a.module === 'mdadm' && a.event === 'array_failed',
	(a) => a.module === 'mdadm' && a.event === 'array_degraded',

	// cp12 — dmesg kernel-log events.  All CRITICAL except
	// segfault_other (WARN) and dmesg_unreadable (INFO).
	(a) => a.module === 'dmesg' && a.event === 'oom_kill',
	(a) => a.module === 'dmesg' && a.event === 'kernel_oops',
	(a) => a.module === 'dmesg' && a.event === 'kernel_panic',
	(a) => a.module === 'dmesg' && a.event === 'hardware_error',
	(a) => a.module === 'dmesg' && a.event === 'segfault_in_morphit',

	// cp12 — trivy Docker image vulnerability scan.
	(a) => a.module === 'trivy' && a.event === 'image_critical_vulns',

	// cp12 — postfix queue depth (silent-alerting-failure detector).
	(a) => a.module === 'postfix' && a.event === 'queue_critical',

	// cp13 — certbot TLS cert expiry + renewal-stall.
	(a) => a.module === 'certbot' && a.event === 'cert_expiry_critical',
	(a) => a.module === 'certbot' && a.event === 'renewal_stalled',

	// cp13 — apt pending security updates.
	(a) => a.module === 'apt' && a.event === 'security_updates_critical',

	// cp13 — Docker Compose service health.
	(a) => a.module === 'compose' && a.event === 'service_unhealthy',
	(a) => a.module === 'compose' && a.event === 'service_exited',

	// cp14 — systemd unit health.
	(a) => a.module === 'systemd' && a.event === 'unit_failed',

	// cp14 — journald disk usage (filling-disk-silently).
	(a) => a.module === 'journald' && a.event === 'journal_size_critical'
];

const WARN_MATCHERS: ReadonlyArray<(a: StructuredAlert) => boolean> = [
	// operator-balance: low but above zero.  CRITICAL caught zero-or-below.
	(a) => a.module === 'operator-balance' && a.event === 'low_balance',
	// witness-fee: chain fee changed.
	(a) => a.module === 'witness-fee' && a.event === 'changed',
	// Price feed stale.
	(a) => a.module === 'price' && a.event === 'feed_stale',
	(a) => a.module === 'price-coingecko' && a.event === 'feed_stale',
	(a) => a.module === 'price-klingex' && a.event === 'feed_stale',
	// signup-anomaly probe.
	(a) => a.module === 'signup-anomaly' && a.event === 'single_ip_spike',
	// federation peer down a while.
	(a) => a.module === 'federation-probe' && a.event === 'peer_down_24h',
	// sequential pattern (Layer 8).
	(a) => a.module === 'sequential-detector' && a.event === 'pattern_detected',

	// cp10 host-resource — WARN tier.
	(a) => a.module === 'host-resource' && a.event === 'disk_warn',
	(a) => a.module === 'host-resource' && a.event === 'mem_warn',
	(a) => a.module === 'host-resource' && a.event === 'swap_warn',
	(a) => a.module === 'host-resource' && a.event === 'swap_thrashing_warn',
	(a) => a.module === 'host-resource' && a.event === 'cpu_saturated_warn',

	// cp11 extended monitoring — WARN tier.
	(a) => a.module === 'smartctl' && a.event === 'reallocated_sectors',
	(a) => a.module === 'smartctl' && a.event === 'pending_sectors',
	(a) => a.module === 'smartctl' && a.event === 'temperature_warn',
	(a) => a.module === 'fail2ban' && a.event === 'jail_high_ban_count',
	(a) => a.module === 'fail2ban' && a.event === 'jail_ban_rate_warn',

	// cp12 — WARN tier.
	(a) => a.module === 'dmesg' && a.event === 'segfault_other',
	(a) => a.module === 'dmesg' && a.event === 'fd_exhausted',
	(a) => a.module === 'trivy' && a.event === 'image_high_vulns',
	(a) => a.module === 'trivy' && a.event === 'image_scan_failed',
	(a) => a.module === 'postfix' && a.event === 'queue_warn',

	// cp13 — WARN tier.
	(a) => a.module === 'certbot' && a.event === 'cert_expiry_warn',
	(a) => a.module === 'apt' && a.event === 'security_updates_warn',
	(a) => a.module === 'compose' && a.event === 'service_restart_loop',

	// cp14 — WARN tier.
	(a) => a.module === 'systemd' && a.event === 'unit_restart_loop',
	(a) => a.module === 'systemd' && a.event === 'unit_missing',
	(a) => a.module === 'journald' && a.event === 'journal_size_warn',
	(a) => a.module === 'journald' && a.event === 'journal_rotation_stale'
];

export function classify(alert: StructuredAlert): ClassifiedAlert {
	const category: AlertCategory = `${alert.module}:${alert.event}`;
	for (const match of CRITICAL_MATCHERS) {
		if (match(alert)) return { tier: 'CRITICAL', category, alert };
	}
	for (const match of WARN_MATCHERS) {
		if (match(alert)) return { tier: 'WARN', category, alert };
	}
	return { tier: 'INFO', category, alert };
}

// ─── Friendly copy per (module, event) ───────────────────────────

interface AlertCopyEntry {
	readonly title: string;
	readonly advice: string;
}

const ALERT_COPY: Record<string, AlertCopyEntry> = {
	// ─── WIRED IN CODE TODAY (operator-balance) ───────────────
	'operator-balance:low_balance': {
		title: 'Operator account low: @{account}',
		advice:
			'@{account} ({role}) is at {balance_blurt} BLURT, below your alert ' +
			'threshold of {threshold_blurt}. If this number is 0 or negative, ' +
			'your relay has STOPPED processing welcome bonuses and dust refills — ' +
			'top up immediately. If still positive, top up before it hits zero. ' +
			'WARN alerts for this account are rate-limited to one per hour.'
	},
	'operator-balance:balance_recovered': {
		title: 'Operator account recovered: @{account}',
		advice:
			'@{account} ({role}) is back to {balance_blurt} BLURT, above the alert ' +
			'threshold of {threshold_blurt}. Your top-up landed cleanly.'
	},
	'operator-balance:rpc_sustained_failure': {
		title: 'Indexer cannot reach Blurt chain — alerting is BLIND',
		advice:
			'The indexer failed {consecutive_failures} consecutive balance checks. ' +
			'You would NOT know right now if your operator account got drained. ' +
			'Check: (1) internet connectivity, (2) MORPHIT_INDEXER_RPC_ENDPOINTS, ' +
			'(3) try `curl <one-of-your-rpc-endpoints>/health`. Last error: ' +
			'{last_error}'
	},
	'operator-balance:shape_error': {
		title: 'Operator-balance response is unparseable',
		advice:
			'The chain returned a balance value Morphit could not parse for ' +
			'@{account}. Usually means a Blurt chain upgrade changed the RPC ' +
			'response shape. Raw value: {raw_balance}. Balance monitoring for ' +
			'this account is paused until you upgrade Morphit.'
	},

	// ─── WIRED IN CODE TODAY (signup-ceiling) ─────────────────
	'signup-ceiling:ceiling_reached': {
		title: 'Daily signup ceiling hit — likely under attack',
		advice:
			'Your instance hit the daily ceiling of {ceiling} signups. New ' +
			'signups will be refused until {resets_at}. This usually means an ' +
			'active attack. Check `journalctl -u morphit-relay --since "1 hour ' +
			'ago" | grep signup` for source IPs and patterns. Consider: lowering ' +
			'the ceiling, toggling MORPHIT_RELAY_SIGNUP_ENABLED=false, or ' +
			'following the response playbook in OPERATIONS.md §38.'
	},

	// ─── WIRED IN CODE TODAY (kill-switch) ────────────────────
	'kill-switch:kill_switch_activated': {
		title: 'Kill-switch activated — signups halted',
		advice:
			'Account creation is now HALTED on your instance. The kill-switch ' +
			'file exists at {path}. If you (or a co-operator) put it there, this ' +
			'is expected. If not — someone else has shell access. Existing users ' +
			'unaffected; no new accounts until the file is removed.'
	},
	'kill-switch:kill_switch_active_at_startup': {
		title: 'Relay restarted with kill-switch ON — signups still halted',
		advice:
			'The relay just restarted and found the kill-switch file already in ' +
			'place at {path}. Signups are halted. If unexpected (e.g. you wanted ' +
			'signups to resume on restart), remove the file with `sudo rm {path}` ' +
			'— the relay picks that up within ~10s.'
	},
	'kill-switch:kill_switch_deactivated': {
		title: 'Kill-switch deactivated — signups resumed',
		advice:
			'The kill-switch file at {path} is gone. Account creation is back ON.'
	},

	// ─── ASPIRATIONAL (matcher reserved; emit code pending) ───
	'witness-fee:rpc_sustained_failure': {
		title: 'Witness fee poller cannot reach Blurt chain',
		advice:
			'The poller failed multiple consecutive checks. Your relay is using ' +
			'its fallback MORPHIT_RELAY_ACCOUNT_CREATION_FEE_BLURT — if witnesses ' +
			'raised the fee, your relay will start refusing signups (sanity ' +
			'check rejects the mismatch).'
	},
	'witness-fee:changed': {
		title: 'Blurt witnesses changed the chain account-creation fee',
		advice:
			'Chain fee went from {old} → {new} BLURT. Update ' +
			'MORPHIT_RELAY_ACCOUNT_CREATION_FEE_BLURT in /etc/morphit/relay.env ' +
			'to {new} and restart the relay.'
	},
	'tamper:bundle_hash_mismatch': {
		title: 'Frontend code does not match the on-chain signed release',
		advice:
			'Users visiting your instance right now may be running modified code. ' +
			'Check your web server + CDN. If you did not deploy a hot-fix, this ' +
			'could be a compromise. See OPERATIONS.md §37.10.1.'
	},
	'tamper:pubkey_mismatch': {
		title: 'Release-signing pubkey does not match expected',
		advice:
			'The pubkey signing release ops is not the one this instance expects. ' +
			'Either you rotated the key and forgot to redeploy, OR the chain ' +
			'account that signs releases has been compromised.'
	},
	'tamper:invalid_payload': {
		title: 'Release op carries an invalid payload',
		advice:
			'The frontend tamper-detector found a release op on chain whose ' +
			'payload is structurally invalid. Either an attacker is broadcasting ' +
			'fake release ops, or you accidentally broadcast a malformed one.'
	},
	'price:feed_stale': {
		title: 'BLURT/USD price feed stale',
		advice:
			'Feed is {last_update_age_min} min old. Fee verification is ' +
			'unaffected (Morphit verifies fees in native BLURT, not USD). USD ' +
			'echoes on the frontend will be off until the feed recovers.'
	},
	'signup-anomaly:single_ip_spike': {
		title: 'Signup spike from a single IP',
		advice:
			'IP {ip} made {count} signup attempts within the detection window. ' +
			'Your existing rate limits already blocked most of these. If repeat ' +
			'spikes persist, consider banning the IP via ufw or BunkerWeb.'
	},
	'federation-probe:peer_down_24h': {
		title: 'Federation peer offline for over 24 hours',
		advice:
			'{peer} has not responded to /v1/health for >24h. Their orders will ' +
			'not appear in your orderbook. Auto-recovers when they come back.'
	},
	'sequential-detector:pattern_detected': {
		title: 'Sequential signup pattern detected',
		advice:
			'{count} signups in a row used the prefix "{prefix}" (e.g. {prefix}01, ' +
			'{prefix}02). The Layer 8 detector already rejected these — no ACTs ' +
			'consumed. Situational awareness only.'
	},
	'fee-verifier:invalid_fee_method': {
		title: 'Someone attempted a listing fee in a disallowed asset',
		advice:
			'A user tried to pay a listing fee using "{attempted}". The Morphit ' +
			'invariant (BLURT/BTC/XMR only) blocked it at the database CHECK ' +
			'constraint. Order rejected.'
	},
	'backup:failed': {
		title: 'Backup did not complete',
		advice:
			'morphit-backup.service failed. reason={reason}. Every hour without ' +
			'backups is potential data loss. Check: disk space (`df -h`), backup ' +
			'destination, `journalctl -u morphit-backup --since "1 hour ago"`.'
	},
	'backup:succeeded': {
		title: 'Backup completed',
		advice: 'Wrote {size_mb} MB. Normal operation.'
	},
	'aide:integrity_violation': {
		title: 'System files modified without authorization',
		advice:
			'AIDE detected {changed} unauthorized changes to monitored system ' +
			'files. Could be legitimate (you applied an update) or a compromise. ' +
			'Run `sudo journalctl -t aide` for the list. OPERATIONS.md §37.9 has ' +
			'the response procedure.'
	},
	'federation-probe:discovered': {
		title: 'New federation peer discovered',
		advice: '{peer} is now visible in the federation directory.'
	},

	// ─── cp10 host-resource sidecar ────────────────────────────
	'host-resource:disk_critical': {
		title: 'Disk almost full: {path}',
		advice:
			'{path} is at {percent}% (threshold {threshold}%). If this fills, ' +
			'morphit-indexer will fail writes, Postgres will refuse commits, ' +
			'backups will fail. Free space NOW: `sudo journalctl --vacuum-time=7d`, ' +
			'`sudo apt clean`, prune old releases. Long-term: enlarge the disk ' +
			'or move backups off-host.'
	},
	'host-resource:disk_warn': {
		title: 'Disk usage high: {path}',
		advice:
			'{path} is at {percent}% (threshold {threshold}%). Not critical yet. ' +
			'Check what is using space: ' +
			'`sudo du -h --max-depth=1 / 2>/dev/null | sort -h | tail -10`. ' +
			'WARN alerts for this path are rate-limited to one per hour.'
	},
	'host-resource:disk_info': {
		title: 'Disk usage notice: {path}',
		advice:
			'{path} is at {percent}% (informational threshold {threshold}%). ' +
			'Trending up; no action needed yet. Bundled into the daily digest.'
	},
	'host-resource:mem_critical': {
		title: 'Memory critically low',
		advice:
			'Memory usage is at {percent}% (threshold {threshold}%). The OOM ' +
			'killer will start killing processes soon — morphit-indexer or ' +
			'morphit-relay could be victims. Check: `free -h`, ' +
			'`ps aux --sort=-%mem | head -10`. Add swap/RAM, restart offending ' +
			'processes, or temporarily disable features.'
	},
	'host-resource:mem_warn': {
		title: 'Memory usage high',
		advice:
			'Memory usage is at {percent}% (threshold {threshold}%). Check what ' +
			'is using it with `ps aux --sort=-%mem | head -10`. If it climbs ' +
			'further, plan a restart or capacity bump. Rate-limited to one per hour.'
	},
	'host-resource:mem_info': {
		title: 'Memory usage notice',
		advice:
			'Memory usage is at {percent}% (informational threshold {threshold}%). ' +
			'Bundled into the daily digest.'
	},
	'host-resource:swap_critical': {
		title: 'Swap critically full',
		advice:
			'Swap is at {percent}% used (threshold {threshold}%). Combined with ' +
			'memory pressure this means the system is about to start failing ' +
			'allocations. Check `free -h` and `vmstat 1 5`. Same remedies as low ' +
			'memory: add RAM, restart heavy processes, reduce workload.'
	},
	'host-resource:swap_warn': {
		title: 'Swap usage high',
		advice:
			'Swap is at {percent}% used (threshold {threshold}%). The system is ' +
			'paging — performance will be degraded. Add RAM or reduce memory ' +
			'pressure when convenient. Rate-limited to one per hour.'
	},
	'host-resource:swap_info': {
		title: 'Swap in use',
		advice:
			'Swap is at {percent}% used (informational threshold {threshold}%). ' +
			'Some swap use is normal on Linux; the daily digest surfaces this so ' +
			'you can trend it.'
	},
	'host-resource:swap_thrashing_critical': {
		title: 'Swap thrashing severely — system unresponsive',
		advice:
			'Pages in+out hitting {pages_per_sec}/sec (in={pages_in}, ' +
			'out={pages_out}). The system is spending most of its time moving ' +
			'memory between RAM and swap — useful work is barely happening. ' +
			'Immediate fix: kill the largest memory consumer ' +
			'(`ps aux --sort=-%mem | head -5`) to free RAM. Long-term: more RAM ' +
			'or less memory pressure.'
	},
	'host-resource:swap_thrashing_warn': {
		title: 'Swap thrashing detected',
		advice:
			'Pages in+out hitting {pages_per_sec}/sec (in={pages_in}, ' +
			'out={pages_out}). Performance is degraded but the system is still ' +
			'functional. Check what is consuming memory and address before this ' +
			'escalates.'
	},
	'host-resource:cpu_saturated_critical': {
		title: 'CPU saturated severely',
		advice:
			'1-min load average is {load1} on {cores} cores (ratio {ratio}, ' +
			'threshold {threshold}x cores). The system is severely overcommitted ' +
			'— requests will time out, healthchecks may fail. Check `top` for the ' +
			'runaway process and consider killing or throttling it.'
	},
	'host-resource:cpu_saturated_warn': {
		title: 'CPU saturated',
		advice:
			'1-min load average is {load1} on {cores} cores (ratio {ratio}, ' +
			'threshold {threshold}x cores). System is under heavy load; ' +
			'responsiveness will be affected. Identify the culprit with `top`.'
	},
	'host-resource:cpu_saturated_info': {
		title: 'CPU load elevated',
		advice:
			'1-min load average is {load1} on {cores} cores (ratio {ratio}, ' +
			'threshold {threshold}x cores). Bundled into the daily digest.'
	},

	// ─── cp11 smartctl sidecar ─────────────────────────────────
	'smartctl:smart_failed': {
		title: 'Disk SMART self-assessment FAILED: {device}',
		advice:
			'{device} reports SMART overall-health FAILED. This means the drive ' +
			'firmware itself predicts imminent failure. Back up any data on this ' +
			'drive NOW and plan immediate replacement. Run `sudo smartctl -a ' +
			'{device}` for full attribute detail.'
	},
	'smartctl:self_test_failed': {
		title: 'Disk SMART self-test failed: {device}',
		advice:
			'Most recent self-test on {device} reported: {result}. The drive is ' +
			'still functional but a SMART self-test failure is a strong predictor ' +
			'of future failure. Back up data and schedule replacement.'
	},
	'smartctl:temperature_critical': {
		title: 'Disk temperature critical: {device}',
		advice:
			'{device} is at {temperature_c}°C (threshold {threshold}°C). ' +
			'Sustained high temperature shortens disk lifespan dramatically. ' +
			'Check chassis airflow, fan operation, and ambient temperature. ' +
			'If this persists, the drive WILL fail prematurely.'
	},
	'smartctl:temperature_warn': {
		title: 'Disk temperature elevated: {device}',
		advice:
			'{device} is at {temperature_c}°C (threshold {threshold}°C). Not ' +
			'immediately dangerous but worth checking airflow. Rate-limited to ' +
			'one per hour per device.'
	},
	'smartctl:reallocated_sectors': {
		title: 'Disk has reallocated sectors: {device}',
		advice:
			'{device} reallocated_sector_count = {count}. The drive remapped {count} ' +
			'bad sectors to spare ones. A few is normal over the life of the drive; ' +
			'rapidly increasing count means the drive is failing. Check the trend ' +
			'with `sudo smartctl -A {device}` and compare to prior alerts.'
	},
	'smartctl:pending_sectors': {
		title: 'Disk has pending unreadable sectors: {device}',
		advice:
			'{device} current_pending_sector = {count}. {count} sector(s) have read ' +
			'errors but have not yet been reallocated. They may recover on the next ' +
			'successful write, or they may be permanently bad. Run a long self-test ' +
			'(`sudo smartctl -t long {device}`) to force resolution.'
	},
	'smartctl:smartctl_unavailable': {
		title: 'smartctl sidecar enabled but smartmontools not installed',
		advice:
			'The morphit-smartctl-monitor service is running but smartctl is not in ' +
			'PATH. {hint}. Until then, no disk-health monitoring will happen.'
	},

	// ─── cp11 fail2ban sidecar ─────────────────────────────────
	'fail2ban:daemon_unreachable': {
		title: 'fail2ban daemon is not responding',
		advice:
			'fail2ban-client could not reach the fail2ban daemon. Error: {error}. ' +
			'{hint}. Until you fix this, no IPs are being banned — attackers ' +
			'attempting brute-force will not be rate-limited at the firewall layer.'
	},
	'fail2ban:jail_critical_ban_count': {
		title: 'fail2ban jail has many active bans: {jail}',
		advice:
			'{jail} has {currently_banned} currently-banned IPs (threshold ' +
			'{threshold}). This usually means an active distributed attack. ' +
			'fail2ban is doing its job — but the noise level is high. Check ' +
			'`sudo fail2ban-client status {jail}` for the IP list and ' +
			'`sudo journalctl -u fail2ban --since "1 hour ago"` for context. ' +
			'Consider tighter jail settings (longer bantime, lower findtime) if ' +
			'persistent.'
	},
	'fail2ban:jail_high_ban_count': {
		title: 'fail2ban jail ban count elevated: {jail}',
		advice:
			'{jail} has {currently_banned} currently-banned IPs (threshold ' +
			'{threshold}). Some active probing — fail2ban is handling it. Rate-' +
			'limited to one alert per hour per jail.'
	},
	'fail2ban:jail_ban_rate_warn': {
		title: 'fail2ban jail ban rate spiking: {jail}',
		advice:
			'{jail} banned ~{bans_per_hour} IPs/hour ({delta} new bans in the last ' +
			'{elapsed_sec}s). A sudden spike usually signals a distributed attack ' +
			'starting up. Check the source pattern with `sudo fail2ban-client ' +
			'status {jail}`.'
	},
	'fail2ban:fail2ban_unavailable': {
		title: 'fail2ban sidecar enabled but fail2ban not installed',
		advice:
			'The morphit-fail2ban-monitor service is running but fail2ban-client is ' +
			'not in PATH. {hint}. Until then, no fail2ban monitoring will happen — ' +
			'and if you have not installed fail2ban itself, your SSH and web ' +
			'surfaces are NOT being protected against brute-force.'
	},

	// ─── cp11 mdadm sidecar ────────────────────────────────────
	'mdadm:array_failed': {
		title: 'RAID array FAILED: {array}',
		advice:
			'{array} ({level}) is no longer functional — state {state}. ALL devices ' +
			'in the array are gone or failed. Any data on this array is at risk of ' +
			'permanent loss right now. Stop writes immediately, mount the surviving ' +
			'partition read-only if possible, and replace failed disks. ' +
			'See `cat /proc/mdstat` for the current state.'
	},
	'mdadm:array_degraded': {
		title: 'RAID array degraded: {array}',
		advice:
			'{array} ({level}) is degraded — state {state}. One or more devices ' +
			'failed or are missing. The array is still functional but redundancy ' +
			'is lost or reduced; another device failure could cause complete data ' +
			'loss. Replace failed disks ASAP and rebuild: `sudo mdadm --manage ' +
			'{array} --add /dev/<replacement>`.'
	},
	'mdadm:array_resyncing': {
		title: 'RAID array resyncing: {array}',
		advice:
			'{array} ({level}) is currently rebuilding or resyncing. This is normal ' +
			'after disk replacement or unclean shutdown. Performance will be ' +
			'reduced until complete. Check progress with `cat /proc/mdstat`.'
	},

	// ─── cp12 dmesg sidecar ────────────────────────────────────
	'dmesg:oom_kill': {
		title: 'OOM-killer activated — process killed: {victim_proc}',
		advice:
			'The kernel ran out of memory and killed process {victim_proc} ' +
			'(pid {victim_pid}) to free RAM. Your service may be the next victim. ' +
			'Check what is using memory: `ps aux --sort=-%mem | head -10`. ' +
			'Long-term: add swap or RAM, restart heavy services, or ' +
			'temporarily disable features. Raw kernel line: {raw_line}'
	},
	'dmesg:kernel_oops': {
		title: 'Kernel oops detected',
		advice:
			'The kernel hit an internal error (oops). The system is still ' +
			'running but is in a degraded state — schedule a reboot at the ' +
			'next maintenance window. If oopses repeat, the hardware may be ' +
			'failing. Run `sudo dmesg | grep -A 30 -i oops` for full stack. ' +
			'Raw line: {raw_line}'
	},
	'dmesg:kernel_panic': {
		title: 'Kernel panic detected',
		advice:
			'The kernel panicked. The host is likely unstable and may need an ' +
			'immediate reboot. Capture `sudo dmesg --ctime` output before ' +
			'rebooting so you can diagnose the root cause. Common causes: ' +
			'hardware failure, faulty driver, memory corruption. Raw line: {raw_line}'
	},
	'dmesg:hardware_error': {
		title: 'Hardware error reported by kernel',
		advice:
			'The kernel reported a hardware-level error (MCE, EDAC, ATA bus, ' +
			'or I/O error). This usually means failing RAM, CPU, or storage. ' +
			'Run `sudo dmesg | grep -i -E "mce|edac|ata|io error"` for context. ' +
			'For RAM specifically: `sudo edac-util -v`. Plan replacement now ' +
			'before unrecoverable failure. Raw line: {raw_line}'
	},
	'dmesg:segfault_in_morphit': {
		title: 'A morphit service segfaulted',
		advice:
			'A morphit-related process crashed with a segmentation fault. ' +
			'The systemd unit will likely restart it, but the crash itself is ' +
			'a bug worth investigating. Check `sudo journalctl --since "10 min ' +
			'ago" --priority=err` for the immediately-preceding errors. File an ' +
			'issue at git.agorise.net/agorise/morphit with the raw line. Raw: {raw_line}'
	},
	'dmesg:segfault_other': {
		title: 'A non-morphit process segfaulted',
		advice:
			'A process other than morphit segfaulted. Not directly your concern ' +
			'unless the same binary segfaults repeatedly (then suspect failing ' +
			'RAM). Raw line: {raw_line}'
	},
	'dmesg:fd_exhausted': {
		title: 'File-descriptor or PID exhaustion detected',
		advice:
			'The kernel could not allocate a new file descriptor or PID for ' +
			'a process. This usually means a runaway service is leaking. ' +
			'Check `lsof | wc -l` against `cat /proc/sys/fs/file-max`, and ' +
			'`ps ax | wc -l` against `cat /proc/sys/kernel/pid_max`. Identify ' +
			'the leaking process with `lsof | awk \'{print $2}\' | sort | uniq -c | sort -rn | head`. ' +
			'Raw line: {raw_line}'
	},
	'dmesg:dmesg_unreadable': {
		title: 'dmesg sidecar enabled but kernel log unreadable',
		advice:
			'The morphit-dmesg-monitor service is running but cannot read dmesg. ' +
			'{hint}. Without this, kernel-log monitoring (OOM kills, kernel ' +
			'oops, hardware errors) is OFF.'
	},

	// ─── cp12 trivy sidecar ────────────────────────────────────
	'trivy:image_critical_vulns': {
		title: 'Docker image has CRITICAL CVEs: {image}',
		advice:
			'{image} has {critical_count} CRITICAL severity CVEs (and ' +
			'{high_count} HIGH). Pull the latest image tag if available — ' +
			'`docker pull {image}` then restart the container. If no patch ' +
			'is available, run `trivy image --severity CRITICAL {image}` for ' +
			'the specific CVE IDs and assess whether you are actually exposed ' +
			'(many CVEs in base images do not affect the way you use the ' +
			'container). Add CVEs you have triaged to a .trivyignore file to ' +
			'silence them.'
	},
	'trivy:image_high_vulns': {
		title: 'Docker image has many HIGH CVEs: {image}',
		advice:
			'{image} has {high_count} HIGH severity CVEs (threshold ' +
			'{threshold}). Not critical yet, but plan to pull a newer image ' +
			'when available. Run `trivy image --severity HIGH {image}` for ' +
			'the list.'
	},
	'trivy:image_scan_failed': {
		title: 'Could not scan Docker image: {image}',
		advice:
			'trivy returned no output for {image}. {hint}. Until you fix this, ' +
			'this image will not be vulnerability-scanned by the daily timer. ' +
			'Common cause: trivy could not pull its CVE DB (firewall blocks ' +
			'ghcr.io); see OPERATIONS.md §16 for the outbound allowlist.'
	},
	'trivy:image_scan_clean': {
		title: 'Docker image scan clean: {image}',
		advice:
			'{image}: {critical_count} CRITICAL, {high_count} HIGH CVEs ' +
			'(below thresholds). Bundled into the daily digest.'
	},
	'trivy:trivy_unavailable': {
		title: 'trivy sidecar enabled but trivy not installed',
		advice:
			'The morphit-trivy-monitor service is running but trivy is not in ' +
			'PATH. {hint}. Until then, no Docker image vulnerability scanning ' +
			'will happen.'
	},

	// ─── cp12 postfix sidecar ──────────────────────────────────
	'postfix:queue_critical': {
		title: 'Mail queue is stuck — operator alerting may be FAILING',
		advice:
			'Postfix queue has {queue_depth} messages and the oldest is ' +
			'{oldest_age_min} minutes old (thresholds: {queue_threshold} ' +
			'depth, {age_threshold_min} min age). If you use postfix as your ' +
			'alerting smarthost, your operator alerts are NOT being delivered ' +
			'right now. Check: (1) `sudo postqueue -p` for the queued mail, ' +
			'(2) `sudo journalctl -u postfix --since "1 hour ago"` for the ' +
			'failure reason (smarthost unreachable? TLS cert expired? ' +
			'auth failure? rate-limited?), (3) `sudo postfix flush` to retry ' +
			'after the fix.'
	},
	'postfix:queue_warn': {
		title: 'Mail queue building up',
		advice:
			'Postfix queue has {queue_depth} messages, oldest {oldest_age_min} ' +
			'min old (thresholds: {queue_threshold} / {age_threshold_min} min). ' +
			'Some queue depth is normal during smarthost hiccups; if it keeps ' +
			'growing the operator-alerts path is broken. Check ' +
			'`sudo journalctl -u postfix --since "30 min ago"` for retry errors.'
	},
	'postfix:queue_clean': {
		title: 'Mail queue clean',
		advice:
			'Postfix queue has {queue_depth} messages, oldest {oldest_age_min} ' +
			'min old. Normal operation. Bundled into the daily digest.'
	},
	'postfix:postfix_unavailable': {
		title: 'postfix sidecar enabled but postqueue not installed',
		advice:
			'The morphit-postfix-monitor service is running but postqueue is ' +
			'not in PATH. {hint}. Until you install postfix, your operator-' +
			'alerting smarthost setup may not work either.'
	},

	// ─── cp13 certbot sidecar ──────────────────────────────────
	'certbot:cert_expiry_critical': {
		title: 'TLS cert expires very soon: {cert}',
		advice:
			'{cert} has only {days_left} days until expiry (threshold ' +
			'{threshold_days} days). Last successful renewal was ' +
			'{last_renewal_success_age_days} days ago. Run `sudo certbot ' +
			'renew --force-renewal` to issue a new cert immediately. If that ' +
			'fails, see `sudo journalctl -u snap.certbot.renew` (or your ' +
			'certbot cron log) for the failure reason.'
	},
	'certbot:cert_expiry_warn': {
		title: 'TLS cert expires soon: {cert}',
		advice:
			'{cert} expires in {days_left} days (threshold {threshold_days} ' +
			'days). Last successful renewal {last_renewal_success_age_days} ' +
			'days ago. Normal certbot renewal should handle this; this WARN ' +
			'just makes sure you have weeks of headroom to act if it does not.'
	},
	'certbot:renewal_stalled': {
		title: 'TLS cert expiring AND renewal has been silently failing: {cert}',
		advice:
			'{cert} expires in {days_left} days AND certbot has not had a ' +
			'successful renewal in {last_renewal_success_age_days} days ' +
			'(stall threshold {stall_threshold_days} days). This is the ' +
			'killer pattern: renewal was working fine for months then ' +
			'silently broke (DNS change, port 80 firewall, ACME provider ' +
			'limits, rate-limit). Fix the renewal NOW — `sudo certbot renew ' +
			'--dry-run` first to see what is failing without burning ' +
			'attempts, then a real renewal.'
	},
	'certbot:certbot_unavailable': {
		title: 'certbot sidecar enabled but openssl or cert dir missing',
		advice:
			'The morphit-certbot-monitor service is running but cannot read ' +
			'TLS certs. {hint}. Until then, TLS expiry monitoring is OFF.'
	},

	// ─── cp13 apt sidecar ──────────────────────────────────────
	'apt:security_updates_critical': {
		title: '{security_updates} pending security updates',
		advice:
			'{security_updates} security updates are pending ({total_updates} ' +
			'total updates available), above the alert threshold of ' +
			'{threshold}. Apply with `sudo apt update && sudo apt upgrade ' +
			'-y` (or just `sudo unattended-upgrade` if you trust the ' +
			'unattended-upgrades daemon). Reboot if any updates affect the ' +
			'kernel — `sudo needrestart` will tell you which services to ' +
			'restart.'
	},
	'apt:security_updates_warn': {
		title: '{security_updates} pending security updates',
		advice:
			'{security_updates} security updates pending ({total_updates} ' +
			'total). Below CRITICAL threshold but worth applying soon. ' +
			'`sudo apt update && sudo apt upgrade -y`.'
	},
	'apt:updates_pending_info': {
		title: '{total_updates} non-security updates pending',
		advice:
			'{total_updates} updates available, no security updates among ' +
			'them. Bundled into the daily digest.'
	},
	'apt:apt_unavailable': {
		title: 'apt sidecar enabled but apt not in PATH',
		advice:
			'The morphit-apt-monitor service is running but apt is missing. ' +
			'{hint}. This sidecar is Debian/Ubuntu-only; disable the timer ' +
			'on non-apt systems.'
	},

	// ─── cp13 compose sidecar ──────────────────────────────────
	'compose:service_unhealthy': {
		title: 'Docker Compose service unhealthy: {service}',
		advice:
			'{service} (state={state}, health={health}, restart_count=' +
			'{restart_count}) in project {project_dir} reports unhealthy. ' +
			'The container is running but its health-check is failing. ' +
			'Check container logs: `cd {project_dir} && docker compose logs ' +
			'--tail=100 {service}`. Common causes: backend service it ' +
			'connects to is down, config file unreadable, port-bind ' +
			'collision.'
	},
	'compose:service_exited': {
		title: 'Docker Compose service has exited: {service}',
		advice:
			'{service} in {project_dir} is in state={state} (not running). ' +
			'The container stopped unexpectedly and did not restart, or its ' +
			'restart policy is "no". Check `docker compose logs --tail=200 ' +
			'{service}` for the exit reason and `docker compose up -d ' +
			'{service}` to restart it.'
	},
	'compose:service_restart_loop': {
		title: 'Docker Compose service in restart loop: {service}',
		advice:
			'{service} has restart_count={restart_count} (threshold for ' +
			'alert). The service keeps crashing and restarting — its ' +
			'restart policy is masking a real bug. Check container logs to ' +
			'find why it crashes, fix the root cause, then `docker compose ' +
			'up -d --force-recreate {service}` to reset the restart count.'
	},
	'compose:docker_unavailable': {
		title: 'compose sidecar enabled but Docker / Compose missing',
		advice:
			'The morphit-compose-monitor service is running but Docker or ' +
			'the Compose v2 plugin is not installed. {hint}. Disable the ' +
			'timer if you do not use Docker at all.'
	},

	// ─── cp14 systemd sidecar ──────────────────────────────────
	'systemd:unit_failed': {
		title: 'systemd unit FAILED: {unit}',
		advice:
			'{unit} is in failed state (sub_state={sub_state}, ' +
			'result={result}). The service is down — restart attempts hit ' +
			'the start-limit burst, or the unit explicitly entered failed ' +
			'state. journalctl-based alerting cannot see this because the ' +
			'unit isnt running to emit anything. Check: ' +
			'`sudo systemctl status {unit}` for the failure context, ' +
			'`sudo journalctl -u {unit} --since "30 min ago"` for the ' +
			'crash logs, `sudo systemctl reset-failed {unit}` then ' +
			'`sudo systemctl start {unit}` after fixing the root cause.'
	},
	'systemd:unit_restart_loop': {
		title: 'systemd unit in restart loop: {unit}',
		advice:
			'{unit} has NRestarts={n_restarts} (threshold {threshold}). ' +
			'It is currently {active_state} but its restart policy is ' +
			'masking a bug that keeps crashing it. Check ' +
			'`sudo journalctl -u {unit} --since "1 hour ago"` for the crash ' +
			'pattern, fix the underlying issue, then ' +
			'`sudo systemctl reset-failed {unit}` to clear the counter.'
	},
	'systemd:unit_missing': {
		title: 'configured-to-watch systemd unit not found: {unit}',
		advice:
			'{unit} is in MORPHIT_SYSTEMD_WATCH but does not exist on this ' +
			'host. Either remove the unit from the watch list or install ' +
			'the missing unit file. (This is a config drift signal — ' +
			'someone removed the unit but forgot to update the monitor.)'
	},
	'systemd:systemctl_unavailable': {
		title: 'systemd sidecar enabled but systemctl missing',
		advice:
			'The morphit-systemd-monitor service is running but systemctl is ' +
			'not in PATH. {hint}. Disable the timer if this host does not ' +
			'use systemd.'
	},

	// ─── cp14 journald sidecar ─────────────────────────────────
	'journald:journal_size_critical': {
		title: 'Journal disk usage critical: {size_mb} MB',
		advice:
			'journald is using {size_mb} MB of disk for log storage ' +
			'(threshold {threshold_mb} MB). The journal covers ' +
			'{span_days} days. Rotation is likely misconfigured — without ' +
			'a SystemMaxUse limit in /etc/systemd/journald.conf, the journal ' +
			'will eventually fill the disk. Set `SystemMaxUse=1G` (or your ' +
			'preferred cap) in /etc/systemd/journald.conf, then ' +
			'`sudo systemctl restart systemd-journald` and ' +
			'`sudo journalctl --vacuum-size=1G` to reclaim space immediately.'
	},
	'journald:journal_size_warn': {
		title: 'Journal disk usage growing: {size_mb} MB',
		advice:
			'journald is using {size_mb} MB across {span_days} days of ' +
			'log history (threshold {threshold_mb} MB). Not critical yet, ' +
			'but consider setting `SystemMaxUse=` in ' +
			'/etc/systemd/journald.conf to bound future growth. ' +
			'`sudo journalctl --vacuum-time=30d` reclaims old entries now.'
	},
	'journald:journal_rotation_stale': {
		title: 'Journal covers {span_days} days — rotation may be off',
		advice:
			'The journal covers {span_days} days at {size_mb} MB (' +
			'thresholds {threshold_days} days + {threshold_min_mb} MB). ' +
			'Long span with moderate size suggests rotation policy is ' +
			'looser than typical. Verify `SystemMaxFiles=`, ' +
			'`MaxRetentionSec=`, and `MaxFileSec=` in ' +
			'/etc/systemd/journald.conf match your retention needs.'
	},
	'journald:journalctl_unavailable': {
		title: 'journald sidecar enabled but journalctl missing',
		advice:
			'The morphit-journald-monitor service is running but journalctl ' +
			'is not in PATH. {hint}. Disable the timer if this host does ' +
			'not use systemd-journald.'
	}
};

const TIER_COLOR: Record<AlertTier, string> = {
	CRITICAL: '#dc2626',
	WARN: '#d97706',
	INFO: '#6b7280'
};

const TIER_EMOJI: Record<AlertTier, string> = {
	CRITICAL: '🚨',
	WARN: '⚠️',
	INFO: 'ℹ️'
};

/** Substitute {placeholder} tokens from `payload`.  Missing keys
 *  render as `<unknown>` so the operator sees something legible
 *  rather than the literal `{key}` text — that situation usually
 *  means the emitter changed shape and the bot needs a bump. */
function substitute(template: string, payload: Record<string, unknown> | undefined): string {
	return template.replace(/\{([a-z_]+)\}/gi, (_match, key: string) => {
		if (!payload) return '<unknown>';
		const v = payload[key];
		if (v === undefined || v === null) return '<unknown>';
		return typeof v === 'string' ? v : JSON.stringify(v);
	});
}

export function renderAlertBody(c: ClassifiedAlert): { plain: string; html: string } {
	const { tier, alert } = c;
	const sigil = TIER_EMOJI[tier];
	const color = TIER_COLOR[tier];
	const key = `${alert.module}:${alert.event}`;
	const copy = ALERT_COPY[key];

	const title = copy ? substitute(copy.title, alert.payload) : `${alert.module} :: ${alert.event}`;
	const advice = copy
		? substitute(copy.advice, alert.payload)
		: 'No specific guidance for this alert kind. Raw payload follows.';

	const payloadLines = alert.payload
		? Object.entries(alert.payload)
				.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
				.join('\n')
		: '';

	const plainParts = [`${sigil} [${tier}] ${title}`, '', advice];
	if (payloadLines) {
		plainParts.push('', 'Details:', payloadLines);
	}
	plainParts.push('', `Source: ${alert.source ?? '(unknown)'}`, `Time: ${alert.ts}`);
	const plain = plainParts.join('\n');

	const escAdvice = escapeHtml(advice);
	const escTitle = escapeHtml(title);
	const escSource = escapeHtml(alert.source ?? '(unknown)');
	const escTs = escapeHtml(alert.ts);
	const htmlParts: string[] = [];
	htmlParts.push(
		`${sigil} <font color="${color}"><strong>[${tier}]</strong></font> <strong>${escTitle}</strong>`
	);
	htmlParts.push(`<p>${escAdvice}</p>`);
	if (payloadLines) {
		htmlParts.push(
			`<p><strong>Details:</strong></p><pre><code>${escapeHtml(payloadLines)}</code></pre>`
		);
	}
	htmlParts.push(
		`<p><small>Source: <code>${escSource}</code> &middot; Time: <code>${escTs}</code></small></p>`
	);
	const html = htmlParts.join('');

	return { plain, html };
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
