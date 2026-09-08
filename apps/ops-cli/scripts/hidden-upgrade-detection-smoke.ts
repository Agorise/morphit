/**
 * hidden-upgrade-detection-smoke (v1.16.6)
 *
 * A hidden-only (zero-clearnet) node MUST resolve its upgrade over Tor/I2P and
 * NEVER touch git.agorise.net / codeberg. The bug: the hidden-only detector read
 * `morphit.config.env`, but the RPC pool lives in `indexer.env`, so it never saw
 * the key, defaulted to clearnet, and fetched the upgrade over HTTPS — on
 * morphitlat, a hidden-only instance. This pins:
 *   1. the file heuristic keys off MORPHIT_INDEXER_RPC_ENDPOINTS (empty ⇒ hidden);
 *   2. the detector prefers the indexer's clearnet_eliminated, falling back to
 *      the file only when the indexer is unreachable;
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
writeFileSync(emptyPool, 'FOO=bar\nMORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://x.onion\n');
writeFileSync(clearPool, 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.blurt.world\n');
writeFileSync(noKey, 'FOO=bar\n');

// 1. file heuristic
check('empty clearnet RPC pool ⇒ hidden-only', isHiddenOnlyFromEnvFile([emptyPool]) === true);
check('populated clearnet RPC pool ⇒ NOT hidden-only', isHiddenOnlyFromEnvFile([clearPool]) === false);
check('key absent ⇒ NOT hidden-only (safe default)', isHiddenOnlyFromEnvFile([noKey]) === false);

// 2. authoritative detector falls back to the file when the indexer is unreachable
const dead = ['http://127.0.0.1:1']; // nothing listens
const hiddenViaFallback = await isHiddenOnly(dead, [emptyPool]);
const clearViaFallback = await isHiddenOnly(dead, [clearPool]);
check('indexer unreachable + empty pool ⇒ hidden-only (fallback)', hiddenViaFallback === true);
check('indexer unreachable + clearnet pool ⇒ NOT hidden-only (fallback)', clearViaFallback === false);

// 4. gateway labels
check('onion gateway labelled Tor', /\(Tor\)$/.test(hiddenGatewayLabel('http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion')));
check('i2p gateway labelled I2P', /\(I2P\)$/.test(hiddenGatewayLabel('http://4oymiquy7qobjgx36tejs35zeqt24qpemsnzgtfeswmrw6csxbkq.b32.i2p')));
check('long onion host is truncated', hiddenGatewayLabel('http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion').includes('…'));

// 3 + 5. structural: detector source + upgrade caller + reporting
const resolver = readFileSync(join(REPO, 'apps/ops-cli/src/init/hiddenUpgradeResolve.ts'), 'utf8');
const upgrade = readFileSync(join(REPO, 'apps/ops-cli/src/commands/upgrade.ts'), 'utf8');
check('detector prefers the indexer /v1/instance clearnet_eliminated', /\/v1\/instance/.test(resolver) && /clearnet_eliminated/.test(resolver));
check('the file heuristic keys off MORPHIT_INDEXER_RPC_ENDPOINTS', /MORPHIT_INDEXER_RPC_ENDPOINTS/.test(resolver));
check('upgrade caller reads indexer.env (the v1.16.6 fix)', /indexer\.env/.test(upgrade) && /configEnvPaths:/.test(upgrade));
check('resolver reports the hidden gateway used', /hiddenGatewayLabel\(result\.peer\)/.test(resolver));
check('resolver reads peer hidden addrs from alt_networks (v1.16.8)', /i\.alt_networks|an\.tor|an\.i2p_b32/.test(resolver));

// v1.16.9 — offline upgrade verifies against the on-chain SHA (no hand-signed .asc)
const payload = readFileSync(join(REPO, 'apps/indexer/scripts/release-build-payload.ts'), 'utf8');
check('decideTrust accepts an on-chain-anchored SHA-256 as a trust path', /hashFromChain/.test(upgrade) && /onchain-anchored-sha256/.test(upgrade));
check('offline path reads the on-chain SHA from the local indexer', /readOnchainReleaseSha\(/.test(upgrade) && /\/v1\/release/.test(upgrade));
check('offline path picks offline_sha256 for a -offline bundle', /offline_sha256/.test(upgrade) && /-offline\\.tar\\.gz\$/.test(upgrade));
check('the release payload emits offline_sha256', /offline_sha256/.test(payload) && /MORPHIT_BUILD_OFFLINE_SHA256/.test(payload));
check('upgrade offline path seeds the BUNDLED canonical tarball (hidden nodes become seeders, v1.16.10)', /\.canonical-release/.test(upgrade) && /becomes a Tor\/I2P origin host/.test(upgrade));
check('upgrade offline path still skips cleanly when no canonical tarball is bundled', /Skipping the IPFS self-seed/.test(upgrade) && /does not carry the canonical/.test(upgrade));
check('upgrade re-execs the JUST-BUILT binary for self-heals (v1.16.11 — no more upgrade-twice)', /__post-upgrade-selfheal/.test(upgrade) && /selfHealReexeced/.test(upgrade));
check('upgrade falls back to in-process heals if the re-exec is unavailable', /if \(!selfHealReexeced\)/.test(upgrade) && /healBunkerWebWaf\(\);/.test(upgrade));
check('v1.16.13: the self-heal phase rebuilds the frontend (nginx.conf change applies same-upgrade)', /healFrontendConfig\(\)/.test(upgrade));
check('resolver states "zero clearnet"', /zero clearnet/i.test(resolver));

console.log(fail === 0 ? `✓ all ${pass} hidden-upgrade-detection checks hold` : `✗ ${fail} failed (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
