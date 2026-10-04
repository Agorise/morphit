/**
 * host-alert-mail-smoke.
 *
 * The hardening role as the playbook runs it (tasks rendered with group_vars,
 * loops expanded, `when` evaluated) for three nodes: the defaults (example.com
 * placeholders), a real relay, and a tor-only node with a real relay. Alert
 * mail may leave the server only in the second; otherwise Postfix is
 * local-only and AIDE / rkhunter / unattended-upgrades keep their reports on
 * the box. fail2ban never mails or runs whois. A tor-only node never runs
 * rkhunter's data-file download. The heal's mail-off cron files
 * (lib/mailRelayHeal.ts) are byte-identical to what the role writes.
 */
import { AIDE_CRON, rkhunterCron } from '../src/lib/mailRelayHeal.ts';
import { renderAnsibleTasks } from './ansible-template-render.ts';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};
const T = 'ops/ansible/roles/hardening/tasks/';
const REAL = {
	morphit_alert_smtp_host: 'smtp.mailgun.org',
	morphit_alert_email_to: 'ops@real.org',
	morphit_alert_smtp_user: 'postmaster@real.org'
};
const cases: Array<[string, Record<string, unknown>, boolean, boolean]> = [
	['defaults (example.com placeholders)', {}, false, false],
	['a real relay', REAL, true, false],
	['tor-only with a real relay', { ...REAL, morphit_tor_only: true }, false, true]
];
for (const [label, vars, mail, torOnly] of cases) {
	const alerting = renderAnsibleTasks(`${T}alerting.yml`, vars).filter((t) => !t.skip);
	const pfLines = alerting
		.filter((t) => t.task['ansible.builtin.lineinfile'])
		.map((t) => (t.task['ansible.builtin.lineinfile'] as { line: string }).line);
	const relay = pfLines.find((l) => l.startsWith('relayhost ='));
	check(
		`${label}: Postfix ${mail ? 'relays through the configured smarthost' : 'relays nothing (local delivery only)'}`,
		mail
			? relay === 'relayhost = [smtp.mailgun.org]:587' &&
					!pfLines.some((l) => /transport = error:/.test(l))
			: relay === 'relayhost = ' &&
					pfLines.includes('default_transport = error:outbound mail is off on this server'),
		pfLines.join(' | ')
	);
	check(
		`${label}: SMTP credentials ${mail ? 'written' : 'not written'}`,
		alerting.some((t) => /SASL credentials/.test(t.name)) === mail
	);
	const content = (file: string, name: RegExp): string =>
		String(
			(
				renderAnsibleTasks(`${T}${file}`, vars).find((t) => name.test(t.name))?.task[
					'ansible.builtin.copy'
				] as { content?: string } | undefined
			)?.content ?? ''
		);
	const aide = content('aide.yml', /daily AIDE/);
	const rkh = content('rkhunter.yml', /weekly rkhunter/);
	const una = content('unattended.yml', /unattended-upgrades for security/);
	check(
		`${label}: AIDE result kept in /var/log/morphit${mail ? ' and mailed' : ', not mailed'}`,
		aide.includes('> /var/log/morphit/aide-check.log.new') && /\bmail -s/.test(aide) === mail,
		aide
	);
	check(
		`${label}: rkhunter result kept in /var/log/morphit${mail ? ' and mailed' : ', not mailed'}`,
		rkh.includes('> /var/log/morphit/rkhunter-check.log.new') && /\bmail -s/.test(rkh) === mail,
		rkh
	);
	// Ubuntu's rkhunter cannot fetch over the web (its packaged rkhunter.conf has
	// WEB_CMD="/bin/false"; `--update` stops at once, seen with no network
	// attempt); its data files come with the apt package. So no node runs it.
	check(
		`${label}: rkhunter never tries to download its data files`,
		!/^\s*rkhunter --update/m.test(rkh)
	);
	const dflt = renderAnsibleTasks(`${T}rkhunter.yml`, vars)
		.filter((t) => t.task['ansible.builtin.lineinfile'])
		.map((t) => (t.task['ansible.builtin.lineinfile'] as { line: string }).line);
	check(
		`${label}: rkhunter's own cron: report ${mail ? 'mailed' : 'not mailed'}, data update off`,
		dflt.includes(`REPORT_EMAIL="${mail ? 'ops@real.org' : ''}"`) &&
			dflt.includes('CRON_DB_UPDATE="false"'),
		dflt.join(' | ')
	);
	check(
		`${label}: unattended-upgrades ${mail ? 'mails' : 'does not mail'}`,
		una.includes(`Unattended-Upgrade::Mail "${mail ? 'ops@real.org' : ''}";`)
	);
	if (!mail) {
		check(`${label}: the heal's AIDE cron equals the role's`, aide === AIDE_CRON, aide);
		check(`${label}: the heal's rkhunter cron equals the role's`, rkh === rkhunterCron(), rkh);
	}
	const f2b = content('fail2ban.yml', /jail\.local/);
	check(
		`${label}: fail2ban bans only (no mail, no whois)`,
		/^action\s*=\s*%\(action_\)s$/m.test(f2b) && !/^action\s*=.*action_m/m.test(f2b),
		f2b.split('\n').find((l) => /^action/.test(l)) ?? ''
	);
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} host-alert-mail checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} host-alert-mail checks failed`);
process.exit(1);
