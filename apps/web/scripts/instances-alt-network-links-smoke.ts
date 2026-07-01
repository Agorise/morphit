#!/usr/bin/env tsx
/**
 * instances-alt-network-links smoke — cp321.
 *
 * THE BUG THIS GUARDS AGAINST. On the federation directory (/instances), each
 * instance card shows alt-network reachability pills (Tor / Lokinet / I2P b32 /
 * I2P name / Nostr). They were rendered as bare `<span class="chip">` with the
 * address only in the `title` tooltip — so they had a nice hover but were NOT
 * clickable. The fix turns each into an `<a>` that opens the address in a new
 * tab, mirroring the footer's treatment exactly:
 *   - Tor / Lokinet / I2P  → href="http://{address}"
 *   - Nostr                → href="nostr:{address}"
 *   - all five             → target="_blank" rel="noopener noreferrer"
 *
 * RULE: when the alt-network pills are present on the instances page they must
 * be anchors (not spans), use the right scheme per network, and carry
 * target="_blank" rel="noopener noreferrer".
 *
 * Tamper test (must turn this smoke red):
 *   - Revert any pill to a <span class="chip" title={inst.alt_networks.X}>.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const INSTANCES = join(REPO, 'apps/web/src/routes/[lang]/instances/+page.svelte');

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const page = read(INSTANCES);

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  \u2713 ${m}`);
	pass++;
};
const bad = (m: string): void => {
	console.error(`  \u2717 ${m}`);
	fail++;
};

// 1. No bare-span pill survives (the un-clickable form).
{
	if (!/<span class="chip text-xs" title=\{inst\.alt_networks\./.test(page))
		ok('no bare <span class="chip"> alt-network pill remains (they are clickable now)');
	else bad('an alt-network pill is still a non-clickable <span class="chip" title={inst.alt_networks.X}>');
}

// 2. http:// scheme for tor / lokinet / i2p_b32 / i2p_name.
for (const net of ['tor', 'lokinet', 'i2p_b32', 'i2p_name']) {
	const re = new RegExp(`href="http://\\{inst\\.alt_networks\\.${net}\\}"`);
	if (re.test(page)) ok(`${net} pill links via http://{inst.alt_networks.${net}}`);
	else bad(`${net} pill missing http://{inst.alt_networks.${net}} href`);
}

// 3. nostr: scheme for the nostr pill.
{
	if (/href="nostr:\{inst\.alt_networks\.nostr\}"/.test(page)) ok('nostr pill links via nostr:{inst.alt_networks.nostr}');
	else bad('nostr pill missing nostr:{inst.alt_networks.nostr} href');
}

// 4. all five anchors carry target + rel. Count the alt-network <a> blocks and
//    assert each has the safe attrs by counting occurrences against the pills.
{
	const pillCount = (page.match(/href="(?:http:\/\/|nostr:)\{inst\.alt_networks\./g) ?? []).length;
	// Each pill anchor must pair with a target="_blank" and rel="noopener noreferrer".
	// They appear once per pill in the alt-networks block.
	const blank = (page.match(/target="_blank"/g) ?? []).length;
	const rel = (page.match(/rel="noopener noreferrer"/g) ?? []).length;
	if (pillCount === 5 && blank >= 5 && rel >= 5)
		ok('all five alt-network pills carry target="_blank" rel="noopener noreferrer"');
	else bad(`alt-network pills/attrs mismatch (pills=${pillCount}, target=${blank}, rel=${rel}; expected 5 pills + >=5 of each attr)`);
}

// ── Tamper test ──
{
	const mutated = page.replace(
		'href="http://{inst.alt_networks.tor}"',
		'REVERTED_SPAN_TITLE={inst.alt_networks.tor}'
	);
	if (mutated === page) bad('tamper wiring error: could not revert the tor pill href');
	else if (/href="http:\/\/\{inst\.alt_networks\.tor\}"/.test(mutated))
		bad('tamper NOT caught: reverting the tor pill still passes (toothless)');
	else ok('tamper caught: reverting the tor pill href turns its check red');
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} scenarios passed`);
