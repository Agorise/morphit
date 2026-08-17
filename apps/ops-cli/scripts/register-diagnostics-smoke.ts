/**
 * ops-cli register-diagnostics smoke (cp178).
 *
 * Covers the operator-UX fixes shipped in cp178:
 *   1. classifyChainError maps representative error strings to the
 *      right kind (a fee / insufficient-balance shortfall — and any
 *      leftover Steem-lineage "mana"/"rc" daemon wording — → the
 *      insufficient_fee kind, since Blurt pays a per-op FEE from
 *      liquid BLURT and does NOT gate on mana/RC).
 *   2. printChainErrorHelp emits the right specific guidance per
 *      kind: the fee branch talks about a per-op fee + keeping liquid
 *      BLURT (never mana/RC or "power up for headroom"), and it never
 *      tells the operator to merely reinstall for dependency_unevaluable.
 *   3. maskWif reveals only a short fingerprint and never the whole
 *      key.
 *   4. tagFromOrigin derives a clean domain tag (the wizard's new
 *      default) and isReservedTag still rejects the canonical names.
 *
 * Pure in-process assertions; no network, no DB, no spawned bundle.
 */

import { classifyChainError, printChainErrorHelp } from '../src/commands/chainErrors.ts';
import { maskWif } from '../src/commands/showKey.ts';
import { tagFromOrigin } from '../src/init/steps.ts';
import { isReservedTag } from '../../indexer/src/indexer/confusables.ts';

interface Scenario {
	name: string;
	run(): string | null;
}

const scenarios: Scenario[] = [];

// ─── 1. classification ───
const classifyCases: Array<[string, string]> = [
	['Dynamic require of "stream" is not supported', 'dependency_unevaluable'],
	['@beblurt/dblurt is not installed.', 'dependency_unevaluable'],
	['could not load the Blurt broadcast library: Cannot find package x', 'dependency_unevaluable'],
	['ERR_MODULE_NOT_FOUND', 'dependency_unevaluable'],
	['assert_exception: tag_reserved', 'tag_reserved'],
	['tag already taken', 'tag_taken'],
	['tag_already_claimed', 'tag_taken'],
	['tag_too_short', 'invalid_tag'],
	['tag_invalid_chars', 'invalid_tag'],
	['display_name_impersonates_reserved', 'invalid_display_name'],
	['display_name_too_long', 'invalid_display_name'],
	['origin_loopback', 'invalid_origin'],
	['origin_private', 'invalid_origin'],
	['origin_has_path', 'invalid_origin'],
	['contact_url_bad_scheme', 'invalid_origin'],
	['account_already_registered', 'already_registered'],
	['already registered', 'already_registered'],
	['private key network id mismatch', 'key_mismatch'],
	['missing required posting authority bob', 'key_mismatch'],
	['signature verification failed', 'key_mismatch'],
	['account bob does not have sufficient funds', 'insufficient_fee'],
	['insufficient balance to pay the operation fee', 'insufficient_fee'],
	['not enough balance for fee', 'insufficient_fee'],
	['transaction has insufficient mana', 'insufficient_fee'],
	['Account bob does not have enough mana', 'insufficient_fee'],
	['not enough rc', 'insufficient_fee'],
	['resource credit exhausted', 'insufficient_fee'],
	['all Blurt RPC endpoints rejected the broadcast. Last error: x', 'rpc_unreachable'],
	['ECONNREFUSED 1.2.3.4:443', 'rpc_unreachable'],
	['fetch failed', 'rpc_unreachable'],
	['a brand new unrecognized failure', 'unknown']
];
for (const [msg, want] of classifyCases) {
	scenarios.push({
		name: `classify: ${JSON.stringify(msg).slice(0, 48)} → ${want}`,
		run() {
			const got = classifyChainError(msg);
			return got === want ? null : `got ${got}, want ${want}`;
		}
	});
}

// ─── 2. guidance text ───
function capture(raw: string, ctxOverrides: Partial<Parameters<typeof printChainErrorHelp>[1]> = {}): string {
	const lines: string[] = [];
	printChainErrorHelp(
		raw,
		{
			opLabel: 'morphit_operator_register_v1',
			account: 'bob-exchange',
			tag: 'bob-exchange.com',
			keyFile: '/etc/morphit/active.key',
			nameEnvVar: 'MORPHIT_INSTANCE_OPERATOR_TAG',
			...ctxOverrides
		},
		(l) => lines.push(l)
	);
	return lines.join('\n');
}

