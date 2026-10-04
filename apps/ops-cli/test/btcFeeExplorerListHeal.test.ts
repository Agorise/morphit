/**
 * the upgrade gives an installed node the onion fee sources.
 *
 * `morphit-ops init` writes MORPHIT_INDEXER_BTC_EXPLORER_URLS into
 * /opt/morphit/morphit.env with the defaults of its day (two clearnet
 * explorers). Such a node would never ask the onion explorers. The heal adds
 * each current default ONCE, keeps every entry the operator has and its order,
 * never re-adds a default the operator removed after it was offered, and never
 * touches an explicitly EMPTY list (empty = BTC fees off on this node).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEFAULT_BTC_FEE_EXPLORERS,
	healBtcExplorerList
} from '../src/lib/btcFeeExplorerListHeal.ts';
import { healXmrExplorerList, readXmrExplorerLine } from '../src/lib/feeExplorerListHeal.ts';
import { selfHealSteps } from '../src/commands/upgrade.ts';

const OLD_BTC = ['https://blockstream.info/api', 'https://mempool.space/api'];
const ONION_BTC = [
	'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api',
	'http://mempool4t6mypeemozyterviq3i5de4kpoua65r3qkn5i3kknu5l2cad.onion/api',
	'http://runbtcx3wfygbq2wdde6qzjnpyrqn3gvbks7t5jdymmunxttdvvttpyd.onion/api',
	'http://explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion/api'
];

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function box(text: string): { root: string; file: string } {
	const root = mkdtempSync(join(tmpdir(), 'btc-list-'));
	dirs.push(root);
	const file = join(root, 'opt/morphit/morphit.env');
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, text);
	return { root, file };
}
const env = (btc: string, xmr = "'https://xmrchain.net'") =>
	[
		'# Fee-verifier explorer URLs (indexer)',
		`MORPHIT_INDEXER_BTC_EXPLORER_URLS=${btc}`,
		`MORPHIT_INDEXER_XMR_EXPLORER_URLS=${xmr}`,
		'MORPHIT_INDEXER_LISTEN_PORT=8081',
		''
	].join('\n');
const btcLine = (text: string): string =>
	text.split('\n').find((l) => l.startsWith('MORPHIT_INDEXER_BTC_EXPLORER_URLS='))!;

describe('the Bitcoin fee-source heal', () => {
	it('the default list is the four live onion explorers, then the two clearnet ones', () => {
		expect(DEFAULT_BTC_FEE_EXPLORERS).toEqual([...ONION_BTC, ...OLD_BTC]);
	});

	it('a wizard-written list gets the onion explorers once; the rest of the file is untouched', () => {
		const { root, file } = box(env(`'${OLD_BTC.join(',')}'`));
		const logs: string[] = [];
		expect(healBtcExplorerList(root, (m) => logs.push(m))).toMatchObject({
			kind: 'updated',
			added: ONION_BTC
		});
		expect(readFileSync(file, 'utf8')).toBe(env(`'${[...OLD_BTC, ...ONION_BTC].join(',')}'`));
		expect(logs.join('\n')).toMatch(/Bitcoin fee checks: added http:\/\/mempoolhqx/);
		expect(healBtcExplorerList(root)).toEqual({ kind: 'already' });
	});

	it("an operator's own list keeps every entry and its order", () => {
		const own = 'https://esplora.my-node.example/api';
		const { root, file } = box(env(own));
		healBtcExplorerList(root);
		expect(btcLine(readFileSync(file, 'utf8'))).toBe(
			`MORPHIT_INDEXER_BTC_EXPLORER_URLS=${[own, ...ONION_BTC, ...OLD_BTC].join(',')}`
		);
	});

	it('a default the operator removed after it was offered is not added again', () => {
		const { root, file } = box(env(`'${OLD_BTC.join(',')}'`));
		healBtcExplorerList(root);
		writeFileSync(file, env(`'${[OLD_BTC[0]!, ONION_BTC[0]!].join(',')}'`));
		expect(healBtcExplorerList(root)).toEqual({ kind: 'already' });
		expect(btcLine(readFileSync(file, 'utf8'))).toBe(
			`MORPHIT_INDEXER_BTC_EXPLORER_URLS='${OLD_BTC[0]},${ONION_BTC[0]}'`
		);
	});

	it('an explicitly empty list (BTC fees off) stays empty', () => {
		const { root, file } = box(env(''));
		expect(healBtcExplorerList(root).kind).toBe('already');
		expect(btcLine(readFileSync(file, 'utf8'))).toBe('MORPHIT_INDEXER_BTC_EXPLORER_URLS=');
	});

	it('unset (an Ansible install): nothing to change, the indexer default applies', () => {
		const { root } = box('MORPHIT_INDEXER_LISTEN_PORT=8081\n');
		expect(healBtcExplorerList(root)).toEqual({ kind: 'unset' });
	});

	it('runs in the upgrade, among the self-heals', () => {
		expect(selfHealSteps().map(([n]) => n)).toContain('the Bitcoin fee-source heal');
	});
});

describe('the Monero fee-source heal and an empty list', () => {
	it('an explicitly empty XMR list (XMR fees off) stays empty — the heal never turns a method back on', () => {
		const { root, file } = box(env(`'${OLD_BTC.join(',')}'`, ''));
		healXmrExplorerList(root);
		expect(readXmrExplorerLine(readFileSync(file, 'utf8'))?.list).toEqual([]);
	});
});
