/**
 * Installed-box heal: host alert mail stops going nowhere — or out over
 * clearnet from a tor-only node — and fail2ban stops looking banned addresses
 * up.
 *
 * WHY. The hardening role configured Postfix with the example smarthost
 * `[smtp.example.com]:587` unless the operator replaced it, and pointed the
 * AIDE, rkhunter and unattended-upgrades reports at `operator@example.com`:
 * every report was a failed SMTP connection to a clearnet host (on a tor-only
 * node too). fail2ban's `action_mwl` mailed each ban with a `whois` of the
 * banned address — a clearnet lookup per visitor.
 *
 * WHAT, on this server — only where the setting is still the example
 * placeholder, or the node is tor-only (an operator's real relay on a
 * clearnet node is left alone):
 *  - Postfix: no relayhost, outbound transports refused locally
 *    (`postconf -e`), reloaded; VERIFY with `postconf -h`;
 *  - AIDE / rkhunter cron jobs: results to /var/log/morphit/*-check.log, no
 *    mail; on every node no rkhunter data-file download (CRON_DB_UPDATE and
 *    the weekly `--update` line; Ubuntu's rkhunter cannot fetch one anyway);
 *    rkhunter's REPORT_EMAIL and unattended-upgrades' Mail emptied; read back;
 *  - fail2ban (every node): `action = %(action_)s` (ban only), reloaded;
 *    VERIFY that the sshd jail's actions no longer mail.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

export const PLACEHOLDER = /example\.com/i;
const OFF = 'error:outbound mail is off on this server';

export const AIDE_CRON = `#!/bin/sh
# Daily AIDE integrity check.  The latest result stays on this server in
# /var/log/morphit/aide-check.log.
# Quiet until the deferred baseline has finished building (no "no
# database" report while it is still building).
[ -f /var/lib/aide/aide.db ] || exit 0
mkdir -p /var/log/morphit
aide --check > /var/log/morphit/aide-check.log.new 2>&1
mv /var/log/morphit/aide-check.log.new /var/log/morphit/aide-check.log
`;

export const rkhunterCron = (): string => `#!/bin/sh
# The latest result stays on this server in
# /var/log/morphit/rkhunter-check.log.
# Its data files come with the apt package; nothing is downloaded.
mkdir -p /var/log/morphit
rkhunter --check --sk --rwo > /var/log/morphit/rkhunter-check.log.new 2>&1
mv /var/log/morphit/rkhunter-check.log.new /var/log/morphit/rkhunter-check.log
`;

/** jail.local with every mailing action replaced by ban-only. PURE. */
export function banOnly(jail: string): { text: string; changed: boolean } {
	const out = jail.replace(
		/^([ \t]*action[ \t]*=[ \t]*)%\(action_m[a-z]*\)s[ \t]*$/gm,
		'$1%(action_)s'
	);
	return { text: out, changed: out !== jail };
}

/** A key="value" (or key "value";) line set to `value`. PURE. */
export function setQuoted(
	text: string,
	re: RegExp,
	line: string
): { text: string; changed: boolean } {
	const out = text.replace(re, line);
	return { text: out, changed: out !== text };
}

export interface MailRuntime {
	readFile(path: string): string | null;
	writeFile(path: string, text: string, mode: number): boolean;
	torOnly(): boolean;
	postconf(args: readonly string[]): { ok: boolean; out: string };
	reloadPostfix(): boolean;
	reloadFail2ban(): boolean;
	/** The sshd jail's actions as fail2ban reports them; null if unreadable. */
	fail2banActions(): string | null;
}

