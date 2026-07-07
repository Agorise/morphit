/**
 * footer-alt-network-pills-gated-smoke — every alt-network footer pill is shown
 * ONLY when the operator has configured an address for that network.
 *
 * WHY (cp339): tor / lokinet / i2p_b32 / nostr previously rendered a greyed-out,
 * disabled "cursor-not-allowed" placeholder chip when unconfigured, advertising
 * networks the operator never set up (Ken had no lokinet/nostr address but the
 * pills still showed in the footer). All alt-network pills must be pure
 * {#if}-gated — like i2p_name and ens already were — so unconfigured networks
 * simply don't render.
 *
 * Also pins the ENS pill target: it links to the BARE registered name (e.g.
 * `morphit.eth`), NOT through a third-party gateway like eth.limo. Routing
 * users through a centralized resolver cuts against Morphit's
 * no-single-point-of-failure, privacy-first posture; ENS-aware browsers resolve
 * the bare name directly. The operator registered `morphit.eth` — nothing
 * `.limo`.
 *
 * Usage (from apps/web): tsx scripts/footer-alt-network-pills-gated-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const layout = readFileSync(
	join(import.meta.dirname, '..', 'src', 'routes', '[lang]', '+layout.svelte'),
	'utf-8'
);
const instances = readFileSync(
	join(import.meta.dirname, '..', 'src', 'routes', '[lang]', 'instances', '+page.svelte'),
	'utf-8'
);

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
	checks++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

console.log('\n── footer alt-network pills are gated, not disabled ───');

// No disabled-placeholder chips anywhere in the footer.
check('no cursor-not-allowed placeholder pills', !/cursor-not-allowed/.test(layout));
check('no aria-disabled placeholder pills', !/aria-disabled/.test(layout));
check(
	'the "alt_network_disabled" placeholder label is no longer rendered',
	!layout.includes('footer.alt_network_disabled')
);

// Every alt-network pill is wrapped in an {#if} configured-address gate.
for (const net of ['tor', 'lokinet', 'i2p_b32', 'i2p_name', 'nostr', 'ens']) {
	check(
		`${net} pill is {#if $instance.alt_networks.${net}}-gated`,
		new RegExp(`\\{#if \\$instance\\.alt_networks\\.${net}\\}`).test(layout)
	);
}

// ENS pill links to the bare registered name — no eth.limo (or any) gateway.
check(
	'footer ENS pill links to the bare ENS name',
	/href="https:\/\/\{\$instance\.alt_networks\.ens\}"/.test(layout)
);
check(
	'instances ENS pill links to the bare ENS name',
	/href="https:\/\/\{inst\.alt_networks\.ens\}"/.test(instances)
);
check('no .limo gateway in the footer', !/\.limo/.test(layout));
check('no .limo gateway on the instances page', !/\.limo/.test(instances));
check(
	'no ensEthLimoUrl gateway helper referenced',
	!/ensEthLimoUrl/.test(layout) && !/ensEthLimoUrl/.test(instances)
);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} footer-alt-network-pills-gated scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
