/**
 * install-summary-smoke.ts (cp631, expanded cp636) — pins the end-of-install
 * summary: the PURE renderer (✓/✗/? marks, alignment, dim value, detail only
 * when down) and collectInstallSummary driven with a MOCK probe. cp636 made the
 * summary COMPREHENSIVE + async (live indexer/relay /v1/health + on-chain relay
 * balance + FX feeds + IPFS/IPNS + MCP + system health + a roll-up over every
 * unit), so this exercises each new row's up/down/unknown logic without a live
 * box. allComponentsUp is the register gate: any DOWN (or still-unknown) piece
 * blocks it; a merely-catching-up indexer stays `active` and does NOT block.
 */
import {
	collectInstallSummary,
	renderInstallSummary,
	allComponentsUp,
	expectedUnits,
	type ComponentStatus,
	type SummaryProbe,
	type SummaryInputs,
	type IndexerHealth
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

const HEALTHY_INDEXER: IndexerHealth = { reachable: true, synced: true, rpcOk: true, fxOk: true };

/** A probe where every component reports UP / HEALTHY / funded. */
function allUpProbe(): SummaryProbe {
	return {
		serviceActive: () => true,
		failedUnits: () => [],
		containerRunning: () => true,
		firewallActive: () => true,
		pathExists: () => true,
		readText: (p) =>
			p.endsWith('/hostname')
				? 'testonionaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion'
				: p.endsWith('canary.txt')
					? 'Morphit warrant canary — valid_through 2099-12-31'
					: 'x',
		indexerHealth: async () => HEALTHY_INDEXER,
		relayReachable: async () => true,
		relayBalanceBlurt: async () => 2500, // ~25 signups
		systemHealth: () => ({ ok: true })
	};
}

const vpsInputs: SummaryInputs = { domain: 'trade.example.com', mode: 'vps', torOnly: false, enableBunkerweb: true, repoPath: '/opt/morphit', relayAccount: 'ex-relay' };
const homeInputs: SummaryInputs = { ...vpsInputs, mode: 'home' };
const find = (rows: readonly ComponentStatus[], re: RegExp): ComponentStatus | undefined => rows.find((r) => re.test(r.label));

async function main(): Promise<void> {
	console.log('\u2500\u2500 install-summary smoke (cp631/cp636) \u2500\u2500\u2500\u2500');

	const vpsRows = await collectInstallSummary(vpsInputs, allUpProbe());
	const homeRows = await collectInstallSummary(homeInputs, allUpProbe());
	const noBwRows = await collectInstallSummary({ ...vpsInputs, enableBunkerweb: false }, allUpProbe());

	// ── which components appear ─────────────────────────────────────
	check('vps: no dynamic-DNS row (home-only)', !find(vpsRows, /dynamic DNS/i));
	check('home: HAS a dynamic-DNS row', !!find(homeRows, /dynamic DNS/i));
	check('bunkerweb on: HAS Web firewall + Website rows', !!find(vpsRows, /BunkerWeb/i) && !!find(vpsRows, /Website/i));
	check('bunkerweb off: NO BunkerWeb/Website rows', !find(noBwRows, /BunkerWeb|Website/i));
	check(
		'covers EVERY subsystem on the operator list',
		[
			/PostgreSQL/i, /relay .*service/i, /relay .*responding/i, /indexer .*service/i, /indexer .*responding/i,
			/processing the chain/i, /Blurt RPC/i, /MCP server/i, /FX price feeds/i, /Verified relay balance/i,
			/HTTPS/i, /Firewall \(UFW\)/i, /fail2ban/i, /Tor onion/i, /I2P/i, /IPFS node/i, /release pinning/i,
			/IPNS/i, /canary/i, /PGP/i, /SEO/i, /Instance settings/i, /nightly backups/i,
			/System resources/i, /All services \+ timers/i
		].every((re) => !!find(vpsRows, re))
	);

	// ── canary / pgp / SEO probe the SERVED build dir under repoPath ─
	const builtProbe: SummaryProbe = { ...allUpProbe(), pathExists: (p) => p.startsWith('/srv/morphit/apps/web/build/'), readText: (p) => (p.startsWith('/srv/morphit/apps/web/build/') ? 'valid_through 2099-12-31' : null) };
	const builtRows = await collectInstallSummary({ ...vpsInputs, repoPath: '/srv/morphit' }, builtProbe);
	check('canary keys off {repoPath}/apps/web/build', find(builtRows, /canary/i)?.ok === true);
	check('pgp keys off {repoPath}/apps/web/build', find(builtRows, /PGP/i)?.ok === true);
	check('SEO keys off {repoPath}/apps/web/build', find(builtRows, /SEO/i)?.ok === true);

	// ── privacy networks ───────────────────────────────────────────
	const torFileMissing: SummaryProbe = { ...allUpProbe(), readText: (p) => (/\/var\/lib\/tor\/morphit\/hostname$/.test(p) ? null : 'x') };
	check('Tor onion is \u2717 when the hostname file is absent', find(await collectInstallSummary(vpsInputs, torFileMissing), /Tor onion/i)?.ok === false);
	check('Tor onion shows the .onion as its value', /\.onion$/.test(find(vpsRows, /Tor onion/i)?.value ?? ''));
	const i2pDown: SummaryProbe = { ...allUpProbe(), serviceActive: (u) => u !== 'i2pd' };
	check('I2P is \u2717 when i2pd is down', find(await collectInstallSummary(vpsInputs, i2pDown), /I2P/i)?.ok === false);

	// ── distribution: IPFS / IPNS ──────────────────────────────────
	const ipfsDown: SummaryProbe = { ...allUpProbe(), serviceActive: (u) => u !== 'ipfs.service' };
	check('IPFS node is \u2717 when the Kubo daemon is down', find(await collectInstallSummary(vpsInputs, ipfsDown), /IPFS node/i)?.ok === false);
	const pinDown: SummaryProbe = { ...allUpProbe(), serviceActive: (u) => u !== 'morphit-ipfs-pin.timer' };
	check('release-pinning is \u2717 when the pin timer is down', find(await collectInstallSummary(vpsInputs, pinDown), /release pinning/i)?.ok === false);

	// ── MCP ─────────────────────────────────────────────────────────
	const mcpDown: SummaryProbe = { ...allUpProbe(), serviceActive: (u) => u !== 'morphit-mcp.service' };
	check('MCP is \u2717 when morphit-mcp is down', find(await collectInstallSummary(vpsInputs, mcpDown), /MCP server/i)?.ok === false);

	// ── economics: FX + on-chain relay balance ─────────────────────
	const fxDown: SummaryProbe = { ...allUpProbe(), indexerHealth: async () => ({ ...HEALTHY_INDEXER, fxOk: false }) };
	check('FX row is \u2717 when price feeds are unhealthy', find(await collectInstallSummary(vpsInputs, fxDown), /FX price/i)?.ok === false);
	const idxUnreachable: SummaryProbe = { ...allUpProbe(), indexerHealth: async () => ({ reachable: false, synced: null, rpcOk: null, fxOk: null }) };
	const unreachRows = await collectInstallSummary(vpsInputs, idxUnreachable);
	check('indexer-unreachable → responding row is ? (not ✗)', find(unreachRows, /indexer .*responding/i)?.ok === null);
	check('indexer-unreachable → FX row is ? (not ✗)', find(unreachRows, /FX price/i)?.ok === null);
	check('warming indexer (HTTP not up yet) does NOT block announce', allComponentsUp(unreachRows) === true);
	const lowBal: SummaryProbe = { ...allUpProbe(), relayBalanceBlurt: async () => 50 }; // < 100 = under one signup
	check('relay balance \u2717 when under one signup', find(await collectInstallSummary(vpsInputs, lowBal), /Verified relay balance/i)?.ok === false);
	const noBal: SummaryProbe = { ...allUpProbe(), relayBalanceBlurt: async () => null };
	check('relay balance ? when RPC unreachable', find(await collectInstallSummary(vpsInputs, noBal), /Verified relay balance/i)?.ok === null);
	check('relay balance shows BLURT + signup estimate as value', /BLURT.*signup/i.test(find(vpsRows, /Verified relay balance/i)?.value ?? ''));

	// ── system health + the all-units roll-up ──────────────────────
	const sysBad: SummaryProbe = { ...allUpProbe(), systemHealth: () => ({ ok: false, detail: 'low disk (<1 GB free)' }) };
	check('system resources \u2717 on low disk/memory', find(await collectInstallSummary(vpsInputs, sysBad), /System resources/i)?.ok === false);
	const oneFailed: SummaryProbe = { ...allUpProbe(), failedUnits: (u) => u.filter((x) => x === 'tor') };
	const oneFailedRows = await collectInstallSummary(vpsInputs, oneFailed);
	check('all-units roll-up \u2717 lists the not-active unit', find(oneFailedRows, /All services \+ timers/i)?.ok === false && /tor/.test(find(oneFailedRows, /All services \+ timers/i)?.detail ?? ''));
	check('expectedUnits(home) includes ddns; vps does not', expectedUnits(homeInputs).includes('morphit-ddns.timer') && !expectedUnits(vpsInputs).includes('morphit-ddns.timer'));
	check('expectedUnits covers core services (relay/indexer/mcp/ipfs)', ['morphit-relay.service', 'morphit-indexer.service', 'morphit-mcp.service', 'ipfs.service'].every((u) => expectedUnits(vpsInputs).includes(u)) && !expectedUnits({ ...vpsInputs, contactConfigured: true }).includes('morphit-matrix-bot.service'));

	// ── Matrix contact link (only when configured; the bot is a separate opt-in) ──
	check('no Matrix contact row when not configured', !find(vpsRows, /Contact link \(Matrix\)/i));
	const withContact = await collectInstallSummary({ ...vpsInputs, contactConfigured: true }, allUpProbe());
	check('Matrix contact link present + \u2713 when configured', find(withContact, /Contact link \(Matrix\)/i)?.ok === true);

	// ── HTTPS keyed off the domain ─────────────────────────────────
	const domainProbe: SummaryProbe = { ...allUpProbe(), pathExists: (p) => p.includes('x.example.org') };
	check('HTTPS cert keys off the domain path', find(await collectInstallSummary({ ...vpsInputs, domain: 'x.example.org' }, domainProbe), /HTTPS/i)?.ok === true);

	// ── allComponentsUp: the register gate ─────────────────────────
	check('allComponentsUp: TRUE when every probe is up/healthy/funded', allComponentsUp(vpsRows) === true);
	check('contact configured does not block register', allComponentsUp(withContact) === true);
	const idxSvcDown: SummaryProbe = { ...allUpProbe(), serviceActive: (u) => !/morphit-indexer/.test(u) };
	const idxSvcDownRows = await collectInstallSummary(vpsInputs, idxSvcDown);
	check('allComponentsUp: FALSE when the indexer service is down', allComponentsUp(idxSvcDownRows) === false);
	const catchingUp = await collectInstallSummary(vpsInputs, { ...allUpProbe(), indexerHealth: async () => ({ ...HEALTHY_INDEXER, synced: false }) });
	check('catching-up indexer (synced=false) does NOT block register', allComponentsUp(catchingUp) === true);
	check('catching-up indexer shows the sync state as its value', /catching up/i.test(find(catchingUp, /processing the chain/i)?.value ?? ''));
	check('allComponentsUp: FALSE when HTTPS cert missing', allComponentsUp(await collectInstallSummary(vpsInputs, { ...allUpProbe(), pathExists: () => false, readText: () => null })) === false);
	check('allComponentsUp: FALSE when firewall inactive', allComponentsUp(await collectInstallSummary(vpsInputs, { ...allUpProbe(), firewallActive: () => false })) === false);
	check('allComponentsUp: FALSE when relay balance is zero-ish', allComponentsUp(await collectInstallSummary(vpsInputs, lowBal)) === false);

	// ── renderInstallSummary: pure formatting ──────────────────────
	const sample: ComponentStatus[] = [
		{ label: 'Alpha', ok: true, value: '2500 BLURT' },
		{ label: 'Beta', ok: false, detail: 'still starting' },
		{ label: 'Gamma', ok: null, detail: 'unknown' }
	];
	const rendered = renderInstallSummary(sample);
	check('render: \u2713 up, \u2717 down, ? unknown', /\u2713\s+Alpha/.test(rendered) && /\u2717\s+Beta/.test(rendered) && /\?\s+Gamma/.test(rendered));
	check('render: value shown ALWAYS (even on an up row)', /Alpha.*2500 BLURT/.test(rendered));
	check('render: detail shown for a DOWN row', /Beta.*still starting/.test(rendered));
	check('render: NO detail parens on an UP row', !/Alpha\s+\(/.test(rendered));
	check('render: one line per row', rendered.split('\n').length === sample.length);
	const painted = renderInstallSummary(sample, { color: true });
	check('render(color): \u2713 bold-green ANSI', painted.includes('\u001b[1;32m\u2713\u001b[0m'));
	check('render(default): NO ANSI escapes', !rendered.includes('\u001b['));
}

main()
	.then(() => {
		console.log('');
		if (failed === 0) {
			console.log(`\u2713 all ${passed} install-summary checks passed`);
			process.exit(0);
		} else {
			console.log(`\u2717 ${failed} of ${passed + failed} install-summary checks failed`);
			process.exit(1);
		}
	})
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
