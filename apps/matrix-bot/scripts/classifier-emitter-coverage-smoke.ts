#!/usr/bin/env tsx
/**
 * classifier-emitter-coverage-smoke — the alert tiers must be keyed to events
 * something actually emits.
 *
 * The classifier used to wake the operator for events no code emits
 * (`price:feed_stale`, `federation-probe:peer_down_24h`,
 * `signup-anomaly:single_ip_spike`, …) while the real failures — every price
 * upstream down, a fee recheck pass failing, a fee-relevant block no two RPC
 * operators confirm — fell through to INFO and waited for the next day's
 * digest.
 *
 * This reads every emitter in the tree — the indexer and relay loggers
 * (`logger('<module>')` + `log.<level>('<event>')`) and the ops sidecars
 * (`MORPHIT_EMIT_MODULE` + `emit <level> <event>`) — and requires:
 *   1. every tier rule names an emitted (module, event);
 *   2. every alert template names an emitted (module, event);
 *   3. the real failure events an operator must act on are not INFO.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as classifier from '../src/classifier.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'dist') continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/** "module:event" → files that emit it. */
const emitted = new Map<string, string[]>();
function add(key: string, file: string): void {
	const list = emitted.get(key) ?? [];
	list.push(relative(repo, file));
	emitted.set(key, list);
}
for (const base of ['apps/indexer/src', 'apps/relay/src']) {
	for (const file of walk(join(repo, base)).filter((f) => f.endsWith('.ts'))) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(/(\w+)\s*=\s*logger\(\s*'([^']+)'\s*\)/g)) {
			const re = new RegExp(`\\b${m[1]}\\.(?:debug|info|warn|error)\\(\\s*'([^']+)'`, 'g');
			for (const e of src.matchAll(re)) add(`${m[2]}:${e[1]}`, file);
		}
	}
}
for (const base of ['ops/scripts', 'ops/backup']) {
	for (const file of walk(join(repo, base)).filter((f) => f.endsWith('.sh'))) {
		const src = readFileSync(file, 'utf8');
		const mod = /MORPHIT_EMIT_MODULE="([^"]+)"/.exec(src)?.[1];
		if (mod === undefined) continue;
		for (const e of src.matchAll(/\bemit\s+(?:debug|info|warn|error)\s+"?([a-z0-9_]+)/g))
			add(`${mod}:${e[1]}`, file);
	}
}

console.log('classifier-emitter-coverage-smoke');
check(
	'the emitter scan found the loggers and sidecars',
	emitted.size > 200,
	`found ${emitted.size}`
);

const rules = (classifier as { TIER_RULES?: ReadonlyArray<{ module: string; event: string }> })
	.TIER_RULES;
check('the tier rules are an inspectable table', Array.isArray(rules));
const deadRules = (rules ?? []).map((r) => `${r.module}:${r.event}`).filter((k) => !emitted.has(k));
check(
	'every tier rule names an event something emits',
	deadRules.length === 0,
	`no emitter: ${deadRules.join(', ')}`
);

const copyKeys = (classifier as { alertCopyKeys?: () => string[] }).alertCopyKeys?.();
check('the alert templates are inspectable', Array.isArray(copyKeys));
const deadCopy = (copyKeys ?? []).filter((k) => !emitted.has(k));
check(
	'every alert template names an event something emits',
	deadCopy.length === 0,
	`no emitter: ${deadCopy.join(', ')}`
);

// Real failures an operator must act on, with the tier each must reach.
const mustAlert: Array<[string, 'CRITICAL' | 'WARN']> = [
	['price:all_upstreams_failed_no_cache_serving_floor', 'WARN'],
	['fee-recheck:fee_recheck_pass_failed', 'WARN'],
	['poller:block_not_confirmed', 'WARN'],
	['btc-fee-block-confirm:fee_relevant_block_unconfirmed', 'WARN'],
	['btc-fee-block-confirm:fee_relevant_block_forged', 'CRITICAL'],
	['poller:chain_consistency_disagreement', 'CRITICAL'],
	['federation-probe:probe_threw', 'WARN'],
	['witness-fee:fee_changed', 'WARN'],
	['relay-create:relay_fee_spike_refused', 'CRITICAL'],
	['relay-create:create_outcome_unknown', 'WARN'],
	['relay-drainer:row_escalated_outcome_unknown', 'WARN']
];
for (const [key, tier] of mustAlert) {
	const [module, event] = key.split(':') as [string, string];
	const got = classifier.classify({
		module,
		event,
		ts: '2026-10-01T00:00:00.000Z',
		payload: {}
	}).tier;
	check(
		`${key} is emitted and reaches ${tier}`,
		emitted.has(key) && got === tier,
		`emitted=${emitted.has(key)} tier=${got}`
	);
}

console.log();
if (failures > 0) {
	console.error(`✗ ${failures} of ${n} classifier coverage checks failed`);
	process.exit(1);
}
console.log(`✓ all ${n} classifier coverage checks passed`);