export async function healMailRelay(
	ctx: HealCtx,
	opts: { runtime?: MailRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const R = opts.root ?? '';
	const torOnly = rt.torOnly();
	const done: string[] = [];
	const problems: string[] = [];

	// Postfix.
	const relay = rt.postconf(['-h', 'relayhost']);
	if (relay.ok) {
		const host = relay.out.trim();
		const mailOff = host === '' || PLACEHOLDER.test(host) || torOnly;
		if (host !== '' && mailOff) {
			rt.postconf(['-e', 'relayhost=', `default_transport=${OFF}`, `relay_transport=${OFF}`]);
			const stop = ctx.spinner('Reloading Postfix (local delivery only)…');
			try {
				rt.reloadPostfix();
			} finally {
				stop();
			}
			const now = rt
				.postconf(['-h', 'relayhost', 'default_transport'])
				.out.split('\n')
				.map((l) => l.trim());
			if (now[0] === '' && (now[1] ?? '').startsWith('error:'))
				done.push(
					`Postfix no longer relays to ${host} (local delivery only; read back with postconf)`
				);
			else
				problems.push(
					`Postfix still relays to ${host}; on this server run: sudo postconf -e 'relayhost=' && sudo systemctl reload postfix`
				);
		}
		if (mailOff) {
			const edits: Array<[string, RegExp, string, number]> = [
				[
					`${R}/etc/apt/apt.conf.d/50unattended-upgrades`,
					/^(\s*)Unattended-Upgrade::Mail\s+"[^"]*";/m,
					'$1Unattended-Upgrade::Mail "";',
					0o644
				],
				[`${R}/etc/default/rkhunter`, /^REPORT_EMAIL="[^"]*"/m, 'REPORT_EMAIL=""', 0o644]
			];
			for (const [p, re, line, mode] of edits) {
				const t = rt.readFile(p);
				if (t === null) continue;
				const r = setQuoted(t, re, line);
				if (!r.changed) continue;
				if (rt.writeFile(p, r.text, mode) && rt.readFile(p) === r.text) done.push(`${p}: no mail`);
				else problems.push(`could not update ${p}`);
			}
			for (const [p, want] of [
				[`${R}/etc/cron.daily/aide-check`, AIDE_CRON],
				[`${R}/etc/cron.weekly/rkhunter-check`, rkhunterCron()]
			] as const) {
				const t = rt.readFile(p);
				// Only the shapes Morphit wrote: one that mails, or one that downloads.
				if (
					t === null ||
					t === want ||
					!(/\|\s*mail\s/.test(t) || /^\s*rkhunter --update/m.test(t))
				)
					continue;
				if (rt.writeFile(p, want, 0o755) && rt.readFile(p) === want)
					done.push(`${p}: result kept in /var/log/morphit, not mailed`);
				else problems.push(`could not update ${p}`);
			}
		}
	}

	// rkhunter, every node: no data-file download (Ubuntu's rkhunter cannot do
	// one — its rkhunter.conf has WEB_CMD="/bin/false" — and the data files
	// come with the apt package); a mailing cron keeps its mail.
	for (const [p, re, line] of [
		[`${R}/etc/default/rkhunter`, /^CRON_DB_UPDATE="true"/m, 'CRON_DB_UPDATE="false"']
	] as const) {
		const t = rt.readFile(p);
		if (t === null) continue;
		const r = setQuoted(t, re, line);
		if (!r.changed) continue;
		if (rt.writeFile(p, r.text, 0o644) && rt.readFile(p) === r.text)
			done.push(`${p}: no data-file download`);
		else problems.push(`could not update ${p}`);
	}
	{
		const p = `${R}/etc/cron.weekly/rkhunter-check`;
		const t = rt.readFile(p);
		if (t !== null && /^\s*rkhunter --update[^\n]*\n/m.test(t)) {
			const next = t.replace(/^\s*rkhunter --update[^\n]*\n/m, '');
			if (rt.writeFile(p, next, 0o755) && rt.readFile(p) === next)
				done.push(`${p}: no data-file download`);
			else problems.push(`could not update ${p}`);
		}
	}

	// fail2ban: ban only, on every node.
	const jailPath = `${R}/etc/fail2ban/jail.local`;
	const jail = rt.readFile(jailPath);
	if (jail !== null) {
		const b = banOnly(jail);
		if (b.changed) {
			if (!rt.writeFile(jailPath, b.text, 0o644)) problems.push(`could not update ${jailPath}`);
			else {
				const stop = ctx.spinner('Reloading fail2ban (ban only, no mail, no whois)…');
				try {
					rt.reloadFail2ban();
				} finally {
					stop();
				}
				const acts = rt.fail2banActions();
				if (acts !== null && !/mail|whois/i.test(acts))
					done.push(
						'fail2ban bans without mailing or looking addresses up (seen in its sshd jail)'
					);
				else if (acts === null)
					done.push(
						`fail2ban set to ban only in ${jailPath} (read back; its running jail could not be asked)`
					);
				else
					problems.push(
						`fail2ban's sshd jail still has ${acts.trim()}; on this server run: sudo fail2ban-client reload`
					);
			}
		}
	}
	const verified = problems.length === 0;
	return {
		strategy: done.length === 0 && verified ? 'already' : verified ? 'applied' : 'partial',
		verified,
		routine: done.length === 0 && verified,
		detail:
			done.length === 0 && verified
				? 'Host alert mail: nothing to change on this server.'
				: `Host alert mail: ${[...done, ...problems].join('; ')}.`
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healMailRelay(ctx);
}

const sh = (
	cmd: string,
	args: readonly string[],
	timeout = 30_000
): { ok: boolean; out: string } => {
	try {
		const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout });
		return { ok: r.status === 0, out: r.stdout ?? '' };
	} catch {
		return { ok: false, out: '' };
	}
};

const realRuntime: MailRuntime = {
	readFile: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	writeFile: (p, text, mode) => {
		const tmp = `${p}.morphit-tmp`;
		try {
			writeFileSync(tmp, text, { mode });
			keepOwnerAndMode(p, tmp);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	torOnly: () => {
		try {
			return isHiddenOnlyNode();
		} catch {
			return false;
		}
	},
	postconf: (args) => sh('postconf', args),
	reloadPostfix: () => sh('systemctl', ['reload', 'postfix']).ok,
	reloadFail2ban: () => sh('fail2ban-client', ['reload']).ok,
	fail2banActions: () => {
		const r = sh('fail2ban-client', ['get', 'sshd', 'actions']);
		return r.ok ? r.out : null;
	}
};
