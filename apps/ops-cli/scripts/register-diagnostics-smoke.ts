/**
 * ops-cli register-diagnostics smoke (cp178).
 *
 * Covers the operator-UX fixes shipped in cp178:
 *   1. classifyChainError maps representative error strings to the
 *      right kind (including Blurt's "mana" AND Steem-derived "rc"
 *      daemon wording → insufficient_rc).
 *   2. printChainErrorHelp emits the right specific guidance per
 *      kind, uses Blurt's MANA term (never "resource credits"/"RC")
 *      in the mana branch, and never tells the operator to merely
 *      reinstall for the dependency_unevaluable case.
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
	['transaction has insufficient mana', 'insufficient_rc'],
	['Account bob does not have enough mana', 'insufficient_rc'],
	['not enough rc', 'insufficient_rc'],
	['resource credit exhausted', 'insufficient_rc'],
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
	name: 'mana branch uses Blurt MANA term, not RC/resource-credits',
	run() {
		const t = capture('transaction has insufficient mana');
		if (!/mana/i.test(t)) return 'expected "mana" in output';
		if (/resource credit/i.test(t)) return 'must not say "resource credit"';
		if (/\(RC\)/.test(t) || / RC /.test(t)) return 'must not say standalone "RC"';
		if (!/BLURT Power|BP/.test(t)) return 'should mention BP / BLURT Power';
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
		return k === 'insufficient_rc' ? null : `returned ${k}`;
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