scenarios.push({
	name: 'fee branch uses Blurt op-fee/liquid-BLURT model, never mana/RC or power-up advice',
	run() {
		const t = capture('insufficient balance to pay the operation fee');
		if (!/fee/i.test(t)) return 'expected the fee to be named';
		if (!/liquid BLURT/i.test(t)) return 'should tell operator to keep liquid BLURT';
		// The corrected guidance's whole point is to DISCLAIM the Hive/Steem
		// model ("do NOT power up"), so we don't forbid the word "power" — we
		// forbid the WRONG framings and require the disclaimer.
		if (/resource credit|\(RC\)| RC /i.test(t)) return 'must not say RC / resource credits';
		if (/regenerate|recharge/i.test(t)) return 'must not tell operator to wait for mana to recharge';
		if (!/do NOT power|does NOT help/i.test(t))
			return 'should clarify that powering up is NOT the fix';
		return null;
	}
});

scenarios.push({
	name: 'legacy "mana" daemon wording still classifies + routes to the fee guidance',
	run() {
		const t = capture('transaction has insufficient mana');
		if (!/fee/i.test(t)) return 'should route to the fee guidance';
		if (!/liquid BLURT/i.test(t)) return 'should mention liquid BLURT';
		return null;
	}
});

scenarios.push({
	name: 'dependency_unevaluable does NOT just say reinstall; flags it as a bug',
	run() {
		const t = capture('Dynamic require of "stream" is not supported');
		if (/run `?npm install`? from the repo root first/i.test(t))
			return 'must not present bare reinstall as the fix';
		if (!/rebuild|report it|packaging bug/i.test(t))
			return 'should advise rebuild / report as a packaging bug';
		return null;
	}
});

scenarios.push({
	name: 'tag_reserved names the tag and says project-reserved (not "claimed")',
	run() {
		const t = capture('assert_exception: tag_reserved', { tag: 'morphit' });
		if (!/reserved/i.test(t)) return 'should say reserved';
		if (!/morphit/.test(t)) return 'should name the tag';
		return null;
	}
});

scenarios.push({
	name: 'invalid_origin explains loopback/private origins are rejected, points at edit',
	run() {
		const t = capture('origin_loopback');
		if (!/loopback|private|localhost|127\.0\.0\.1|LAN/i.test(t)) return 'should explain the private/loopback rule';
		if (!/edit/.test(t)) return 'should point at `morphit-ops edit`';
		return null;
	}
});

scenarios.push({
	name: 'invalid_display_name explains impersonation rejection, points at edit',
	run() {
		const t = capture('display_name_impersonates_reserved');
		if (!/reserved|impersonat/i.test(t)) return 'should explain reserved-name impersonation';
		if (!/edit/.test(t)) return 'should point at `morphit-ops edit`';
		return null;
	}
});

scenarios.push({
	name: 'key_mismatch points operator at show-key (public-key compare)',
	run() {
		const t = capture('private key network id mismatch');
		if (!/show-key/.test(t)) return 'should suggest `morphit-ops show-key`';
		if (!/public key/i.test(t)) return 'should mention comparing the public key';
		return null;
	}
});

scenarios.push({
	name: 'every kind returns the matching ChainErrorKind from printChainErrorHelp',
	run() {
		const k = printChainErrorHelp(
			'transaction has insufficient mana',
			{
				opLabel: 'x',
				account: 'a',
				tag: null,
				keyFile: '/k',
				nameEnvVar: 'X'
			},
			() => {}
		);
		return k === 'insufficient_fee' ? null : `returned ${k}`;
	}
});

// ─── 3. maskWif ───
const sampleWif = '5JcswyABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnpBme';
scenarios.push({
	name: 'maskWif reveals only first 6 + last 4, never the whole key',
	run() {
		const m = maskWif(sampleWif);
		if (m.includes(sampleWif)) return 'must not contain the full WIF';
		if (!m.startsWith('5Jcswy')) return 'should start with first 6 chars';
		if (!m.endsWith('pBme')) return 'should end with last 4 chars';
		if (m.replace(/…/g, '').length > 10) return 'should expose at most 10 chars';
		return null;
	}
});
scenarios.push({
	name: 'maskWif on a pathologically short string does not echo a near-complete secret',
	run() {
		const m = maskWif('5Jabc');
		return m.length <= 3 ? null : `exposed too much: ${m}`;
	}
});

// ─── 4. tagFromOrigin + reserved ───
const tagCases: Array<[string, string]> = [
	['https://morphit.io', 'morphit.io'],
	['https://www.bob-exchange.com', 'bob-exchange.com'],
	['https://Sub.Domain.Example.COM/path?x=1', 'sub.domain.example.com'],
	['http://node1.alice.net', 'node1.alice.net'],
	['not-a-url', 'not-a-url']
];
for (const [origin, want] of tagCases) {
	scenarios.push({
		name: `tagFromOrigin(${origin}) → ${want}`,
		run() {
			const got = tagFromOrigin(origin);
			return got === want ? null : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
		}
	});
}
scenarios.push({
	name: 'reserved canonical names still rejected (wizard + register guard)',
	run() {
		for (const r of ['morphit', 'morphit-relay', 'agorise', 'MORPHIT']) {
			if (!isReservedTag(r)) return `${r} should be reserved`;
		}
		if (isReservedTag('morphit.io')) return 'morphit.io must NOT be reserved (only bare morphit)';
		if (isReservedTag('bob-exchange.com')) return 'a normal domain tag must not be reserved';
		return null;
	}
});

