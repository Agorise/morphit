/**
 * hardening-forwarding-smoke.
 *
 * Clearnet visitors reach BunkerWeb through Docker's published 80/443, which
 * the kernel must FORWARD. Fails when the hardening role's sysctl drop-in (the
 * content it writes, parsed as sysctl would) turns IPv4 forwarding off, or when
 * the playbook no longer checks forwarding after every handler has run. Also
 * fails when a comment claims an outbound default-deny the role never applies.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';

const yaml = createRequire(import.meta.url)('js-yaml') as { load(s: string): unknown };
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

const tasks = yaml.load(
	readFileSync(join(REPO, 'ops/ansible/roles/hardening/tasks/sysctl.yml'), 'utf8')
) as Array<Record<string, any>>;
const dropins = tasks
	.map((t) => t['ansible.builtin.copy'] ?? t.copy)
	.filter((c) => c && /sysctl\.d/.test(String(c.dest)));
check(
	'the hardening role writes a sysctl drop-in (the check below has something to read)',
	dropins.length > 0
);
for (const c of dropins) {
	const settings = new Map<string, string>();
	for (const line of String(c.content ?? '').split('\n')) {
		const m = /^\s*([a-z0-9_.]+)\s*=\s*(\S+)\s*$/i.exec(line);
		if (m) settings.set(m[1]!, m[2]!);
	}
	check(
		`${c.dest}: does not turn IPv4 forwarding off (Docker forwards the public 80/443)`,
		settings.get('net.ipv4.ip_forward') !== '0',
		`net.ipv4.ip_forward = ${settings.get('net.ipv4.ip_forward')}`
	);
}

const play = (
	yaml.load(readFileSync(join(REPO, 'ops/ansible/playbook.yml'), 'utf8')) as Array<
		Record<string, any>
	>
)[0]!;
const flat = (list: any[]): any[] => list.flatMap((t) => [t, ...flat(t?.block ?? [])]);
const post = flat(play.post_tasks ?? []);
const reads = post.find((t) =>
	/sysctl -n net\.ipv4\.ip_forward/.test(String(t['ansible.builtin.command'] ?? ''))
);
const sets = post.find((t) =>
	/sysctl -w net\.ipv4\.ip_forward=1/.test(String(t['ansible.builtin.command'] ?? ''))
);
check('the playbook reads IPv4 forwarding after every handler ran (post_tasks)', !!reads);
check('… and turns it back on when it is off', !!sets);

// The outbound policy: what the role does must match what its comments say.
const ufw = yaml.load(
	readFileSync(join(REPO, 'ops/ansible/roles/hardening/tasks/ufw.yml'), 'utf8')
) as Array<Record<string, any>>;
const outAllowed = ufw.some((t) => {
	const u = t['community.general.ufw'];
	return u && u.direction === 'outgoing' && u.policy === 'allow';
});
const gv = readFileSync(join(REPO, 'ops/ansible/group_vars/all.yml'), 'utf8');
const outboundText = readFileSync(
	join(REPO, 'ops/ansible/roles/hardening/tasks/outbound.yml'),
	'utf8'
);
check(
	'no comment claims UFW drops outgoing traffic while the role allows it',
	!outAllowed || (!/dropped by UFW/i.test(gv) && !/we set default deny/i.test(outboundText)),
	'group_vars / outbound.yml describe a default-deny rule the role never applies'
);

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} hardening-forwarding checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} hardening-forwarding checks failed`);
process.exit(1);
