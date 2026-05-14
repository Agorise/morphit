/**
 * Alert classifier — assigns each incoming structured-JSON alert
 * a tier (CRITICAL / WARN / INFO) that determines:
 *
 *   - CRITICAL: deliver immediately, NO rate limit, NO aggregation
 *   - WARN: rate-limited (1/hour per category), DM individually
 *   - INFO: aggregated into a daily digest, sent once at 09:00 UTC
 *
 * The tier mapping is the canonical alert policy.  Changing it
 * here changes what operators wake up for at 3 AM — be deliberate.
 *
 * Design references:
 *   - OPERATIONS.md §16 (operator-balance alerts) — the existing
 *     emit site that the bot consumes via journalctl tail.
 *   - OPERATIONS.md §37.6 + §37.9 + §31 — auditd, AIDE, backup
 *     alerts that the bot will also classify when wired.
 *   - cp9 design discussion: 3 tiers chosen to prevent alert
 *     fatigue (the "ignored alerts" failure mode) while still
 *     surfacing the events an operator needs immediately.
 */

/** Tier — the spam-vs-urgency policy lever. */
export type AlertTier = 'CRITICAL' | 'WARN' | 'INFO';

/** A structured alert payload, as emitted by the indexer / relay /
 *  host services and read off journalctl by the bot.  We use a
 *  permissive shape because emitters across the codebase don't
 *  share a strict envelope — instead we extract the fields we
 *  care about and ignore the rest. */
export interface StructuredAlert {
	/** Logger module name (e.g. "operator-balance", "tamper",
	 *  "kill-switch", "auditd", "aide", "backup").  This is the
	 *  primary classification key. */
	readonly module: string;
	/** Alert kind within the module (e.g. "LOW_BALANCE",
	 *  "RECOVERED", "SUSTAINED_RPC_FAILURE", "BUNDLE_HASH_MISMATCH").
	 *  Secondary key — different kinds within the same module can
	 *  have different tiers. */
	readonly kind: string;
	/** Free-form context payload — the alert's specifics (current
	 *  balance, threshold, account, etc.).  Surfaced verbatim in
	 *  the rendered Matrix message. */
	readonly payload?: Record<string, unknown>;
	/** Source service that emitted the alert.  Useful when one
	 *  bot watches multiple systemd units. */
	readonly source?: string;
	/** Wall-clock timestamp of the alert (UTC ISO 8601).  The bot
	 *  uses this for rate-limit windows + digest ordering. */
	readonly ts: string;
}

/** Category key for rate limiting — WARN tier alerts of the same
 *  category coalesce within a sliding window.  Format:
 *  `<module>:<kind>`. */
export type AlertCategory = string;

/** Result of classification: the tier + a stable category key the
 *  rate limiter / digest uses to deduplicate. */
export interface ClassifiedAlert {
	readonly tier: AlertTier;
	readonly category: AlertCategory;
	readonly alert: StructuredAlert;
}

/** The tier policy.  Edit deliberately — this controls what wakes
 *  the operator at 3 AM.  Three rules in priority order: CRITICAL
 *  matches first, WARN second, everything else is INFO. */
const CRITICAL_MATCHERS: ReadonlyArray<(a: StructuredAlert) => boolean> = [
	// TamperAlertBanner trigger — bundle hash mismatch or
	// pubkey rotation we didn't authorize.  Memory: the user
	// CANNOT trust what's running.
	(a) => a.module === 'tamper' && a.kind === 'BUNDLE_HASH_MISMATCH',
	(a) => a.module === 'tamper' && a.kind === 'PUBKEY_MISMATCH',
	(a) => a.module === 'tamper' && a.kind === 'INVALID_PAYLOAD',

	// Kill-switch fired (manual or auto).  Operators need to
	// know signups stopped immediately.
	(a) => a.module === 'kill-switch' && a.kind === 'FIRED',

	// Sustained RPC failure — alerting itself is blind, so we
	// can't afford to delay this one.
	(a) => a.module === 'operator-balance' && a.kind === 'SUSTAINED_RPC_FAILURE',
	(a) => a.module === 'witness-fee' && a.kind === 'SUSTAINED_RPC_FAILURE',

	// Daily signup ceiling hit — strong signal of active attack.
	(a) => a.module === 'signup-ceiling' && a.kind === 'ceiling_reached',

	// fee_method enum violation attempt — Memory #23 invariant,
	// someone tried to use USDT for listing fees.  DB CHECK
	// constraint blocks it but the attempt itself is forensically
	// interesting.
	(a) => a.module === 'fee-verifier' && a.kind === 'INVALID_FEE_METHOD',

	// Backup failure — systemd OnFailure on morphit-backup.service.
	(a) => a.module === 'backup' && a.kind === 'FAILED',

	// AIDE detected modified system files.
	(a) => a.module === 'aide' && a.kind === 'INTEGRITY_VIOLATION',

	// Operator account drained past threshold (LOW_BALANCE itself
	// is WARN, but crossing 0 BLURT is CRITICAL — the relay will
	// stop processing welcome bonuses).
	(a) =>
		a.module === 'operator-balance' &&
		a.kind === 'LOW_BALANCE' &&
		typeof a.payload?.['current_blurt'] === 'number' &&
		(a.payload['current_blurt'] as number) <= 0
];

