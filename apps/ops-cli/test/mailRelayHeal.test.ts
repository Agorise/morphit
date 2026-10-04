/**
 * The host-alert-mail heal against a simulated box (Postfix's settings via a
 * fake postconf, fail2ban's running jail via a fake fail2ban-client).
 */
import { describe, expect, it } from 'vitest';
import {
	AIDE_CRON,
	banOnly,
	healMailRelay,
	rkhunterCron,
	type MailRuntime
} from '../src/lib/mailRelayHeal.ts';

const OLD_AIDE =
	'#!/bin/sh\n[ -f /var/lib/aide/aide.db ] || exit 0\naide --check 2>&1 | mail -s "[morphit] AIDE check $(date +%F)" operator@example.com\n';
const OLD_RKH =
	'#!/bin/sh\nrkhunter --update --quiet\nrkhunter --check --sk --rwo 2>&1 | mail -s "[morphit] rkhunter weekly $(date +%F)" operator@example.com\n';
const OLD_JAIL =
	'[DEFAULT]\nbantime = 1h\ndestemail = operator@example.com\naction   = %(action_mwl)s\n\n[sshd]\nenabled = true\n';

class Box {
	torOnly = false;
	pf = new Map([
		['relayhost', '[smtp.example.com]:587'],
		['default_transport', 'smtp']
	]);
	files = new Map<string, string>([
		['/etc/cron.daily/aide-check', OLD_AIDE],
		['/etc/cron.weekly/rkhunter-check', OLD_RKH],
		['/etc/default/rkhunter', 'CRON_DB_UPDATE="true"\nREPORT_EMAIL="operator@example.com"\n'],
		[
			'/etc/apt/apt.conf.d/50unattended-upgrades',
			'Unattended-Upgrade::Mail "operator@example.com";\n'
		],
		['/etc/fail2ban/jail.local', OLD_JAIL]
	]);
	loadedJail = OLD_JAIL;
	postfixReloads = 0;
	readonly rt: MailRuntime = {
		readFile: (p) => this.files.get(p) ?? null,
		writeFile: (p, t) => (this.files.set(p, t), true),
		torOnly: () => this.torOnly,
		postconf: (args) => {
			if (args[0] === '-h')
				return {
					ok: true,
					out:
						args
							.slice(1)
							.map((k) => this.pf.get(k) ?? '')
							.join('\n') + '\n'
				};
			for (const kv of args.slice(1)) {
				const i = kv.indexOf('=');
				this.pf.set(kv.slice(0, i), kv.slice(i + 1));
			}
			return { ok: true, out: '' };
		},
		reloadPostfix: () => (this.postfixReloads++, true),
		reloadFail2ban: () => ((this.loadedJail = this.files.get('/etc/fail2ban/jail.local')!), true),
		fail2banActions: () =>
			/action_mwl/.test(this.loadedJail)
				? 'The jail sshd has the following actions:\nnftables, sendmail-whois-lines'
				: 'The jail sshd has the following actions:\nnftables'
	};
	run() {
		return healMailRelay(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe('host alert mail goes nowhere it should not (mail heal)', () => {
	it('as installed: the example smarthost, reports mailed to example.com, bans mailed with whois — the case', () => {
		const b = new Box();
		expect(b.pf.get('relayhost')).toBe('[smtp.example.com]:587');
		expect(b.rt.fail2banActions()).toMatch(/whois/);
	});

	it('placeholder relay: local-only Postfix, reports kept on the box, ban-only fail2ban — all read back', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out).toMatchObject({ strategy: 'applied', verified: true });
		expect(b.pf.get('relayhost')).toBe('');
		expect(b.pf.get('default_transport')).toMatch(/^error:/);
		expect(b.files.get('/etc/cron.daily/aide-check')).toBe(AIDE_CRON);
		expect(b.files.get('/etc/cron.weekly/rkhunter-check')).toBe(rkhunterCron());
		// no data-file download on any node
		expect(b.files.get('/etc/default/rkhunter')).toBe('CRON_DB_UPDATE="false"\nREPORT_EMAIL=""\n');
		expect(b.files.get('/etc/apt/apt.conf.d/50unattended-upgrades')).toBe(
			'Unattended-Upgrade::Mail "";\n'
		);
		expect(b.rt.fail2banActions()).not.toMatch(/mail|whois/);
		expect((await b.run()).strategy).toBe('already');
		expect(b.postfixReloads).toBe(1);
	});

	it("an operator's real relay on a clearnet node is kept; fail2ban still stops mailing", async () => {
		const b = new Box();
		b.pf.set('relayhost', '[smtp.mailgun.org]:587');
		b.files.set(
			'/etc/cron.daily/aide-check',
			OLD_AIDE.replace('operator@example.com', 'me@real.org')
		);
		await b.run();
		expect(b.pf.get('relayhost')).toBe('[smtp.mailgun.org]:587');
		expect(b.files.get('/etc/cron.daily/aide-check')).toContain('| mail -s');
		expect(b.files.get('/etc/fail2ban/jail.local')).toContain('action   = %(action_)s');
	});

	it('a clearnet node with a real relay: rkhunter stops downloading too, its report is still mailed', async () => {
		const b = new Box();
		b.pf.set('relayhost', '[smtp.mailgun.org]:587');
		const mailed =
			'#!/bin/sh\nrkhunter --update --quiet\nmkdir -p /var/log/morphit\nrkhunter --check --sk --rwo > /var/log/morphit/rkhunter-check.log.new 2>&1\nmail -s "[morphit] rkhunter weekly" me@real.org < /var/log/morphit/rkhunter-check.log\n';
		b.files.set('/etc/cron.weekly/rkhunter-check', mailed);
		b.files.set('/etc/default/rkhunter', 'CRON_DB_UPDATE="true"\nREPORT_EMAIL="me@real.org"\n');
		await b.run();
		expect(b.files.get('/etc/cron.weekly/rkhunter-check')).toBe(
			mailed.replace('rkhunter --update --quiet\n', '')
		);
		expect(b.files.get('/etc/default/rkhunter')).toBe(
			'CRON_DB_UPDATE="false"\nREPORT_EMAIL="me@real.org"\n'
		);
	});

	it('a tor-only node: even a real relay goes, and rkhunter stops downloading', async () => {
		const b = new Box();
		b.torOnly = true;
		b.pf.set('relayhost', '[smtp.mailgun.org]:587');
		expect((await b.run()).verified).toBe(true);
		expect(b.pf.get('relayhost')).toBe('');
		expect(b.files.get('/etc/cron.weekly/rkhunter-check')).not.toMatch(/^rkhunter --update/m);
		expect(b.files.get('/etc/default/rkhunter')).toContain('CRON_DB_UPDATE="false"');
	});

	it('fail2ban that keeps mailing after its reload: not reported as done, the command given', async () => {
		const b = new Box();
		b.rt.reloadFail2ban = () => true; // a reload that did not take
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toContain('sudo fail2ban-client reload');
	});

	it('every mailing action becomes ban-only; others are untouched', () => {
		expect(banOnly('action = %(action_mw)s\n').text).toBe('action = %(action_)s\n');
		expect(banOnly('action = %(action_)s\n').changed).toBe(false);
		expect(banOnly('action = iptables-multiport\n').changed).toBe(false);
	});
});
