/**
 * ssl-smoke (beta5 item G).
 *
 * Unit-tests the PURE cores of `morphit-ops ssl`: domain extraction,
 * openssl-enddate parsing, the expiry verdict (none/expired/expiring/
 * valid), and the certbot command builder. The I/O (reading the
 * installed cert, the renewal-timer check) runs against a real box and
 * is not exercised here.
 */

import {
	domainFromOrigin,
	parseCertNotAfter,
	certVerdict,
	buildCertbotCommands
} from '../src/commands/ssl.ts';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, detail = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (detail) console.log(`      ${detail}`);
};
const expect = (n: string, c: boolean, d = '') => (c ? ok(n) : bad(n, d));

// domainFromOrigin
expect('domain: https URL → hostname', domainFromOrigin('https://morphit.example.com') === 'morphit.example.com');
expect('domain: https URL with path/port → hostname only', domainFromOrigin('https://node.example.com:8443/x') === 'node.example.com');
expect('domain: http URL → hostname', domainFromOrigin('http://relay.example.org') === 'relay.example.org');
expect('domain: empty → null', domainFromOrigin('') === null);
expect('domain: garbage → null', domainFromOrigin('not a url') === null);
expect('domain: non-http scheme → null', domainFromOrigin('ftp://x.example.com') === null);

// parseCertNotAfter
{
	const d = parseCertNotAfter('notAfter=Jun  3 12:00:00 2026 GMT\n');
	expect('enddate: parses notAfter line', d !== null && d.getUTCFullYear() === 2026 && d.getUTCMonth() === 5);
	expect('enddate: no match → null', parseCertNotAfter('garbage output') === null);
}

// certVerdict — fixed "now" for determinism
{
	const now = new Date('2026-06-03T00:00:00Z');
	expect('verdict: null cert → none', certVerdict(null, now).kind === 'none');

	const expired = certVerdict(new Date('2026-05-20T00:00:00Z'), now);
	expect('verdict: past date → expired', expired.kind === 'expired' && (expired.daysRemaining ?? 0) < 0);

	const soon = certVerdict(new Date('2026-06-20T00:00:00Z'), now); // 17 days
	expect('verdict: <30 days → expiring', soon.kind === 'expiring' && soon.daysRemaining === 17);

	const healthy = certVerdict(new Date('2026-08-15T00:00:00Z'), now); // ~73 days
	expect('verdict: >30 days → valid', healthy.kind === 'valid' && (healthy.daysRemaining ?? 0) >= 30);
}

// buildCertbotCommands
{
	const cmds = buildCertbotCommands('morphit.example.com');
	expect('certbot: nginx plugin targets the domain', cmds.nginxPlugin.includes('--nginx -d morphit.example.com'));
	expect('certbot: includes --agree-tos + --no-eff-email', cmds.nginxPlugin.includes('--agree-tos') && cmds.nginxPlugin.includes('--no-eff-email'));
	expect('certbot: email placeholder present for operator to fill', cmds.nginxPlugin.includes('<your-email>'));
	expect('certbot: install command present', cmds.install.includes('certbot') && cmds.install.includes('python3-certbot-nginx'));
	expect('certbot: standalone stops+starts nginx', cmds.standalone.includes('systemctl stop nginx') && cmds.standalone.includes('systemctl start nginx'));
	expect('certbot: renewal verify mentions certbot timer', cmds.verifyRenewal.includes('certbot'));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 ssl smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} ssl scenarios passed`);
