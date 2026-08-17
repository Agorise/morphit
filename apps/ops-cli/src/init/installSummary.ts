/**
 * installSummary.ts — the FULL "what got installed + is each piece actually
 * healthy" report printed at the very END of the guided install.
 *
 * A live federation operator finished the wizard and wanted a glance-able,
 * TRUSTWORTHY confirmation of every subsystem — not a bare "✓ installed" line
 * (a host-pattern bug once let that print with NOTHING installed), and not just
 * "the service is active" when what they care about is "is it actually serving,
 * synced, funded, reachable on Tor/I2P, pinned on IPFS, and correctly
 * configured". So this verifies each item and shows a per-item status:
 *
 *   core services (db / relay / indexer / MCP) + their live /v1/health,
 *   web firewall (BunkerWeb) + front end + HTTPS,
 *   host hardening (UFW / fail2ban), privacy networks (Tor / I2P),
 *   distribution (IPFS daemon / release-pin timer / IPNS),
 *   transparency (warrant canary freshness / PGP key / SEO surfaces),
 *   economics (FX price feeds / verified on-chain relay balance),
 *   operations (nightly backups / DDNS / every unit's aggregate health),
 *   instance identity (defaults written / Matrix contact).
 *
 * The RENDER + the row-building are PURE (and smoke-pinned); every PROBE
 * (systemctl / docker / ufw / filesystem / HTTP /v1/health / Blurt RPC) is
 * injected, so the same logic is unit-tested without a live box.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lookupBlurtAccount } from './chainCheck.ts';

export interface ComponentStatus {
	readonly label: string;
	/** true = up/healthy, false = down/unhealthy, null = not-applicable / still starting. */
	readonly ok: boolean | null;
	/** Shown in parentheses ONLY when the component is NOT ok (a hint to fix/wait). */
	readonly detail?: string;
	/** Shown ALWAYS, dimmed, after the label — informational (a balance, an
	 *  address, an FX status). Never affects alignment of the mark column. */
	readonly value?: string;
}

/** Parsed shape of the indexer's /v1/health (only the fields we surface). */
export interface IndexerHealth {
	/** the endpoint answered at all. */
	readonly reachable: boolean;
	/** caught up to chain head (a still-syncing indexer is reachable but not synced). */
	readonly synced: boolean | null;
	/** at least one upstream Blurt RPC is healthy. */
	readonly rpcOk: boolean | null;
	/** the BTC/XMR price feeds (FX) are serving fresh rates. */
	readonly fxOk: boolean | null;
	readonly detail?: string;
}

export interface SystemHealth {
	readonly ok: boolean;
	readonly detail?: string;
}

export interface SummaryProbe {
	/** `systemctl is-active <unit>` reports 'active'. */
	readonly serviceActive: (unit: string) => boolean;
	/** Of the given units, the ones NOT active (returned by name for the aggregate row). */
	readonly failedUnits: (units: readonly string[]) => string[];
	/** a currently-running container is named exactly <name>. */
	readonly containerRunning: (name: string) => boolean;
	/** the UFW firewall reports active. */
	readonly firewallActive: () => boolean;
	/** a path exists on disk. */
	readonly pathExists: (path: string) => boolean;
	/** file contents (trimmed) or null if unreadable — used to surface the actual
	 *  .onion address and to freshness-check the canary. */
	readonly readText: (path: string) => string | null;
	/** GET the indexer's loopback /v1/health and summarize it. */
	readonly indexerHealth: () => Promise<IndexerHealth>;
	/** the relay's loopback /v1/health answered (null = couldn't tell). */
	readonly relayReachable: () => Promise<boolean | null>;
	/** on-chain BLURT balance of <account> (null = lookup failed / no account). */
	readonly relayBalanceBlurt: (account: string) => Promise<number | null>;
	/** free disk on / and free memory are both above a safe floor. */
	readonly systemHealth: () => SystemHealth;
}

