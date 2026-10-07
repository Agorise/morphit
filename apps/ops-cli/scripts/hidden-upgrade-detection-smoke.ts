/**
 * hidden-upgrade-detection-smoke (v1.16.6)
 *
 * A hidden-only (zero-clearnet) node MUST resolve its upgrade over Tor/I2P and
 * NEVER touch git.agorise.net / codeberg. The bug: the hidden-only detector read
 * `morphit.config.env`, but the RPC pool lives in `indexer.env`, so it never saw
 * the key, defaulted to clearnet, and fetched the upgrade over HTTPS — on
 * morphitlat, a hidden-only instance. This pins:
 *   1. the file heuristic keys off MORPHIT_INDEXER_RPC_ENDPOINTS (empty ⇒ hidden);
 *   2. the root-owned config decides (never an HTTP answer);
 *   3. the upgrade caller reads indexer.env (where the key actually is);
 *   4. gateway labels name the hidden service + network;
 *   5. the resolver reports "zero clearnet" and never a clearnet host.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import {
	isHiddenOnlyFromEnvFile,
	isHiddenOnly,
	hiddenGatewayLabel
} from '../src/init/hiddenUpgradeResolve.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const dir = mkdtempSync(join(tmpdir(), 'morphit-hid-detect-'));
const emptyPool = join(dir, 'indexer.empty.env');
const clearPool = join(dir, 'indexer.clear.env');
const noKey = join(dir, 'indexer.nokey.env');
writeFileSync(
	emptyPool,
	'FOO=bar\nMORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\n'
);
writeFileSync(clearPool, 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n');
writeFileSync(noKey, 'FOO=bar\n');

// 1. file heuristic
check('empty clearnet RPC pool ⇒ hidden-only', isHiddenOnlyFromEnvFile([emptyPool]) === true);
check(
	'populated clearnet RPC pool ⇒ NOT hidden-only',
	isHiddenOnlyFromEnvFile([clearPool]) === false
);
check('key absent ⇒ NOT hidden-only (safe default)', isHiddenOnlyFromEnvFile([noKey]) === false);

// 2. the ROOT-OWNED config decides — never an
// HTTP answer from whatever listens on port 8081 (it is not even asked when
// the config can be read; `verifyListener` records any attempt).
let asked = 0;
const neverAsk = {
	verifyListener: () => {
		asked++;
		return { kind: 'refused' as const, reason: 'test' };
	}
};
const hiddenFromConfig = await isHiddenOnly({
	...neverAsk,
	configEnvPaths: [emptyPool],
	unitEnvFiles: [emptyPool]
});
const clearFromConfig = await isHiddenOnly({
	...neverAsk,
	configEnvPaths: [clearPool],
	unitEnvFiles: [clearPool]
});
const noKeyFromConfig = await isHiddenOnly({
	...neverAsk,
	configEnvPaths: [noKey],
	unitEnvFiles: [noKey]
});
check('config: empty clearnet pool ⇒ hidden-only', hiddenFromConfig === true);
check('config: clearnet pool ⇒ NOT hidden-only', clearFromConfig === false);
check(
	'config: pool unset (built-in clearnet default) ⇒ NOT hidden-only',
	noKeyFromConfig === false
);
check('a readable config never asks the local indexer', asked === 0, `asked ${asked}×`);
// The unit's effective environment (last file wins) is read too: a hidden-only
// pool set in indexer.env after a clearnet one in morphit.env is hidden-only.
const hiddenLast = await isHiddenOnly({
	...neverAsk,
	configEnvPaths: [],
	unitEnvFiles: [clearPool, emptyPool]
});
check('effective env: a later empty pool overrides an earlier clearnet one', hiddenLast === true);

// 4. gateway labels
check(
	'onion gateway labelled Tor',
	/\(Tor\)$/.test(
		hiddenGatewayLabel('http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion')
	)
);
check(
	'i2p gateway labelled I2P',
	/\(I2P\)$/.test(
		hiddenGatewayLabel('http://4oymiquy7qobjgx36tejs35zeqt24qpemsnzgtfeswmrw6csxbkq.b32.i2p')
	)
);
check(
	'long onion host is truncated',
	hiddenGatewayLabel(
		'http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion'
	).includes('…')
);

// 3 + 5. structural: detector source + upgrade caller + reporting
const resolver = readFileSync(join(REPO, 'apps/ops-cli/src/init/hiddenUpgradeResolve.ts'), 'utf8');
const upgrade = readFileSync(join(REPO, 'apps/ops-cli/src/commands/upgrade.ts'), 'utf8');
check(
	'the file heuristic keys off MORPHIT_INDEXER_RPC_ENDPOINTS',
	/MORPHIT_INDEXER_RPC_ENDPOINTS/.test(resolver)
);
check(
	'upgrade caller reads indexer.env (the v1.16.6 fix)',
	/indexer\.env/.test(upgrade) && /configEnvPaths:/.test(upgrade)
);
check(
	'resolver reports the hidden gateway used',
	/hiddenGatewayLabel\(result\.peer\)/.test(resolver)
);
check(
	'resolver reads peer hidden addrs from alt_networks (v1.16.8)',
	/i\.alt_networks|an\.tor|an\.i2p_b32/.test(resolver)
);

// Offline and hidden upgrades verify against @morphit's SIGNED release record
// (behaviour: test/upgradeReleaseAnchor.test.ts); here only the wiring.
const payload = readFileSync(join(REPO, 'apps/indexer/scripts/release-build-payload.ts'), 'utf8');
check(
	'the trust gate accepts the signed on-chain SHA-256 as a trust path',
	/readSignedReleaseAnchor\(/.test(upgrade) && /onchain-anchored-sha256/.test(upgrade)
);
check(
	'the hidden resolver verifies the signed op, not /v1/release alone',
	/readSignedReleaseAnchor\(/.test(resolver)
);
check(
	'offline path picks offline_sha256 for a -offline bundle',
	/offline_sha256/.test(upgrade) && /-offline\\.tar\\.gz\$/.test(upgrade)
);
check(
	'the release payload emits offline_sha256',
	/offline_sha256/.test(payload) && /MORPHIT_BUILD_OFFLINE_SHA256/.test(payload)
);
check(
	'upgrade offline path seeds the BUNDLED canonical tarball (hidden nodes become seeders, v1.16.10)',
	/\.canonical-release/.test(upgrade) && /becomes a Tor\/I2P origin host/.test(upgrade)
);
check(
	'upgrade offline path still skips cleanly when no canonical tarball is bundled',
	/Skipping the IPFS self-seed/.test(upgrade) && /does not carry the canonical/.test(upgrade)
);
check(
	'upgrade re-execs the JUST-BUILT binary for self-heals (v1.16.11 — no more upgrade-twice)',
	/__post-upgrade-selfheal/.test(upgrade) && /selfHealReexeced/.test(upgrade)
);
// Since the final v1.18.0 review the heals run from ONE list, `runSelfHeals`
// (relay first, each isolated), shared by the re-exec'd binary and this fallback.
check(
	'upgrade falls back to in-process heals if the re-exec is unavailable',
	/if \(!selfHealReexeced\) \{[^}]*?\n\t\tawait runSelfHeals\(\);/.test(upgrade) &&
		/\(\) => startWebProxyHeals\(\)/.test(upgrade) &&
		/healBunkerWebWaf\(undefined, installBuildDir\(\)/.test(upgrade)
);
check(
	'v1.16.13: the self-heal phase rebuilds the frontend (nginx.conf change applies same-upgrade)',
	/healFrontendConfig\(\)/.test(upgrade)
);
check('resolver states "zero clearnet"', /zero clearnet/i.test(resolver));

console.log(
	fail === 0
		? `✓ all ${pass} hidden-upgrade-detection checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