// ─── 4. cp182 — broadcast output hygiene ───
// Two operator-visible bugs in the broadcast path:
//   (a) "Block: undefined" — code printed result.block_num, but
//       blurtd's async broadcast_transaction returns no block (the
//       TransactionConfirmation is { id, ...errorFields }).
//   (b) dblurt's unconditional console.error("Didn't failover for
//       error …: [HTTP 429 …]") leaked to stdout next to the success
//       banner, because dblurt only fails over on timeout-class
//       errors and OUR loop does the real failover on a 429.
// These check the source-level invariants that fix both (the live
// broadcast itself needs a chain, which the sandbox can't do).
import { readFileSync as _readFileSync } from 'node:fs';
import { fileURLToPath as _fileURLToPath } from 'node:url';
import { dirname as _dirname, join as _join } from 'node:path';
const _here = _dirname(_fileURLToPath(import.meta.url));
const _opsSrc = _join(_here, '..', 'src', 'commands');
const _read = (rel: string): string => _readFileSync(_join(_opsSrc, rel), 'utf-8');

scenarios.push({
	name: 'cp182: broadcastCustomJson is the single shared broadcast helper (exported from chainErrors)',
	run() {
		const ce = _read('chainErrors.ts');
		if (!/export async function broadcastCustomJson/.test(ce))
			return 'chainErrors.ts must export broadcastCustomJson';
		// Both command files should call it, not roll their own client loop.
		const reg = _read('register.ts');
		const pm = _read('paymentMethod.ts');
		if (!reg.includes('broadcastCustomJson(')) return 'register.ts must use broadcastCustomJson';
		if (!pm.includes('broadcastCustomJson(')) return 'paymentMethod.ts must use broadcastCustomJson';
		if (/async function broadcastRegister/.test(reg))
			return 'register.ts must NOT keep a private broadcastRegister (use the shared helper)';
		if (/async function broadcastPaymentMethod/.test(pm))
			return 'paymentMethod.ts must NOT keep a private broadcastPaymentMethod';
		return null;
	}
});

scenarios.push({
	name: 'register broadcast is timeout-guarded (offline fails in 30s, never hangs)',
	run() {
		const reg = _read('register.ts');
		if (!/Promise\.race\(/.test(reg))
			return 'register.ts must wrap the broadcast in Promise.race for a timeout';
		if (!/setTimeout\(/.test(reg) || !/15_000/.test(reg))
			return 'register.ts broadcast timeout must be a 15_000ms setTimeout';
		if (!/Timed out reaching a Blurt RPC/.test(reg))
			return 'register.ts must give a clear offline timeout message';
		return null;
	}
});

scenarios.push({
	name: 'cp182: no command prints a block number (async broadcast returns none)',
	run() {
		for (const f of ['register.ts', 'paymentMethod.ts']) {
			const src = _read(f);
			if (/block_num/.test(src)) return `${f} still references block_num (always undefined here)`;
			if (/Posted in block|Block:\s{2,}/.test(src)) return `${f} still prints a block line`;
		}
		// And the helper's return type must be trx-id-only.
		const ce = _read('chainErrors.ts');
		if (/Promise<\{\s*id:\s*string\s*\}>/.test(ce) === false)
			return 'broadcastCustomJson sendOperations type should resolve { id: string } (no block_num)';
		return null;
	}
});

scenarios.push({
	name: 'cp182: dblurt console chatter is buffered during broadcast and consoleOnFailover is off',
	run() {
		const ce = _read('chainErrors.ts');
		// The buffering mechanism: save + restore console.log/error around the loop.
		if (!ce.includes('const realConsoleLog = console.log'))
			return 'helper must capture console.log';
		if (!ce.includes('const realConsoleError = console.error'))
			return 'helper must capture console.error';
		if (!/finally\s*\{[\s\S]*console\.log = realConsoleLog[\s\S]*console\.error = realConsoleError/.test(ce))
			return 'helper must restore console.log/error in a finally block';
		if (!ce.includes('consoleOnFailover: false'))
			return 'helper must pass consoleOnFailover: false to the dblurt Client';
		// On total failure the buffered noise is surfaced as diagnostics.
		if (!ce.includes('RPC detail:')) return 'helper must fold buffered RPC noise into the failure error';
		return null;
	}
});

// ─── runner ───
console.log(`register-diagnostics smoke (cp178): ${scenarios.length} scenarios\n`);
let failed = 0;
for (const s of scenarios) {
	const res = s.run();
	if (res === null) {
		console.log(`  ✓ ${s.name}`);
	} else {
		console.log(`  ✗ ${s.name}: ${res}`);
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length} scenarios passed`);
	process.exit(0);
}
console.error(`✗ ${failed} failed, ${scenarios.length - failed} passed`);
process.exit(1);