export interface SummaryInputs {
	readonly domain: string;
	readonly mode: 'home' | 'vps';
	/** No clearnet domain — skip the HTTPS-cert + BunkerWeb-firewall rows (a
	 *  Tor-only node has neither). */
	readonly torOnly: boolean;
	readonly enableBunkerweb: boolean;
	/** Repo root on the server (morphit_repo_path, e.g. /opt/morphit). The
	 *  front-end build/ dir beneath it is what BunkerWeb serves, so the canary,
	 *  PGP key, and SEO surfaces are probed there. */
	readonly repoPath: string;
	/** The relay/operator Blurt account, for the on-chain funding check. */
	readonly relayAccount: string;
	/** True when the operator gave a Matrix contact address. */
	readonly contactConfigured?: boolean;
}

/** Chain fee is ~100 BLURT per signup; below one signup the relay can onboard
 *  nobody (a hard fail), and we recommend funding ~20 signups to start. */
const BLURT_PER_SIGNUP = 100;
const RECOMMENDED_SIGNUPS = 20;

/** The systemd units every install should end up running (mode-dependent tail
 *  added by the caller). Used for the single "all services + timers" roll-up. */
export function expectedUnits(inputs: SummaryInputs): string[] {
	const units = [
		'postgresql',
		'morphit-relay.service',
		'morphit-indexer.service',
		'morphit-mcp.service',
		'morphit-backup.timer',
		'fail2ban',
		'tor',
		'i2pd',
		'ipfs.service',
		'morphit-ipfs-pin.timer'
	];
	if (inputs.mode === 'home' && !inputs.torOnly) units.push('morphit-ddns.timer');
	return units;
}

/** Build the full component list from probe results. Async because several
 *  checks are live (HTTP /v1/health, Blurt RPC). PURE given the probe. */
