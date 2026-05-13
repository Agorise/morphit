/**
 * Morphit ops CLI — pre-wizard system check.
 *
 * Verifies the operator's box meets recommended specs before
 * we ask them to invest 5-10 minutes in interactive prompts.
 * Each check is best-effort: anything that throws becomes an
 * 'error' status with the exception message as note.  Total
 * runtime: ~5 seconds (network checks dominate).
 *
 * The wizard runs the check unconditionally; --check-only
 * makes the wizard EXIT after the check.  Operators with
 * non-standard setups (containers, custom kernels, dev VMs)
 * see warnings but can choose to continue.
 */

import { cpus, totalmem, freemem, arch, platform } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { connect } from 'node:net';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface Check {
	readonly name: string;
	readonly actual: string;
	readonly recommended: string;
	readonly status: CheckStatus;
	readonly note?: string;
}

export interface SystemCheckResult {
	readonly checks: readonly Check[];
	readonly hasErrors: boolean;
	readonly hasWarnings: boolean;
}

/** Run all checks in sequence.  Network-bound checks are awaited
 *  individually rather than parallelized — the small extra latency
 *  is fine, and serial output is easier to follow when something
 *  hangs. */
export async function runSystemCheck(): Promise<SystemCheckResult> {
	const checks: Check[] = [];

	// ─── CPU ───────────────────────────────────────────────────
	checks.push(checkCpuCores());
	checks.push(checkArch());

	// ─── Memory ────────────────────────────────────────────────
	checks.push(checkRamTotal());
	checks.push(checkRamFree());

	// ─── Disk ──────────────────────────────────────────────────
	checks.push(checkDiskFree());

	// ─── Node ──────────────────────────────────────────────────
	checks.push(checkNodeVersion());

	// ─── OS ────────────────────────────────────────────────────
	checks.push(checkOperatingSystem());

	// ─── systemd ───────────────────────────────────────────────
	checks.push(checkSystemd());

	// ─── Network (slow, last) ──────────────────────────────────
	checks.push(await checkPostgresReachable());
	checks.push(await checkOutboundHttps());
	checks.push(await checkSystemTime());

	// ─── OS hardening (Q9 — operator setup checklist) ──────────
	// Best-effort. These read from local files / run quick local
	// commands. Fail-soft: if a file isn't there, return 'warn'
	// with a hint, never 'error' (the operator may have a
	// non-standard but equivalent config).
	checks.push(checkUnattendedUpgrades());
	checks.push(checkUfw());
	checks.push(checkSshHardening());
	checks.push(checkFail2ban());
	checks.push(checkJournaldDiskCap());

	const hasErrors = checks.some((c) => c.status === 'error');
	const hasWarnings = checks.some((c) => c.status === 'warn');
	return { checks, hasErrors, hasWarnings };
}

// ─── Individual checks ───────────────────────────────────────────

function checkCpuCores(): Check {
	try {
		const cores = cpus().length;
		return {
			name: 'CPU cores',
			actual: String(cores),
			recommended: '≥2',
			status: cores >= 2 ? 'ok' : 'warn',
			note: cores < 2 ? 'works but slow on single-core' : undefined
		};
	} catch (err) {
		return {
			name: 'CPU cores',
			actual: 'unknown',
			recommended: '≥2',
			status: 'error',
			note: err instanceof Error ? err.message : 'failed to read'
		};
	}
}

function checkArch(): Check {
	const a = arch();
	// node calls ARM64 'arm64' and x86_64 'x64'.
	const ok = a === 'x64' || a === 'arm64';
	return {
		name: 'Architecture',
		actual: a,
		recommended: 'x64 or arm64',
		status: ok ? 'ok' : 'warn',
		note: ok ? undefined : 'untested architecture; may have surprises'
	};
}

function checkRamTotal(): Check {
	const totalGB = totalmem() / 1024 / 1024 / 1024;
	const status: CheckStatus = totalGB >= 2 ? 'ok' : totalGB >= 1 ? 'warn' : 'error';
	return {
		name: 'RAM total',
		actual: `${totalGB.toFixed(1)} GB`,
		recommended: '≥2 GB',
		status,
		note:
			status === 'error'
				? 'Morphit may OOM under load; recommend ≥2 GB RAM'
				: status === 'warn'
					? 'tight; works for small instances'
					: undefined
	};
}