const WARN_MATCHERS: ReadonlyArray<(a: StructuredAlert) => boolean> = [
	// LOW_BALANCE crossing — operator should top up, not on fire.
	// (Already filtered above: zero-or-below is CRITICAL.)
	(a) => a.module === 'operator-balance' && a.kind === 'LOW_BALANCE',

	// Witness fee changed — operator should re-tune
	// MORPHIT_RELAY_ACCOUNT_CREATION_FEE_BLURT to match.
	(a) => a.module === 'witness-fee' && a.kind === 'CHANGED',

	// Stale BLURT/USD price feed — fee echoes will be off, but
	// fee verification itself doesn't depend on USD.
	(a) => a.module === 'price-feed' && a.kind === 'STALE',

	// Single-IP signup spike (Layer 6 anomaly detector) below
	// daily ceiling.  Worth noticing; not yet a ceiling event.
	(a) => a.module === 'signup-anomaly' && a.kind === 'SINGLE_IP_SPIKE',

	// Federation peer marked down >24h.  Useful situational
	// awareness; not emergency.
	(a) => a.module === 'federation-probe' && a.kind === 'PEER_DOWN_24H',

	// Sequential signup pattern detected (Layer 8 detector).
	// Each individual signup was already rate-limited; this is
	// just operator-facing visibility.
	(a) => a.module === 'sequential-detector' && a.kind === 'PATTERN_DETECTED'
];

/** Classify a structured alert into a tier + category.  Pure
 *  function; fully testable.  The tier-policy logic is locked in
 *  here, not spread across emitters. */
export function classify(alert: StructuredAlert): ClassifiedAlert {
	const category: AlertCategory = `${alert.module}:${alert.kind}`;

	for (const match of CRITICAL_MATCHERS) {
		if (match(alert)) {
			return { tier: 'CRITICAL', category, alert };
		}
	}
	for (const match of WARN_MATCHERS) {
		if (match(alert)) {
			return { tier: 'WARN', category, alert };
		}
	}
	// Everything else (RECOVERED, normal backups, federation
	// discovery summaries, etc.) goes to the daily digest.
	return { tier: 'INFO', category, alert };
}

/** Friendly copy for each known alert kind.  Pulled out of the
 *  renderer as a data table so adding/tuning alert text is just
 *  a data change.  Each entry has:
 *
 *    title   — one-line human headline (no severity prefix —
 *              that's added by the renderer based on tier)
 *    advice  — ELI5 explanation of what just happened + what to
 *              do.  Plain prose, ~1-3 sentences.  Can use
 *              {placeholder} tokens that get substituted with
 *              payload values at render time.
 *
 *  Unknown (module, kind) pairs fall through to a generic
 *  renderer that surfaces the raw JSON payload.  That's intended
 *  — operator gets the data, just without friendly framing.
 */
interface AlertCopyEntry {
	readonly title: string;
	readonly advice: string;
}

