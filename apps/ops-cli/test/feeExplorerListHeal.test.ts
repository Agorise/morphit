/**
 * v1.20.2 — the upgrade brings an installed node's XMR fee-source list up to
 * date (lib/feeExplorerListHeal.ts). The fixture is what `morphit-ops init`
 * wrote before v1.20.0: its default list of the day, single-quoted by
 * render.ts quote() (a comma is not in its safe set).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEFAULT_XMR_FEE_EXPLORERS,
	RETIRED_XMR_FEE_EXPLORERS,
	healXmrExplorerList,
	offeredStatePath,
	planXmrExplorerList,
	readXmrExplorerLine
} from '../src/lib/feeExplorerListHeal.ts';
import { selfHealSteps } from '../src/commands/upgrade.ts';

const PRE_V120_LIST = [
	'https://xmrchain.net',
	'https://localmonero.co/blocks',
	'https://monerohash.com/explorer',
	'https://exploremonero.com',
	'https://moneroexplorer.org'
];
const NEW_SOURCES = [
	'raw-tx+https://moneroblocks.info',
	'node+https://xmr-node.cakewallet.com:18081',
	'node+https://node.monero.fail',
	'node+https://xmr.cryptostorm.is'
];

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function box(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'xmr-list-'));
	dirs.push(root);
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(join(root, p, '..'), { recursive: true });
		writeFileSync(join(root, p), text);
	}
	return root;
}
const wizardEnv = (list: readonly string[]) =>
	[
		'# Fee-verifier explorer URLs (indexer)',
		"MORPHIT_INDEXER_BTC_EXPLORER_URLS='https://blockstream.info/api,https://mempool.space/api'",
		`MORPHIT_INDEXER_XMR_EXPLORER_URLS='${list.join(',')}'`,
		'MORPHIT_INDEXER_LISTEN_PORT=8081',
		''
	].join('\n');

describe('planXmrExplorerList', () => {
	it('a pre-v1.20 list: the three dead explorers go, the four newer sources come, the two live ones stay', () => {
		const p = planXmrExplorerList(PRE_V120_LIST, new Set());
		expect(p.removed).toEqual(RETIRED_XMR_FEE_EXPLORERS);
		expect(p.added).toEqual(NEW_SOURCES);
		expect(p.next).toEqual(['https://xmrchain.net', 'https://moneroexplorer.org', ...NEW_SOURCES]);
	});
	it('the current default list: nothing to do', () => {
		expect(planXmrExplorerList(DEFAULT_XMR_FEE_EXPLORERS, new Set()).next).toBeNull();
	});
	it("an operator's own explorer is kept, in its place", () => {
		const p = planXmrExplorerList(['https://localhost:8081', 'https://xmrchain.net/'], new Set());
		expect(p.next?.slice(0, 2)).toEqual(['https://localhost:8081', 'https://xmrchain.net/']);
		expect(p.next).not.toContain('https://xmrchain.net');
	});
	it('a default the operator removed after it was offered is not added again', () => {
		const removedOne = DEFAULT_XMR_FEE_EXPLORERS.filter(
			(u) => u !== 'node+https://node.monero.fail'
		);
		const offered = new Set(DEFAULT_XMR_FEE_EXPLORERS.map((u) => u.toLowerCase()));
		expect(planXmrExplorerList(removedOne, offered).next).toBeNull();
	});
	it('never leaves an empty list (that would turn XMR fee checks off)', () => {
		const offered = new Set(DEFAULT_XMR_FEE_EXPLORERS.map((u) => u.toLowerCase()));
		const p = planXmrExplorerList(['https://exploremonero.com'], offered);
		expect(p.next).toEqual(DEFAULT_XMR_FEE_EXPLORERS);
	});
});

describe('healXmrExplorerList on a box', () => {
	it('rewrites the wizard-written list in morphit.env, keeps everything else, then is a no-op', () => {
		const root = box({ 'opt/morphit/morphit.env': wizardEnv(PRE_V120_LIST) });
		const f = join(root, 'opt/morphit/morphit.env');
		chmodSync(f, 0o600);
		const logs: string[] = [];
		const r = healXmrExplorerList(root, (m) => logs.push(m));
		expect(r).toMatchObject({
			kind: 'updated',
			added: NEW_SOURCES,
			removed: RETIRED_XMR_FEE_EXPLORERS
		});
		const text = readFileSync(f, 'utf8');
		expect(text).toBe(
			wizardEnv(['https://xmrchain.net', 'https://moneroexplorer.org', ...NEW_SOURCES])
		);
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(logs[0]).toMatch(/^Monero fee checks: added raw-tx\+https:\/\/moneroblocks\.info/);
		expect(JSON.parse(readFileSync(offeredStatePath(root), 'utf8')).offered).toHaveLength(6);
		expect(healXmrExplorerList(root)).toEqual({ kind: 'already' });
	});
	it('respects a later removal by the operator on the next upgrade', () => {
		const root = box({ 'opt/morphit/morphit.env': wizardEnv(PRE_V120_LIST) });
		const f = join(root, 'opt/morphit/morphit.env');
		healXmrExplorerList(root);
		writeFileSync(f, wizardEnv(['https://xmrchain.net', 'https://moneroexplorer.org']));
		expect(healXmrExplorerList(root)).toEqual({ kind: 'already' });
		expect(readXmrExplorerLine(readFileSync(f, 'utf8'))?.list).toEqual([
			'https://xmrchain.net',
			'https://moneroexplorer.org'
		]);
	});
	it('`export KEY=value` and unquoted values are kept in their form', () => {
		const root = box({
			'etc/morphit/indexer.env': `export MORPHIT_INDEXER_XMR_EXPLORER_URLS=https://xmrchain.net\nX=1\n`
		});
		healXmrExplorerList(root);
		const text = readFileSync(join(root, 'etc/morphit/indexer.env'), 'utf8');
		expect(text.split('\n')[0]).toBe(
			`export MORPHIT_INDEXER_XMR_EXPLORER_URLS=${['https://xmrchain.net', ...DEFAULT_XMR_FEE_EXPLORERS.filter((u) => u !== 'https://xmrchain.net')].join(',')}`
		);
		expect(text.split('\n')[1]).toBe('X=1');
	});
	it('unset everywhere (an Ansible install): nothing to change, the indexer default applies', () => {
		const root = box({ 'etc/morphit/indexer.env': 'MORPHIT_INDEXER_LISTEN_PORT=8081\n' });
		expect(healXmrExplorerList(root)).toEqual({ kind: 'unset' });
	});
	it('runs in the upgrade, among the self-heals', () => {
		expect(selfHealSteps().map(([n]) => n)).toContain('the Monero fee-source heal');
	});
});
