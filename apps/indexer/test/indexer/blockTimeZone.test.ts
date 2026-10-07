/**
 * Block timestamps are UTC whatever the server's clock zone. Run in child
 * processes with a non-UTC TZ: CI and the sandbox run in UTC, where reading the
 * zone-less "2026-11-01T00:00:00" as local time is invisible.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const LEAF = join(__dirname, '..', '..', 'src', 'indexer', 'blockTime.ts');
const GATE = join(__dirname, '..', '..', 'src', 'indexer', 'consensusActivation.ts');

function inZone(tz: string, stamp: string): { iso: string; active: boolean } {
	const code =
		`import { blockTimeOf } from ${JSON.stringify(LEAF)};` +
		`import { consensusV2Active } from ${JSON.stringify(GATE)};` +
		`const t = blockTimeOf(${JSON.stringify(stamp)});` +
		`console.log(JSON.stringify({ iso: t.toISOString(), active: consensusV2Active(t) }));`;
	const r = spawnSync(TSX, ['-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(r.stderr);
	return JSON.parse(r.stdout.trim());
}

describe('block time is read as UTC in every server zone', () => {
	it.each(['Asia/Tehran', 'America/Bogota', 'Pacific/Kiritimati'])('%s', (tz) => {
		expect(inZone(tz, '2026-11-01T00:00:00')).toEqual({
			iso: '2026-11-01T00:00:00.000Z',
			active: true
		});
		expect(inZone(tz, '2026-10-31T23:59:59')).toEqual({
			iso: '2026-10-31T23:59:59.000Z',
			active: false
		});
	});

	it('the dispatcher and the head tailer take block times from blockTimeOf (call sites)', () => {
		for (const f of ['dispatcher.ts', 'headTailer.ts']) {
			const p = join(__dirname, '..', '..', 'src', 'indexer', f);
			const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
			const calls: string[] = [];
			const visit = (n: ts.Node): void => {
				if (
					ts.isCallExpression(n) &&
					ts.isIdentifier(n.expression) &&
					n.expression.text === 'blockTimeOf'
				)
					calls.push(n.arguments.map((a) => a.getText(sf)).join(','));
				// A Date built straight from a block timestamp bypasses the rule.
				if (
					ts.isNewExpression(n) &&
					n.expression.getText(sf) === 'Date' &&
					/timestamp/.test(n.getText(sf))
				)
					calls.push(`BYPASS ${n.getText(sf)}`);
				ts.forEachChild(n, visit);
			};
			visit(sf);
			expect(calls.filter((c) => c.startsWith('BYPASS'))).toEqual([]);
			expect(calls).toContain('block.timestamp');
		}
	});
});