function checkRamFree(): Check {
	const freeGB = freemem() / 1024 / 1024 / 1024;
	const status: CheckStatus = freeGB >= 1 ? 'ok' : freeGB >= 0.5 ? 'warn' : 'error';
	return {
		name: 'RAM free',
		actual: `${freeGB.toFixed(1)} GB`,
		recommended: '≥1 GB',
		status,
		note: status === 'error' ? 'very low; close other services before running Morphit' : undefined
	};
}

function checkDiskFree(): Check {
	try {
		// `df -kP /` gives 1024-byte blocks in POSIX format — most
		// portable across distros.  Parse the second line, fourth
		// column (Available).  Falls back gracefully if df fails.
		const out = execSync('df -kP /', { encoding: 'utf8', timeout: 2000 });
		const lines = out.trim().split('\n');
		if (lines.length < 2) throw new Error('unexpected df output');
		const fields = lines[1]!.split(/\s+/);
		const availKb = parseInt(fields[3] ?? '', 10);
		if (isNaN(availKb)) throw new Error('unparseable df output');
		const availGB = availKb / 1024 / 1024;
		const status: CheckStatus = availGB >= 20 ? 'ok' : availGB >= 10 ? 'warn' : 'error';
		return {
			name: 'Disk free (/)',
			actual: `${availGB.toFixed(0)} GB`,
			recommended: '≥20 GB',
			status,
			note:
				status === 'error'
					? 'Postgres + chain history will fill this fast'
					: status === 'warn'
						? 'works initially; plan to expand'
						: undefined
		};
	} catch (err) {
		return {
			name: 'Disk free (/)',
			actual: 'unknown',
			recommended: '≥20 GB',
			status: 'warn',
			note: 'could not measure (df failed)'
		};
	}
}

function checkNodeVersion(): Check {
	const v = process.versions.node;
	const major = parseInt(v.split('.')[0] ?? '0', 10);
	const status: CheckStatus = major >= 22 ? 'ok' : 'error';
	return {
		name: 'Node.js',
		actual: `v${v}`,
		recommended: '≥22',
		status,
		note:
			status === 'error' ? 'Morphit requires Node 22+; install via nvm or NodeSource' : undefined
	};
}

/** Parse /etc/os-release to identify the OS.  Returns one of:
 *  - 'recommended'  → green (Ubuntu LTS, current Debian)
 *  - 'works'        → yellow (interim Ubuntu, older LTS, other Linux)
 *  - 'unsupported'  → red (EOL Ubuntu, macOS, Windows, BSD) */
function checkOperatingSystem(): Check {
	if (platform() !== 'linux') {
		return {
			name: 'Operating system',
			actual: platform(),
			recommended: 'Linux (Ubuntu LTS recommended)',
			status: 'error',
			note: 'Morphit servers run Linux; macOS/Windows/BSD not supported'
		};
	}
	if (!existsSync('/etc/os-release')) {
		return {
			name: 'Operating system',
			actual: 'Linux (unknown distro)',
			recommended: 'Ubuntu 24.04 or 26.04 LTS',
			status: 'warn',
			note: 'no /etc/os-release; could not identify distro'
		};
	}
	try {
		const content = readFileSync('/etc/os-release', 'utf8');
		const data: Record<string, string> = {};
		for (const line of content.split('\n')) {
			const eq = line.indexOf('=');
			if (eq < 1) continue;
			const k = line.slice(0, eq);
			let v = line.slice(eq + 1);
			if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
			data[k] = v;
		}
		const id = (data.ID ?? '').toLowerCase();
		const versionId = data.VERSION_ID ?? '';
		const prettyName = data.PRETTY_NAME ?? `${id} ${versionId}`;
		return classifyOs(id, versionId, prettyName);
	} catch (err) {
		return {
			name: 'Operating system',
			actual: 'Linux',
			recommended: 'Ubuntu 24.04 or 26.04 LTS',
			status: 'warn',
			note: 'failed to parse /etc/os-release'
		};
	}
}

