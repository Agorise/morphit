/**
 * hidden-rpc-template-canon-smoke.
 *
 * What an Ansible install gives the indexer and the relay as their hidden
 * Blurt RPC pool, rendered from the real templates with group_vars: it must be
 * the code's DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS (all 14 — seven operators on
 * Tor and I2P), in that order, keeping only the transports the box runs. And
 * the env example must not set it (an empty line there overrides the built-in
 * 14 with none).
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS } from '../../../packages/operator-config/src/index.ts';
import { parseEnvText, renderAnsibleTemplate, repoPath } from './ansible-template-render.ts';

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

const all = [...DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS];
const onion = all.filter((u) => /\.onion:/.test(u));
const i2p = all.filter((u) => /\.b32\.i2p:/.test(u));
const cases: Array<[string, Record<string, unknown>, string[]]> = [
	['Tor and i2pd (the default)', {}, all],
	['tor-only node', { morphit_tor_only: true }, all],
	['Tor without i2pd', { enable_i2pd: false }, onion],
	['i2pd without Tor', { enable_tor: false }, i2p],
	['neither', { enable_tor: false, enable_i2pd: false }, []]
];
for (const [tpl, key] of [
	['ops/ansible/roles/morphit/templates/indexer.env.j2', 'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS'],
	['ops/ansible/roles/morphit/templates/relay.env.j2', 'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS']
] as const)
	for (const [label, vars, want] of cases) {
		let got: string[] = [];
		try {
			got = (parseEnvText(renderAnsibleTemplate(tpl, vars)).get(key) ?? '')
				.split(',')
				.filter(Boolean);
		} catch (e) {
			check(`${tpl.split('/').pop()}: renders (${label})`, false, String(e).slice(0, 200));
			continue;
		}
		check(
			`${tpl.split('/').pop()} (${label}): ${want.length} hidden nodes, the code's list in its order`,
			got.join(',') === want.join(','),
			`got ${got.length}: ${got.map((u) => u.slice(7, 15)).join(' ')}`
		);
	}
check(
	`the code's list is 14 (7 .onion + 7 .b32.i2p)`,
	all.length === 14 && onion.length === 7 && i2p.length === 7
);
const example = readFileSync(repoPath('ops/env/indexer.env.example'), 'utf8');
check(
	'indexer.env.example does not set MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS (an empty value would mean none)',
	!parseEnvText(example).has('MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS')
);

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} hidden-rpc-template-canon checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} hidden-rpc-template-canon checks failed`);
process.exit(1);