const ALERT_COPY: Record<string, AlertCopyEntry> = {
	// ─── CRITICAL ─────────────────────────────────────────────
	'tamper:BUNDLE_HASH_MISMATCH': {
		title: 'Frontend code does not match the on-chain signed release',
		advice:
			'Users visiting your instance right now may be running modified code. ' +
			'Check your web server + CDN. If you did not deploy a hot-fix yourself, ' +
			'this could be a compromise. See OPERATIONS.md §37.10.1 for response steps.'
	},
	'tamper:PUBKEY_MISMATCH': {
		title: 'Release-signing pubkey does not match expected',
		advice:
			'The pubkey signing your release ops is not the one this instance ' +
			'expects. Either you rotated the release pubkey and forgot to redeploy ' +
			'the frontend, OR the chain account that signs releases has been ' +
			'compromised. Check apps/web/src/lib/release/ for the expected pubkey.'
	},
	'tamper:INVALID_PAYLOAD': {
		title: 'Release op carries an invalid payload',
		advice:
			'The frontend tamper-detector found a release op on chain whose payload ' +
			'is structurally invalid (missing fields, bad shape). Either an attacker ' +
			'is broadcasting fake release ops with your account, or you accidentally ' +
			'broadcast a malformed one. Check recent ops on the release-signer account.'
	},
	'kill-switch:FIRED': {
		title: 'Kill-switch fired — signups halted',
		advice:
			'Account creation is currently halted on your instance. ' +
			'reason={reason}: "manual" means you or a co-operator deliberately stopped ' +
			'signups; "auto" means an attack threshold was hit. Existing users are ' +
			'unaffected. No new accounts will be created until you re-enable signups ' +
			'via MORPHIT_RELAY_SIGNUP_ENABLED=true.'
	},
	'operator-balance:SUSTAINED_RPC_FAILURE': {
		title: 'Indexer cannot reach Blurt chain — alerting is BLIND',
		advice:
			'The indexer failed {consecutive} consecutive balance checks. You would ' +
			'not know right now if your operator account got drained. Check: ' +
			'(1) internet connectivity, (2) MORPHIT_INDEXER_RPC_ENDPOINTS, ' +
			'(3) try `curl <one-of-your-rpc-endpoints>/health`. If your network is ' +
			'fine, the Blurt chain itself may have stalled.'
	},
	'witness-fee:SUSTAINED_RPC_FAILURE': {
		title: 'Witness fee poller cannot reach Blurt chain',
		advice:
			'The poller failed multiple consecutive checks. Your relay is using its ' +
			'fallback MORPHIT_RELAY_ACCOUNT_CREATION_FEE_BLURT — if witnesses raised ' +
			'the fee in the meantime, your relay will start refusing signups (fee ' +
			'mismatch). Same fix as the indexer-RPC alert: check network + endpoints.'
	},
	'signup-ceiling:ceiling_reached': {
		title: 'Daily signup ceiling hit — likely under attack',
		advice:
			'Your instance hit {count}/{ceiling} signups today and will refuse more ' +
			'until midnight UTC. This usually means an active attack. Check ' +
			'`journalctl -u morphit-relay --since "1 hour ago" | grep signup` for the ' +
			'source IPs and patterns. Consider: lowering the ceiling temporarily, ' +
			'toggling MORPHIT_RELAY_SIGNUP_ENABLED=false, or following the squatter ' +
			'response playbook in OPERATIONS.md §38.'
	},
	'fee-verifier:INVALID_FEE_METHOD': {
		title: 'Someone attempted to pay a listing fee in a disallowed asset',
		advice:
			'A user (or attacker) tried to pay a listing fee using "{attempted}". ' +
			'The Morphit invariant (BLURT/BTC/XMR only for listing fees) blocked it ' +
			'at the database CHECK constraint. The order was rejected. This is ' +
			'forensically interesting — could be a buggy client, a probing attacker, ' +
			'or a frontend bug. Grep journalctl for the full context.'
	},
	'backup:FAILED': {
		title: 'Backup did not complete',
		advice:
			'morphit-backup.service failed. reason={reason}. Every hour without ' +
			'backups is potential data loss. Check: (1) disk space (`df -h`), ' +
			'(2) backup destination reachability, (3) `journalctl -u morphit-backup ' +
			'--since "1 hour ago"` for the actual error.'
	},
	'aide:INTEGRITY_VIOLATION': {
		title: 'System files modified without authorization',
		advice:
			'AIDE detected {changed} unauthorized changes to monitored system files. ' +
			'Could be legitimate (you applied a system update) or a compromise. Run ' +
			'`sudo journalctl -t aide` for the list of changed files. If you did not ' +
			'expect changes, treat this as a potential breach — OPERATIONS.md §37.9 ' +
			'has the response procedure.'
	},

	// ─── WARN ─────────────────────────────────────────────────
	'operator-balance:LOW_BALANCE': {
		// Note: classifier sends LOW_BALANCE at zero or negative to
		// CRITICAL.  This copy is for the positive-but-below-threshold
		// case (WARN).  Renderer chooses tier-appropriate phrasing
		// based on the classified tier.
		title: 'Operator account low: @{account}',
		advice:
			'@{account} ({role}) is at {current_blurt} BLURT, below your alert ' +
			'threshold of {threshold_blurt}. Not broken yet, but burn rate matters. ' +
			'Top up before it hits zero. Future LOW_BALANCE alerts for this account ' +
			'are rate-limited to one per hour to avoid spam.'
	},
	'witness-fee:CHANGED': {
		title: 'Blurt witnesses changed the chain account-creation fee',
		advice:
			'The chain fee went from {old} → {new} BLURT. Update ' +
			'MORPHIT_RELAY_ACCOUNT_CREATION_FEE_BLURT in /etc/morphit/relay.env to ' +
			'{new} and restart the relay, otherwise your relay may either over-pay ' +
			'(old fallback higher) or refuse signups (sanity check refuses new value ' +
			'as too high).'
	},
	'price-feed:STALE': {
		title: 'BLURT/USD price feed has not updated',
		advice:
			'The feed is {last_update_age_min} min old. Fee verification is unaffected — ' +
			'Morphit verifies fees in native BLURT, not USD. But USD echoes on the ' +
			'frontend will be off until the feed recovers. Usually self-heals once ' +
			'CoinGecko/Klingex responds.'
	},
	'signup-anomaly:SINGLE_IP_SPIKE': {
		title: 'Signup spike from a single IP',
		advice:
			'IP {ip} made {count} signup attempts within the detection window. ' +
			'Your existing rate limits already blocked most of these — this alert is ' +
			'for situational awareness. If repeat spikes from the same IP persist, ' +
			'consider banning it via ufw or the BunkerWeb BLACKLIST_IP list.'
	},
	'federation-probe:PEER_DOWN_24H': {
		title: 'Federation peer offline for over 24 hours',
		advice:
			'{peer} has not responded to /v1/health for >24h. Their orders will not ' +
			'appear in your orderbook view, and yours will not appear in theirs. ' +
			'Most likely the operator is offline, migrating, or on vacation. ' +
			'Auto-recovers when they come back.'
	},
	'sequential-detector:PATTERN_DETECTED': {
		title: 'Sequential signup pattern detected',
		advice:
			'{count} signups in a row used the prefix "{prefix}" (e.g. {prefix}01, ' +
			'{prefix}02). The Layer 8 sequential detector already rejected these — no ' +
			'ACTs consumed. This is situational awareness about the attack shape. ' +
			'If persistent, see OPERATIONS.md §38.6 for tightening squatter defenses.'
	},

	// ─── INFO (daily digest items) ────────────────────────────
	'operator-balance:RECOVERED': {
		title: 'Operator account recovered above threshold',
		advice:
			'@{account} ({role}) is back to {current_blurt} BLURT, above the alert ' +
			'threshold. Your earlier top-up landed cleanly.'
	},
	'backup:SUCCEEDED': {
		title: 'Backup completed',
		advice: 'Wrote {size_mb} MB. Normal operation.'
	},
	'federation-probe:DISCOVERED': {
		title: 'New federation peer discovered',
		advice: '{peer} is now visible in the federation directory. No action needed.'
	}
};