function classifyOs(id: string, versionId: string, prettyName: string): Check {
	if (id === 'ubuntu') {
		// Major.minor parse.
		const [maj, min] = versionId.split('.').map((s) => parseInt(s, 10));
		const major = maj ?? 0;
		const minor = min ?? 0;
		const isLts = minor === 4 && major % 2 === 0;
		// Ubuntu 26.04 LTS, 24.04 LTS — both recommended.
		if ((major === 26 && minor === 4) || (major === 24 && minor === 4)) {
			return {
				name: 'Operating system',
				actual: prettyName,
				recommended: 'Ubuntu 24.04 or 26.04 LTS',
				status: 'ok'
			};
		}
		// Ubuntu 22.04 LTS — works but aging.
		if (major === 22 && minor === 4) {
			return {
				name: 'Operating system',
				actual: prettyName,
				recommended: 'Ubuntu 24.04 or 26.04 LTS',
				status: 'warn',
				note: 'aging; upgrade to 24.04 or 26.04 LTS recommended'
			};
		}
		// Ubuntu interim release — works but expires soon.
		if (major >= 24 && !isLts) {
			return {
				name: 'Operating system',
				actual: prettyName,
				recommended: 'Ubuntu 24.04 or 26.04 LTS',
				status: 'warn',
				note: 'interim release expires in ~9 months; LTS recommended'
			};
		}
		// EOL or unsupported old.
		if (major < 22) {
			return {
				name: 'Operating system',
				actual: prettyName,
				recommended: 'Ubuntu 24.04 or 26.04 LTS',
				status: 'error',
				note: 'EOL — security risk; upgrade to a supported LTS'
			};
		}
		return {
			name: 'Operating system',
			actual: prettyName,
			recommended: 'Ubuntu 24.04 or 26.04 LTS',
			status: 'warn',
			note: 'unrecognized Ubuntu version'
		};
	}
	if (id === 'debian') {
		const major = parseInt(versionId.split('.')[0] ?? '0', 10);
		if (major >= 12) {
			return {
				name: 'Operating system',
				actual: prettyName,
				recommended: 'Ubuntu 24.04 or 26.04 LTS (Debian 12+ also works)',
				status: 'ok'
			};
		}
		return {
			name: 'Operating system',
			actual: prettyName,
			recommended: 'Debian 12+ or Ubuntu LTS',
			status: 'warn',
			note: 'older Debian; upgrade recommended'
		};
	}
	// Other Linux — likely works, on their own.
	return {
		name: 'Operating system',
		actual: prettyName,
		recommended: 'Ubuntu 24.04 or 26.04 LTS',
		status: 'warn',
		note: 'unsupported distro; likely works but on your own for distro issues'
	};
}

function checkSystemd(): Check {
	try {
		execSync('which systemctl', { stdio: 'pipe', timeout: 2000 });
		return {
			name: 'systemd',
			actual: 'installed',
			recommended: 'installed',
			status: 'ok'
		};
	} catch {
		return {
			name: 'systemd',
			actual: 'not found',
			recommended: 'installed',
			status: 'warn',
			note: 'no systemctl on PATH; you can still run Morphit but unit-file examples in docs assume systemd'
		};
	}
}

async function checkPostgresReachable(): Promise<Check> {
	const host = process.env.MORPHIT_OPS_PG_HOST ?? 'localhost';
	const port = parseInt(process.env.MORPHIT_OPS_PG_PORT ?? '5432', 10);
	return new Promise<Check>((resolve) => {
		const sock = connect({ host, port, timeout: 3000 });
		const finish = (status: CheckStatus, actual: string, note?: string): void => {
			sock.removeAllListeners();
			sock.destroy();
			resolve({
				name: `Postgres @ ${host}:${port}`,
				actual,
				recommended: 'reachable',
				status,
				note
			});
		};
		sock.once('connect', () => finish('ok', 'reachable'));
		sock.once('timeout', () => finish('warn', 'timed out', 'firewall or wrong host?'));
		sock.once('error', (err: Error) =>
			finish(
				'warn',
				'unreachable',
				`${err.message} — Postgres might not be installed yet; you can configure the URL in step 3`
			)
		);
	});
}

