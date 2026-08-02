/**
 * installSummary.ts — the compact "what got installed + is it running" report
 * printed at the very END of the guided install.
 *
 * A live federation operator finished the wizard and, quite reasonably, wanted a
 * glance-able confirmation of what came up (relay? indexer? database? firewall?
 * HTTPS?) instead of trusting a bare "✓ installed and running" line — especially
 * after a host-pattern bug once let that line print with NOTHING installed.
 *
 * The RENDER + the component list are PURE (and smoke-pinned); the PROBES
 * (systemctl / docker / ufw / filesystem) are injected so the same logic is
 * unit-tested without a live box.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ComponentStatus {
	readonly label: string;
	/** true = up, false = down, null = not applicable / couldn't tell. */
	readonly ok: boolean | null;
	/** Shown in parentheses ONLY when the component is down/unknown. */
	readonly detail?: string;
}

export interface SummaryProbe {
	/** `systemctl is-active <unit>` reports 'active'. */
	readonly serviceActive: (unit: string) => boolean;
	/** a currently-running container is named exactly <name>. */
	readonly containerRunning: (name: string) => boolean;
	/** the UFW firewall reports active. */
	readonly firewallActive: () => boolean;
	/** a path exists on disk (e.g. the issued TLS cert). */
	readonly pathExists: (path: string) => boolean;
}

export interface SummaryInputs {
	readonly domain: string;
	readonly mode: 'home' | 'vps';
	readonly enableBunkerweb: boolean;
	/** Repo root on the server (morphit_repo_path, e.g. /opt/morphit).  The
	 *  front-end build/ dir beneath it is what BunkerWeb serves, so the warrant
	 *  canary + PGP key are probed there (that is what "posted on the website"
	 *  means). */
	readonly repoPath: string;
	/** True when the operator gave a contact (Matrix) address, so the "Contact
	 *  this operator" link is live on their /instances card.  Optional/absent → no
	 *  contact row (having none is fine; it is not a failure). */
	readonly contactConfigured?: boolean;
}

/** Build the component list from probe results.  PURE given the probe. */
export function collectInstallSummary(inputs: SummaryInputs, probe: SummaryProbe = realProbe()): ComponentStatus[] {
	const rows: ComponentStatus[] = [
		{ label: 'Marketplace database (PostgreSQL)', ok: probe.serviceActive('postgresql') },
		{ label: 'Signup relay', ok: probe.serviceActive('morphit-relay.service') },
		{ label: 'Marketplace indexer', ok: probe.serviceActive('morphit-indexer.service') },
		{ label: 'Automatic nightly backups', ok: probe.serviceActive('morphit-backup.timer') }
	];
	if (inputs.enableBunkerweb) {
		rows.push({ label: 'Web firewall (BunkerWeb)', ok: probe.containerRunning('bunkerweb') });
		rows.push({ label: 'Website (front end)', ok: probe.containerRunning('morphit-frontend') });
	}
	rows.push({
		label: 'HTTPS certificate',
		ok: probe.pathExists(`/etc/letsencrypt/live/${inputs.domain}/fullchain.pem`),
		detail: 'issued automatically \u2014 can take a minute on the first run'
	});
	rows.push({
		label: 'Server hardening (firewall + fail2ban)',
		ok: probe.firewallActive() && probe.serviceActive('fail2ban')
	});
	// Alternative-network reachability — every instance gets a .onion and a
	// .b32.i2p by default (privacy is the whole point).  "Created" here means the
	// address file the daemon derives on first start exists AND the daemon is up
	// serving it.
	rows.push({
		label: 'Tor onion address (.onion)',
		ok: probe.serviceActive('tor') && probe.pathExists('/var/lib/tor/morphit/hostname'),
		detail: 'Tor is still bootstrapping \u2014 the .onion appears within a minute'
	});
	rows.push({
		label: 'I2P address (.b32.i2p)',
		ok: probe.serviceActive('i2pd') && probe.pathExists('/var/lib/i2pd/morphit-web.dat'),
		detail: 'i2pd is still building its tunnels \u2014 give it a minute'
	});
	// Transparency surfaces served straight from the front-end build dir
	// (BunkerWeb mounts {repoPath}/apps/web/build as the site root).
	rows.push({
		label: 'Warrant canary (/canary.txt)',
		ok: probe.pathExists(`${inputs.repoPath}/apps/web/build/canary.txt`),
		detail: 'sign + post it with  sudo morphit-ops harden'
	});
	rows.push({
		label: 'PGP contact key (/pgp_keys.asc)',
		ok: probe.pathExists(`${inputs.repoPath}/apps/web/build/pgp_keys.asc`),
		detail: 'add yours with  sudo morphit-ops harden'
	});
	// Contact link (Matrix) — shown ONLY when the operator gave an address; having
	// none is fine (they can add one later), so it is never a ✗ here.
	if (inputs.contactConfigured) {
		rows.push({ label: 'Contact link (Matrix) on your /instances card', ok: true });
	}
	if (inputs.mode === 'home') {
		rows.push({
			label: 'Automatic address updates (dynamic DNS)',
			ok: probe.serviceActive('morphit-ddns.timer')
		});
	}
	return rows;
}

/** Format the summary block (aligned ✓/✗/? rows).  PURE.  `color` wraps the
 *  mark in ANSI (bold green ✓ / bold red ✗ / bold yellow ?) for the terminal;
 *  it defaults OFF so the rendered string stays plain + byte-stable for smokes.
 *  Colour never touches the label, so column alignment is unaffected. */
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
			const tail = r.ok !== true && r.detail ? `   (${r.detail})` : '';
			return `    ${mark(r.ok)}  ${r.label.padEnd(width)}${tail}`;
		})
		.join('\n');
}

function realProbe(): SummaryProbe {
	return {
		serviceActive: (unit): boolean => {
			const r = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' });
			return (r.stdout ?? '').trim() === 'active';
		},
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
		pathExists: (p): boolean => existsSync(p)
	};
}

/** True only when EVERY component is up (ok === true).  Note: an indexer that is
 *  merely catching up on the chain is still `active`, so it counts as up — a
 *  DOWN indexer (inactive) is the only indexer state that fails this. */
export function allComponentsUp(rows: readonly ComponentStatus[]): boolean {
	return rows.every((r) => r.ok === true);
}

/** Print the summary block.  Best-effort: an unknown probe shows '?', never throws. */
export function printInstallSummary(rows: readonly ComponentStatus[]): void {
	console.log('\n  \u2500\u2500 What got installed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
	console.log(renderInstallSummary(rows, { color: true }));
	console.log('\n    A \u2717 usually just means that piece is still starting \u2014 re-check');
	console.log('    in a minute with:  sudo morphit-ops status');
}
