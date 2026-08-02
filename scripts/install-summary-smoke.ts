/**
 * install-summary-smoke.ts (cp631) — pins the end-of-install summary: the PURE
 * renderer (✓/✗/? marks, alignment, detail shown only when a component is down)
 * and collectInstallSummary driven with a MOCK probe (home vs vps, BunkerWeb
 * on/off), plus allComponentsUp — the gate the wizard uses before offering to
 * register. A DOWN component (including a not-running indexer) MUST block it; an
 * indexer that is merely catching up is still `active`, so it does NOT block.
 */
import {
	collectInstallSummary,
	renderInstallSummary,
	allComponentsUp,
	type ComponentStatus,
	type SummaryProbe,
	type SummaryInputs
} from '../apps/ops-cli/src/init/installSummary.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

/** A probe where every component reports UP. */
function allUpProbe(): SummaryProbe {
	return {
		serviceActive: () => true,
		containerRunning: () => true,
		firewallActive: () => true,
		pathExists: () => true
	};
}

function main(): void {
	console.log('\u2500\u2500 install-summary smoke (cp631) \u2500\u2500\u2500\u2500');

	const vpsInputs: SummaryInputs = { domain: 'trade.example.com', mode: 'vps', enableBunkerweb: true, repoPath: '/opt/morphit' };
	const homeInputs: SummaryInputs = { domain: 'trade.example.com', mode: 'home', enableBunkerweb: true, repoPath: '/opt/morphit' };

	// ── collectInstallSummary: which components appear ──────────────
	const vpsRows = collectInstallSummary(vpsInputs, allUpProbe());
	const homeRows = collectInstallSummary(homeInputs, allUpProbe());
	const noBwRows = collectInstallSummary({ ...vpsInputs, enableBunkerweb: false }, allUpProbe());

	check('vps: no dynamic-DNS row (home-only)', !vpsRows.some((r) => /dynamic DNS/i.test(r.label)));
	check('home: HAS a dynamic-DNS row', homeRows.some((r) => /dynamic DNS/i.test(r.label)));
	check('bunkerweb on: HAS Web firewall + Website rows', vpsRows.some((r) => /BunkerWeb/i.test(r.label)) && vpsRows.some((r) => /Website/i.test(r.label)));
	check('bunkerweb off: NO BunkerWeb/Website rows', !noBwRows.some((r) => /BunkerWeb|Website/i.test(r.label)));
	check(
		'always includes DB, relay, indexer, backups, HTTPS, hardening',
		['PostgreSQL', 'relay', 'indexer', 'backups', 'HTTPS', 'hardening'].every((needle) =>
			vpsRows.some((r) => new RegExp(needle, 'i').test(r.label))
		)
	);
	check(
		'always includes Tor onion, I2P, warrant canary, PGP key rows',
		['Tor onion', 'I2P address', 'Warrant canary', 'PGP contact key'].every((needle) =>
			vpsRows.some((r) => r.label.includes(needle))
		)
	);
	// Canary + PGP probe the SERVED build dir under repoPath (that is what
	// "posted on the website" means — BunkerWeb mounts it as the site root).
	const builtProbe: SummaryProbe = { ...allUpProbe(), pathExists: (p) => p.startsWith('/srv/morphit/apps/web/build/') };
	const builtRows = collectInstallSummary({ ...vpsInputs, repoPath: '/srv/morphit' }, builtProbe);
	check('canary row keys off {repoPath}/apps/web/build', builtRows.find((r) => /canary/i.test(r.label))?.ok === true);
	check('pgp row keys off {repoPath}/apps/web/build', builtRows.find((r) => /PGP/i.test(r.label))?.ok === true);
	// Onion "created" needs BOTH the daemon up AND the hostname file present.
	const torFileMissing: SummaryProbe = { ...allUpProbe(), pathExists: (p) => !/\/var\/lib\/tor\/morphit\/hostname$/.test(p) };
	check('Tor onion row is \u2717 when the hostname file is absent', collectInstallSummary(vpsInputs, torFileMissing).find((r) => /Tor onion/i.test(r.label))?.ok === false);
	const i2pDown: SummaryProbe = { ...allUpProbe(), serviceActive: (u) => u !== 'i2pd' };
	check('I2P row is \u2717 when i2pd is down', collectInstallSummary(vpsInputs, i2pDown).find((r) => /I2P/i.test(r.label))?.ok === false);
	// Contact (Matrix) row appears ONLY when a contact address was given, and is
	// never a ✗ when absent (having none is fine).
	check('no Contact row when contactConfigured is absent', !vpsRows.some((r) => /Contact link/i.test(r.label)));
	const withContact = collectInstallSummary({ ...vpsInputs, contactConfigured: true }, allUpProbe());
	check('Contact (Matrix) row present + \u2713 when configured', withContact.find((r) => /Contact link/i.test(r.label))?.ok === true);
	check('contactConfigured row does not block register', allComponentsUp(withContact) === true);
	check('HTTPS cert row keys off the domain path', collectInstallSummary({ ...vpsInputs, domain: 'x.example.org' }, { ...allUpProbe(), pathExists: (p) => p.includes('x.example.org') }).find((r) => /HTTPS/i.test(r.label))?.ok === true);

	// ── allComponentsUp: the register gate ─────────────────────────
	check('allComponentsUp: TRUE when every probe is up', allComponentsUp(vpsRows) === true);

	// Indexer service down → NOT all up (Ken: a not-running indexer is not green).
	const indexerDownProbe: SummaryProbe = { ...allUpProbe(), serviceActive: (u) => !/indexer/.test(u) };
	const indexerDownRows = collectInstallSummary(vpsInputs, indexerDownProbe);
	check('allComponentsUp: FALSE when the indexer service is down', allComponentsUp(indexerDownRows) === false);
	check('indexer-down: the indexer row is the \u2717 one', indexerDownRows.some((r) => /indexer/i.test(r.label) && r.ok === false));

	// A catching-up indexer is still `active` → the probe returns true → all up.
	// (There is no "catching up" probe signal; service-active IS the green test,
	// which is exactly why a syncing indexer does not block register.)
	check('catching-up indexer (service active) does NOT block register', allComponentsUp(collectInstallSummary(vpsInputs, allUpProbe())) === true);

	// HTTPS cert missing → not all up.
	const noCertProbe: SummaryProbe = { ...allUpProbe(), pathExists: () => false };
	check('allComponentsUp: FALSE when the HTTPS cert is missing', allComponentsUp(collectInstallSummary(vpsInputs, noCertProbe)) === false);

	// Firewall inactive → hardening row down → not all up.
	const noFwProbe: SummaryProbe = { ...allUpProbe(), firewallActive: () => false };
	check('allComponentsUp: FALSE when the firewall is inactive', allComponentsUp(collectInstallSummary(vpsInputs, noFwProbe)) === false);

	// ── renderInstallSummary: pure formatting ──────────────────────
	const sample: ComponentStatus[] = [
		{ label: 'Alpha', ok: true },
		{ label: 'Beta', ok: false, detail: 'still starting' },
		{ label: 'Gamma', ok: null, detail: 'unknown' }
	];
	const rendered = renderInstallSummary(sample);
	check('render: \u2713 for up, \u2717 for down, ? for unknown', /\u2713\s+Alpha/.test(rendered) && /\u2717\s+Beta/.test(rendered) && /\?\s+Gamma/.test(rendered));
	check('render: detail shown for a DOWN row', /Beta.*still starting/.test(rendered));
	check('render: detail shown for an UNKNOWN row', /Gamma.*unknown/.test(rendered));
	check('render: NO detail parens on an UP row', !/Alpha\s+\(/.test(rendered));
	check('render: one line per row', rendered.split('\n').length === sample.length);
	// Colour: the printed summary paints marks bold; the default render is plain.
	const painted = renderInstallSummary(sample, { color: true });
	check('render(color): \u2713 wrapped in bold-green ANSI', painted.includes('\u001b[1;32m\u2713\u001b[0m'));
	check('render(color): \u2717 wrapped in bold-red ANSI', painted.includes('\u001b[1;31m\u2717\u001b[0m'));
	check('render(default): NO ANSI escapes', !rendered.includes('\u001b['));
}

main();
console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} install-summary checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} install-summary checks failed`);
	process.exit(1);
}