async function checkOutboundHttps(): Promise<Check> {
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 5000);
		// HEAD against a canonical Blurt RPC. Same list shipped with
		// the frontend (apps/web/src/lib/net/config.ts).
		const resp = await fetch('https://rpc.blurt.blog', {
			method: 'HEAD',
			signal: controller.signal
		});
		clearTimeout(t);
		if (resp.ok || resp.status === 405) {
			// 405 Method Not Allowed is fine — the server's reachable.
			return {
				name: 'Outbound HTTPS',
				actual: 'reachable',
				recommended: 'reachable',
				status: 'ok'
			};
		}
		return {
			name: 'Outbound HTTPS',
			actual: `HTTP ${resp.status}`,
			recommended: 'reachable',
			status: 'warn',
			note: 'reachable but unexpected response'
		};
	} catch (err) {
		return {
			name: 'Outbound HTTPS',
			actual: 'failed',
			recommended: 'reachable',
			status: 'error',
			note:
				'cannot reach Blurt RPC; check your network and DNS' +
				(err instanceof Error ? ` (${err.message})` : '')
		};
	}
}

async function checkSystemTime(): Promise<Check> {
	try {
		const before = Date.now();
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 5000);
		const resp = await fetch('https://www.google.com', {
			method: 'HEAD',
			signal: controller.signal
		});
		clearTimeout(t);
		const after = Date.now();
		const dateHeader = resp.headers.get('date');
		if (!dateHeader) {
			return {
				name: 'System time',
				actual: 'no date header',
				recommended: 'within 30s of NTP',
				status: 'warn'
			};
		}
		const serverMs = Date.parse(dateHeader);
		if (isNaN(serverMs)) {
			return {
				name: 'System time',
				actual: 'unparseable',
				recommended: 'within 30s of NTP',
				status: 'warn'
			};
		}
		// Account for round-trip half-time.
		const localMid = (before + after) / 2;
		const driftSec = Math.abs(localMid - serverMs) / 1000;
		const status: CheckStatus = driftSec < 30 ? 'ok' : driftSec < 300 ? 'warn' : 'error';
		return {
			name: 'System time',
			actual: `${driftSec.toFixed(0)}s drift vs HTTP server`,
			recommended: '<30s drift',
			status,
			note:
				status === 'error'
					? 'install NTP (e.g. systemd-timesyncd or chrony) — chain ops fail with bad clocks'
					: status === 'warn'
						? 'consider running NTP for tighter sync'
						: undefined
		};
	} catch (err) {
		return {
			name: 'System time',
			actual: 'check failed',
			recommended: '<30s drift',
			status: 'warn',
			note: 'could not query a reference clock'
		};
	}
}

// ─── OS hardening checks (Q9) ────────────────────────────────────
//
// These verify the recommended hardening from OPERATIONS.md §14.6.
// Each one is best-effort and fails soft (returns 'warn', not
// 'error') so a non-standard-but-equivalent config doesn't block
// the wizard.

function checkUnattendedUpgrades(): Check {
	// Debian/Ubuntu: package present + auto-upgrades enabled in
	// /etc/apt/apt.conf.d/20auto-upgrades.
	try {
		const conf = '/etc/apt/apt.conf.d/20auto-upgrades';
		if (!existsSync(conf)) {
			return {
				name: 'unattended-upgrades',
				actual: 'not configured',
				recommended: 'installed + enabled',
				status: 'warn',
				note: 'install with: apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades'
			};
		}
		const text = readFileSync(conf, 'utf-8');
		// Look for the two standard knobs being '1'.
		const updateOk = /APT::Periodic::Update-Package-Lists\s*"1"/.test(text);
		const upgradeOk = /APT::Periodic::Unattended-Upgrade\s*"1"/.test(text);
		const ok = updateOk && upgradeOk;
		return {
			name: 'unattended-upgrades',
			actual: ok ? 'enabled' : 'configured but disabled',
			recommended: 'installed + enabled',
			status: ok ? 'ok' : 'warn',
			note: ok ? undefined : 'edit /etc/apt/apt.conf.d/20auto-upgrades to set both knobs to "1"'
		};
	} catch (err) {
		return {
			name: 'unattended-upgrades',
			actual: 'check failed',
			recommended: 'installed + enabled',
			status: 'warn',
			note: 'unable to read apt config — non-Debian system?'
		};
	}
}