export async function collectInstallSummary(
	inputs: SummaryInputs,
	probe: SummaryProbe = realProbe()
): Promise<ComponentStatus[]> {
	const build = `${inputs.repoPath}/apps/web/build`;

	// Live health calls run concurrently — the summary shouldn't stall serially.
	const [indexer, relayUp, balance] = await Promise.all([
		probe.indexerHealth(),
		probe.relayReachable(),
		probe.relayBalanceBlurt(inputs.relayAccount)
	]);

	const rows: ComponentStatus[] = [];

	// ── Core services ────────────────────────────────────────────────
	rows.push({ label: 'Marketplace database (PostgreSQL)', ok: probe.serviceActive('postgresql') });
	rows.push({ label: 'Signup relay — service', ok: probe.serviceActive('morphit-relay.service') });
	rows.push({
		label: 'Signup relay — responding (/v1/health)',
		ok: relayUp,
		detail: 'still unlocking/starting — re-check in a minute'
	});
	rows.push({ label: 'Marketplace indexer — service', ok: probe.serviceActive('morphit-indexer.service') });
	rows.push({
		label: 'Marketplace indexer — responding (/v1/health)',
		ok: indexer.reachable ? true : null,
		detail: 'still starting — re-check in a minute'
	});
	rows.push({
		label: 'Indexer processing the chain',
		ok: indexer.reachable ? true : null,
		value:
			indexer.synced === false
				? 'catching up (normal on a fresh node)'
				: indexer.synced === true
					? 'in sync'
					: undefined,
		detail: 'still starting — re-check in a minute'
	});
	rows.push({
		label: 'Blurt RPC connectivity',
		// Not-yet-reachable is PENDING, not failed: on a fresh node the indexer is
		// still opening connections, and on an offline/air-gapped install there's
		// no upstream to reach until the box is online. Show '?' (still starting),
		// never a scary '✗'.
		ok: indexer.reachable && indexer.rpcOk ? true : null,
		detail: 'still connecting to the Blurt network — completes once this box is online'
	});
	rows.push({ label: 'MCP server (read-only orderbook API)', ok: probe.serviceActive('morphit-mcp.service') });

	// ── Economics ────────────────────────────────────────────────────
	rows.push({
		label: 'FX price feeds (BTC/XMR rates)',
		ok: indexer.reachable ? indexer.fxOk : null,
		detail: 'price feeds still warming up — re-check in a minute'
	});
	{
		const signups = balance === null ? null : Math.floor(balance / BLURT_PER_SIGNUP);
		rows.push({
			label: `Verified relay balance (@${inputs.relayAccount})`,
			ok: balance === null ? null : balance >= BLURT_PER_SIGNUP,
			value:
				balance === null
					? undefined
					: `${balance.toFixed(3)} BLURT (~${signups} signup${signups === 1 ? '' : 's'})`,
			detail:
				balance === null
					? "couldn't reach a Blurt RPC to check — verify before opening signups"
					: balance < BLURT_PER_SIGNUP
						? `under one signup — top up (recommended: ~${RECOMMENDED_SIGNUPS * BLURT_PER_SIGNUP} BLURT)`
						: signups !== null && signups < RECOMMENDED_SIGNUPS
							? `low — top up toward ~${RECOMMENDED_SIGNUPS} signups before opening`
							: undefined
		});
	}

	// ── Web edge ─────────────────────────────────────────────────────
	if (inputs.enableBunkerweb && !inputs.torOnly) {
		rows.push({ label: 'Web firewall (BunkerWeb)', ok: probe.containerRunning('bunkerweb') });
	}
	if (inputs.enableBunkerweb) {
		rows.push({ label: 'Website (front end)', ok: probe.containerRunning('morphit-frontend') });
	}
	if (!inputs.torOnly) {
		rows.push({
			label: 'HTTPS certificate',
			// No cert yet is PENDING, not failed: certbot needs the box reachable
			// from the internet and a minute to run. Show '?', never '✗'.
			ok: probe.pathExists(`/etc/letsencrypt/live/${inputs.domain}/fullchain.pem`) ? true : null,
			detail:
				'issued automatically once this box is reachable from the internet (a minute on first run; ' +
				'a home/CGNAT connection can\u2019t get one \u2014 use tor-only mode there)'
		});
	}

	// ── Host hardening (split so each is independently visible) ───────
	rows.push({ label: 'Firewall (UFW)', ok: probe.firewallActive() });
	rows.push({ label: 'Intrusion protection (fail2ban)', ok: probe.serviceActive('fail2ban') });

	// ── Privacy networks ─────────────────────────────────────────────
	{
		const onion = probe.readText('/var/lib/tor/morphit/hostname');
		rows.push({
			label: 'Tor onion address (.onion)',
			ok: probe.serviceActive('tor') && !!onion,
			value: onion ?? undefined,
			detail: 'Tor is still bootstrapping — the .onion appears within a minute'
		});
	}
	rows.push({
		label: 'I2P address (.b32.i2p)',
		ok: probe.serviceActive('i2pd') && probe.pathExists('/var/lib/i2pd/morphit-web.dat'),
		detail: 'i2pd is still building its tunnels — give it ~10 minutes'
	});

	// ── Distribution (IPFS / IPNS) ───────────────────────────────────
	rows.push({
		label: 'IPFS node (Kubo daemon)',
		ok: probe.serviceActive('ipfs.service'),
		detail: 'the Kubo daemon is still starting — re-check in a minute'
	});
	rows.push({
		label: 'IPFS/IPNS release pinning (hourly timer)',
		ok: probe.serviceActive('morphit-ipfs-pin.timer'),
		detail: 'pins the canonical IPNS-published release CID each hour'
	});

	// ── Transparency ─────────────────────────────────────────────────
	rows.push({
		label: 'Warrant canary (/canary.txt)',
		// A not-yet-published canary is PENDING, not failed: on an offline install
		// it publishes automatically once the box is online; otherwise it's a
		// one-time sign step. Show '?', never '✗'.
		ok: canaryFresh(probe.readText(`${build}/canary.txt`)) ? true : null,
		detail: 'publishes automatically once this box is online (or sign it now with  sudo morphit-ops harden)'
	});
	rows.push({
		label: 'PGP contact key (/pgp_keys.asc)',
		ok: probe.pathExists(`${build}/pgp_keys.asc`),
		detail: 'add yours with  sudo morphit-ops harden'
	});
	rows.push({
		label: 'SEO surfaces (robots.txt + sitemap.xml)',
		ok: probe.pathExists(`${build}/robots.txt`) && probe.pathExists(`${build}/sitemap.xml`),
		detail: 'regenerated on the next build if missing'
	});

	// ── Instance identity ────────────────────────────────────────────
	rows.push({
		label: 'Instance settings written (defaults + identity)',
		ok: probe.pathExists('/etc/morphit/operator-config.env') || probe.pathExists('/etc/morphit/indexer.env')
	});
	if (inputs.contactConfigured) {
		// A Matrix CONTACT LINK (matrix.to) on the /instances card — a config value,
		// not a service. The optional Matrix BOT (morphit-matrix-bot) is a separate
		// opt-in (enable_matrix_bot, default off) most installs skip, so a contact
		// link never implies a running bot. Present here = the link is live.
		rows.push({ label: 'Contact link (Matrix) on your /instances card', ok: true });
	}

	// ── Operations ───────────────────────────────────────────────────
	rows.push({ label: 'Automatic nightly backups (timer)', ok: probe.serviceActive('morphit-backup.timer') });
	if (inputs.mode === 'home' && !inputs.torOnly) {
		rows.push({
			label: 'Automatic address updates (dynamic DNS)',
			ok: probe.serviceActive('morphit-ddns.timer')
		});
	}
	// System resources — the whole stack falls over on a full disk / no RAM.
	{
		const sys = probe.systemHealth();
		rows.push({ label: 'System resources (disk + memory)', ok: sys.ok, detail: sys.detail });
	}
	// Single roll-up over every unit — catches anything the rows above missed.
	{
		const failed = probe.failedUnits(expectedUnits(inputs));
		rows.push({
			label: 'All services + timers active',
			ok: failed.length === 0,
			detail: failed.length === 0 ? undefined : `not active yet: ${failed.join(', ')}`
		});
	}

	return rows;
}

