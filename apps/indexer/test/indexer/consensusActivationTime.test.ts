/**
 * The stricter consensus rules are gated on ONE constant, a block TIMESTAMP
 * (consensusActivation.ts), never on a block height and never on the wall
 * clock: the timestamp is chain data every indexer reads the same way.
 *
 *  - the boundary: one second before is the old rule, the instant itself the
 *    new one;
 *  - grep-proof, on the parsed source (comments and SQL text do not count):
 *    no code still reads the retired height constant, and every gate call is
 *    handed a block time, not a block number or the wall clock.
 *
 * The behaviour of the gated rules at the boundary is proven through the real
 * dispatcher in test/integration/consensus-activation-time.test.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CONSENSUS_V2_ACTIVATION_TIME, consensusV2Active } from '$indexer/consensusActivation';

const SRC = join(__dirname, '..', '..', 'src');

/** Every identifier and every consensusV2Active(...) argument in the code. */
function scan(file: string): { identifiers: Set<string>; gateArgs: string[] } {
	const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const identifiers = new Set<string>();
	const gateArgs: string[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isIdentifier(n)) identifiers.add(n.text);
		if (
			ts.isCallExpression(n) &&
			ts.isIdentifier(n.expression) &&
			n.expression.text === 'consensusV2Active'
		) {
			gateArgs.push(n.arguments.map((a) => a.getText(sf)).join(', '));
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return { identifiers, gateArgs };
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
		else if (name.endsWith('.ts')) out.push(p);
	}
	return out;
}

describe('consensus activation by block timestamp', () => {
	it('is 2026-11-01T00:00:00Z', () => {
		expect(CONSENSUS_V2_ACTIVATION_TIME).toBe('2026-11-01T00:00:00Z');
	});

	it('one second before is the old rule; the activation instant and later the new one', () => {
		const at = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
		expect(consensusV2Active(new Date(at - 1000))).toBe(false);
		expect(consensusV2Active(new Date(at - 1))).toBe(false);
		expect(consensusV2Active(new Date(at))).toBe(true);
		expect(consensusV2Active(new Date(at + 86_400_000))).toBe(true);
	});

	it('an unreadable block time is never taken as activated', () => {
		expect(consensusV2Active(new Date('not a time'))).toBe(false);
	});

	it('no code reads the retired height constant', () => {
		const hits = sourceFiles(SRC).filter((f) =>
			scan(f).identifiers.has('CONSENSUS_V2_ACTIVATION_BLOCK')
		);
		expect(hits).toEqual([]);
	});

	it('every gate call is handed a block time, never a block number or the wall clock', () => {
		const calls: string[] = [];
		for (const f of sourceFiles(SRC)) {
			if (f.endsWith('consensusActivation.ts')) continue;
			for (const arg of scan(f).gateArgs) calls.push(`${f.slice(SRC.length + 1)}: ${arg}`);
		}
		expect(calls.length).toBeGreaterThan(0);
		const bad = calls.filter(
			(c) =>
				/block_?num|blockNum|new Date|Date\.now|NOW\(\)/i.test(c) || !/Time\b|judgedAt$/.test(c)
		);
		expect(bad).toEqual([]);
	});
});