function checkUfw(): Check {
	// Run `ufw status` (1s timeout). Idempotent and fast.
	try {
		const out = execSync('ufw status 2>/dev/null', {
			timeout: 2000,
			encoding: 'utf-8'
		});
		const active = /Status:\s+active/i.test(out);
		// Look for at least one rule allowing 443 and one denying
		// or limiting incoming on 22.
		const allow443 = /443\/tcp\s+ALLOW/i.test(out) || /(ALLOW|LIMIT)\s+443/i.test(out);
		const status: CheckStatus = !active ? 'warn' : allow443 ? 'ok' : 'warn';
		return {
			name: 'ufw firewall',
			actual: active ? (allow443 ? 'active + 443 open' : 'active, 443 missing') : 'inactive',
			recommended: 'active, 443 open',
			status,
			note: !active
				? 'enable with: ufw default deny incoming; ufw allow 443/tcp; ufw allow 22/tcp; ufw enable'
				: !allow443
					? 'add 443: ufw allow 443/tcp'
					: undefined
		};
	} catch {
		return {
			name: 'ufw firewall',
			actual: 'not installed',
			recommended: 'active, 443 open',
			status: 'warn',
			note: 'install with: apt-get install -y ufw'
		};
	}
}

function checkSshHardening(): Check {
	// Read /etc/ssh/sshd_config (or /etc/ssh/sshd_config.d/*).
	// Look for PasswordAuthentication no.
	try {
		const main = '/etc/ssh/sshd_config';
		if (!existsSync(main)) {
			return {
				name: 'SSH password auth',
				actual: 'sshd_config not found',
				recommended: 'PasswordAuthentication no',
				status: 'warn',
				note: 'no SSH config — running headless?'
			};
		}
		// Check the main file AND any *.conf in sshd_config.d, where
		// the LAST matching directive wins.
		// Using a wrapper object so TypeScript doesn't over-narrow:
		// a bare `let lastValue: string | null = null` would be
		// narrowed to `null` at the read site below because TS doesn't
		// track closure mutations through the checkFile() callback.
		const state: { lastValue: string | null } = { lastValue: null };
		const checkFile = (path: string): void => {
			if (!existsSync(path)) return;
			const lines = readFileSync(path, 'utf-8').split('\n');
			for (const line of lines) {
				const m = /^\s*PasswordAuthentication\s+(\S+)/i.exec(line);
				// m[1] is guaranteed defined when m matches, because
				// the (\S+) capture group is mandatory in the pattern,
				// but TS's noUncheckedIndexedAccess can't infer that.
				if (m && m[1] !== undefined) state.lastValue = m[1].toLowerCase();
			}
		};
		checkFile(main);
		// sshd_config.d entries override main; sshd reads them in
		// alphabetical order.
		try {
			const dir = '/etc/ssh/sshd_config.d';
			if (existsSync(dir)) {
				const entries = execSync(`ls -1 ${dir}/*.conf 2>/dev/null`, {
					encoding: 'utf-8'
				})
					.split('\n')
					.filter((s) => s.length > 0)
					.sort();
				for (const e of entries) checkFile(e);
			}
		} catch {
			// dir may not exist; that's fine.
		}
		// Default if unspecified is 'yes' (insecure default).
		const value = state.lastValue ?? 'yes';
		const ok = value === 'no';
		return {
			name: 'SSH password auth',
			actual: `PasswordAuthentication ${value}`,
			recommended: 'PasswordAuthentication no',
			status: ok ? 'ok' : 'warn',
			note: ok
				? undefined
				: 'set PasswordAuthentication no in /etc/ssh/sshd_config (after confirming key-based access works) and restart sshd'
		};
	} catch (err) {
		return {
			name: 'SSH password auth',
			actual: 'check failed',
			recommended: 'PasswordAuthentication no',
			status: 'warn',
			note: err instanceof Error ? err.message : 'unable to read SSH config'
		};
	}
}

function checkFail2ban(): Check {
	try {
		execSync('systemctl is-active --quiet fail2ban 2>/dev/null', {
			timeout: 2000
		});
		return {
			name: 'fail2ban',
			actual: 'active',
			recommended: 'active with sshd jail',
			status: 'ok'
		};
	} catch {
		return {
			name: 'fail2ban',
			actual: 'inactive or not installed',
			recommended: 'active with sshd jail',
			status: 'warn',
			note: 'install with: apt-get install -y fail2ban && systemctl enable --now fail2ban'
		};
	}
}