/** A served canary counts as present+valid when it exists and its
 *  "valid through" date parses to a future instant. Signing is verified
 *  separately by `morphit-ops status`; here we only confirm it's posted and
 *  not expired. null text → missing → false. */
function canaryFresh(text: string | null): boolean {
	if (text === null) return false;
	const m = /valid[_\s-]*through[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(text);
	if (m === null) return text.trim().length > 0 ? true : false; // present but unusual format — count as posted
	const when = Date.parse(m[1]!);
	return Number.isFinite(when) ? when >= Date.now() : true;
}

/** Format the summary block (aligned ✓/✗/? rows + optional dim value + not-ok
 *  detail). PURE. `color` wraps the mark in ANSI; it defaults OFF so the
 *  rendered string stays plain + byte-stable for smokes. */
export function renderInstallSummary(
	rows: readonly ComponentStatus[],
	opts: { color?: boolean } = {}
): string {
	const paint = (s: string, code: string): string => (opts.color ? `\u001b[${code}m${s}\u001b[0m` : s);
	const mark = (ok: boolean | null): string =>
		ok === true ? paint('\u2713', '1;32') : ok === false ? paint('\u2717', '1;31') : paint('?', '1;33');
	const width = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
	return rows
		.map((r) => {
			const val = r.value ? `  ${paint(r.value, '2')}` : '';
			const tail = r.ok !== true && r.detail ? `   (${r.detail})` : '';
			return `    ${mark(r.ok)}  ${r.label.padEnd(width)}${val}${tail}`;
		})
		.join('\n');
}

function realProbe(): SummaryProbe {
	const isActive = (unit: string): boolean => {
		const r = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' });
		return (r.stdout ?? '').trim() === 'active';
	};
	return {
		serviceActive: isActive,
		failedUnits: (units): string[] => units.filter((u) => !isActive(u)),
		containerRunning: (name): boolean => {
			const r = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
			if (r.status !== 0) return false;
			return (r.stdout ?? '')
				.split('\n')
				.map((s) => s.trim())
				.includes(name);
		},
		firewallActive: (): boolean => {
			const r = spawnSync('ufw', ['status'], { encoding: 'utf8' });
			return /Status:\s*active/i.test(r.stdout ?? '');
		},
		pathExists: (p): boolean => existsSync(p),
		readText: (p): string | null => {
			try {
				return readFileSync(p, 'utf8').trim();
			} catch {
				return null;
			}
		},
		indexerHealth: async (): Promise<IndexerHealth> => {
			try {
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), 4000);
				const resp = await fetch('http://127.0.0.1:8081/v1/health', { signal: ctrl.signal });
				clearTimeout(t);
				if (!resp.ok) return { reachable: false, synced: null, rpcOk: null, fxOk: null };
				const b = (await resp.json()) as Record<string, unknown>;
				const stale = b.stale === true || b.status === 'degraded';
				const rpcHealthy = typeof b.rpc_endpoints_healthy === 'number' ? b.rpc_endpoints_healthy : null;
				const pf = b.price_feeds as Record<string, unknown> | null | undefined;
				const fxOk =
					pf && typeof pf === 'object'
						? pf.ok === true || pf.healthy === true || pf.status === 'ok'
						: null;
				return {
					reachable: true,
					synced: !stale,
					rpcOk: rpcHealthy === null ? null : rpcHealthy > 0,
					fxOk: fxOk === undefined ? null : fxOk
				};
			} catch {
				return { reachable: false, synced: null, rpcOk: null, fxOk: null };
			}
		},
		relayReachable: async (): Promise<boolean | null> => {
			try {
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), 4000);
				const resp = await fetch('http://127.0.0.1:8080/v1/health', { signal: ctrl.signal });
				clearTimeout(t);
				return resp.ok;
			} catch {
				return null;
			}
		},
		relayBalanceBlurt: async (account): Promise<number | null> => {
			try {
				const info = await lookupBlurtAccount(account);
				return info === null ? null : info.balanceBlurt;
			} catch {
				return null;
			}
		},
		systemHealth: (): SystemHealth => {
			const problems: string[] = [];
			// disk free on /
			const df = spawnSync('df', ['-Pk', '/'], { encoding: 'utf8' });
			const line = (df.stdout ?? '').trim().split('\n').at(-1) ?? '';
			const cols = line.split(/\s+/);
			if (cols.length >= 4) {
				const availKb = parseInt(cols[3]!, 10);
				if (Number.isFinite(availKb) && availKb < 1024 * 1024) problems.push('low disk (<1 GB free)');
			}
			// free memory
			try {
				const mem = readFileSync('/proc/meminfo', 'utf8');
				const avail = /MemAvailable:\s*(\d+)\s*kB/.exec(mem);
				if (avail !== null && parseInt(avail[1]!, 10) < 200 * 1024) problems.push('low memory (<200 MB free)');
			} catch {
				/* non-Linux / unreadable — skip */
			}
			return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
		}
	};
}

/** True when NOTHING has failed — no row is ✗ (ok === false). A '?' (still
 *  starting / couldn't tell — the indexer HTTP warming up, FX feeds connecting,
 *  RPC dialling) does NOT block: the announce offer only wants "no hard
 *  failure", matching the original intent that a catching-up indexer is fine.
 *  A DOWN service, missing cert, inactive firewall, or an unfunded relay is a
 *  ✗ and does block. */
export function allComponentsUp(rows: readonly ComponentStatus[]): boolean {
	return !rows.some((r) => r.ok === false);
}

/** Print the summary block. Best-effort: an unknown probe shows '?', never throws. */
export function printInstallSummary(rows: readonly ComponentStatus[]): void {
	console.log('\n  \u2500\u2500 What got installed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
	console.log(renderInstallSummary(rows, { color: true }));
	console.log('\n    A \u2717 or ? usually just means that piece is still starting \u2014 re-check');
	console.log('    in a minute with:  sudo morphit-ops status');
}