const TIER_COLOR: Record<AlertTier, string> = {
	CRITICAL: '#dc2626', // red-600 (Tailwind)
	WARN: '#d97706', // amber-600
	INFO: '#6b7280' // gray-500
};

const TIER_EMOJI: Record<AlertTier, string> = {
	CRITICAL: '🚨',
	WARN: '⚠️',
	INFO: 'ℹ️'
};

/** Substitute {placeholder} tokens in `template` from `payload`. */
function substitute(template: string, payload: Record<string, unknown> | undefined): string {
	if (!payload) return template;
	return template.replace(/\{([a-z_]+)\}/gi, (match, key: string) => {
		const v = payload[key];
		if (v === undefined || v === null) return match;
		return typeof v === 'string' ? v : JSON.stringify(v);
	});
}

/** Render a classified alert as a Matrix message body (plain +
 *  HTML).  Uses ALERT_COPY for friendly per-(module, kind) framing;
 *  falls back to a generic JSON-payload renderer for unknown alert
 *  kinds.  Pure function; tested in isolation. */
export function renderAlertBody(c: ClassifiedAlert): { plain: string; html: string } {
	const { tier, alert } = c;
	const sigil = TIER_EMOJI[tier];
	const color = TIER_COLOR[tier];
	const key = `${alert.module}:${alert.kind}`;
	const copy = ALERT_COPY[key];

	const title = copy ? substitute(copy.title, alert.payload) : `${alert.module} :: ${alert.kind}`;
	const advice = copy
		? substitute(copy.advice, alert.payload)
		: 'No specific guidance for this alert kind. Raw payload follows.';

	// Format payload for the trailing details block.
	const payloadLines = alert.payload
		? Object.entries(alert.payload)
				.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
				.join('\n')
		: '';

	// Plain text body — readable in any Matrix client.
	const plainParts = [`${sigil} [${tier}] ${title}`, '', advice];
	if (payloadLines) {
		plainParts.push('', 'Details:', payloadLines);
	}
	plainParts.push('', `Source: ${alert.source ?? '(unknown)'}`, `Time: ${alert.ts}`);
	const plain = plainParts.join('\n');

	// HTML body — colored tier label, monospace payload.
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
		htmlParts.push(`<p><strong>Details:</strong></p><pre><code>${escapeHtml(payloadLines)}</code></pre>`);
	}
	htmlParts.push(`<p><small>Source: <code>${escSource}</code> &middot; Time: <code>${escTs}</code></small></p>`);
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