function checkJournaldDiskCap(): Check {
	// Read /etc/systemd/journald.conf for SystemMaxUse.
	try {
		const path = '/etc/systemd/journald.conf';
		if (!existsSync(path)) {
			return {
				name: 'journald disk cap',
				actual: 'config not found',
				recommended: 'SystemMaxUse set',
				status: 'warn',
				note: 'configure SystemMaxUse=500M to prevent log-disk runaway'
			};
		}
		const text = readFileSync(path, 'utf-8');
		// Find an UNCOMMENTED SystemMaxUse line.
		const m = text.split('\n').find((l) => /^\s*SystemMaxUse\s*=/.test(l));
		if (!m) {
			return {
				name: 'journald disk cap',
				actual: 'unset (system default)',
				recommended: 'SystemMaxUse set',
				status: 'warn',
				note: 'consider adding SystemMaxUse=500M to /etc/systemd/journald.conf'
			};
		}
		// The regex above guaranteed `=` is present, so split('=')
		// produces ≥2 parts and [1] exists. The fallback handles TS's
		// noUncheckedIndexedAccess — the empty-string branch is
		// unreachable in practice.
		const val = (m.split('=')[1] ?? '').trim();
		return {
			name: 'journald disk cap',
			actual: val,
			recommended: 'SystemMaxUse set',
			status: 'ok'
		};
	} catch (err) {
		return {
			name: 'journald disk cap',
			actual: 'check failed',
			recommended: 'SystemMaxUse set',
			status: 'warn',
			note: err instanceof Error ? err.message : 'unable to read journald config'
		};
	}
}

// ─── Renderer ────────────────────────────────────────────────────

const GLYPH_OK = '\x1b[32m✓\x1b[0m';
const GLYPH_WARN = '\x1b[33m⚠\x1b[0m';
const GLYPH_ERROR = '\x1b[31m✗\x1b[0m';
const GLYPH_OK_PLAIN = '[OK]';
const GLYPH_WARN_PLAIN = '[WARN]';
const GLYPH_ERROR_PLAIN = '[ERR]';

function glyph(status: CheckStatus, color: boolean): string {
	if (color) {
		return status === 'ok' ? GLYPH_OK : status === 'warn' ? GLYPH_WARN : GLYPH_ERROR;
	}
	return status === 'ok'
		? GLYPH_OK_PLAIN
		: status === 'warn'
			? GLYPH_WARN_PLAIN
			: GLYPH_ERROR_PLAIN;
}

export function renderSystemCheck(result: SystemCheckResult, color: boolean): void {
	const rule = '━'.repeat(58);
	console.log(rule);
	console.log('System check');
	console.log(rule);
	console.log('');
	const NAME_W = 28;
	const ACTUAL_W = 22;
	for (const c of result.checks) {
		const nameCol = c.name.padEnd(NAME_W);
		const actualCol = c.actual.padEnd(ACTUAL_W);
		const g = glyph(c.status, color);
		console.log(`  ${nameCol}${actualCol}${g}`);
		if (c.note !== undefined) {
			console.log(`      ${c.note}`);
		}
	}
	console.log('');

	if (!result.hasErrors && !result.hasWarnings) {
		console.log("  All checks passed.  You're good to go.");
	} else if (result.hasErrors) {
		console.log(
			'  Some checks did not pass.  Review the ✗ items above; ' +
				'they may prevent Morphit from running well.'
		);
	} else {
		console.log(
			'  Some checks issued warnings.  Morphit will likely run, ' +
				'but the items above are worth reviewing.'
		);
	}
	console.log('');

	// Network port informational block — informational only.
	console.log('Network ports your operator should open inbound:');
	console.log('  • 443/tcp — your reverse proxy (nginx/Caddy) terminates TLS here');
	console.log('  • Optional 80/tcp — HTTP redirect to 443');
	console.log('  • Optional 9050/tcp — Tor SOCKS, only if Tor is installed');
	console.log('  • All other Morphit services bind 127.0.0.1; do not expose them publicly');
	console.log('');
}
