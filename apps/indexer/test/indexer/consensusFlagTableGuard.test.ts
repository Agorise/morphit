/**
 * No consensus code reads this node's own view (2026-10-29).
 *
 * Indexer state every instance must agree on (an op applied or rejected, an
 * order's fee_status, …) has to be a pure function of the chain. The Signal A–E
 * detector tables are not: an operator's local clearances keep pairs out of
 * them, Signal A skips this node's own relay and runs on this node's timer. The
 * local-only tables (snapshotLocalState.LOCAL_ONLY_TABLES: clearances, push
 * subscriptions, payout queues, …) and an operator's own blocks are not either.
 * The fee-attestation quorum read `related_accounts` until this release, so two
 * nodes could disagree on whether a listing fee was confirmed.
 *
 * This walks every module the op handlers, the dispatcher and the jobs that
 * re-derive chain-derived state reach, and fails on any reference to one of
 * those tables outside the uses listed below — each one a write of this node's
 * own bookkeeping, a display-only detector, or a rule kept for blocks before
 * the consensus activation time. A NEW reference fails until it is either made
 * chain-pure (signalVerdicts.ts has the patterns) or added here with the
 * reason it decides nothing every node must agree on.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LOCAL_ONLY_TABLES } from '$db/snapshotLocalState';

const SRC = resolve(__dirname, '../../src');

/** Tables whose rows are this node's view, not the chain's. */
const FLAG_TABLES = [
	'related_accounts',
	'suspicious_reciprocity',
	'one_way_pile_on',
	'review_concentration',
	'trade_concentration'
];
const NODE_VIEW_TABLES = [...FLAG_TABLES, ...LOCAL_ONLY_TABLES, 'operator_blocks'];

/** Where consensus code starts: everything these reach is checked. */
const SEEDS = [
	'indexer/dispatcher.ts',
	...readdirSync(join(SRC, 'indexer/handlers'))
		.filter((f) => f.endsWith('.ts'))
		.map((f) => `indexer/handlers/${f}`),
	// Jobs that write chain-derived state outside the block loop.
	'indexer/fee/attestationQuorum.ts',
	'indexer/fee/externalFeeRecheck.ts',
	'indexer/blurtFeeReverify.ts',
	'indexer/officialOpReverify.ts',
	'indexer/reconcileRegistrations.ts',
	'indexer/reconcileUpgrade.ts',
	'indexer/feeLegsBackfill.ts',
	'indexer/flowBackfill.ts',
	'indexer/signalVerdicts.ts',
	'indexer/chatGates.ts'
];

/** The allowed references, file → tables, each with why it decides nothing
 *  every node must agree on. */
const ALLOWED: Record<string, { tables: string[]; why: string }> = {
	'indexer/signals.ts': {
		tables: [...FLAG_TABLES, 'moderation_flag_clearances'],
		why: 'the detectors: they WRITE the flag tables, for display, honouring clearances'
	},
	'indexer/fee/attestationQuorumLegacy.ts': {
		tables: ['related_accounts'],
		why: 'the quorum for orders whose newest attestation predates the activation time'
	},
	'indexer/handlers/operatorBlock.ts': {
		tables: ['operator_blocks'],
		why: "the operator's own block op, writing its own rows"
	},
	'indexer/handlers/featureBid.ts': {
		tables: ['push_subscriptions', 'push_pending'],
		why: 'a push notification this node sends (its locale, its queue)'
	},
	'indexer/chatPushEnqueue.ts': {
		tables: ['push_subscriptions', 'push_pending'],
		why: 'a push notification this node sends (its locale, its queue)'
	},
	'indexer/feedbackPushEnqueue.ts': {
		tables: ['push_subscriptions', 'push_pending'],
		why: 'a push notification this node sends (its locale, its queue)'
	},
	'indexer/handlers/feedback.ts': {
		tables: ['relay_pending_transfers'],
		why: "queues this node's relay payout (welcome bonus); the verdict is decided before"
	},
	'indexer/loyalty.ts': {
		tables: ['relay_pending_transfers'],
		why: "queues this node's relay payout (loyalty milestone)"
	},
	'indexer/offlineNoticeEnqueue.ts': {
		tables: ['offline_notify_pending', 'offline_notify_channels'],
		why: 'an offline notice this node sends'
	},
	'indexer/fee/btcFeeAddressIndex.ts': {
		tables: ['btc_fee_address_log'],
		why: 'a cache of a pure function of ops + releases, rebuilt from the event log (MK-H2)'
	},
	'indexer/handlers/rpcDirectory.ts': {
		tables: ['rpc_directory'],
		why: 'writes the signed directory; local-only so a restore never carries it'
	},
	'indexer/blurtFeeReverify.ts': {
		tables: ['fee_reverify_done'],
		why: 'which ops THIS node already re-fetched — its own bookkeeping'
	},
	'indexer/officialOpReverify.ts': {
		tables: ['fee_reverify_done', 'btc_fee_address_log', 'rpc_directory'],
		why: 'its own re-judged bookkeeping; empties the address cache and withdraws a directory row it re-judged'
	},
	'indexer/reconcileUpgrade.ts': {
		tables: ['btc_fee_address_log'],
		why: 'empties the address cache (rebuilt from ops + releases) after re-judging'
	}
};

/** The code of a TypeScript source with comments (and SQL comment lines) removed. */
export function codeOf(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
		.filter((l) => !/^\s*--/.test(l))
		.join('\n');
}

/** The node-view tables `src` references in code. */
export function tablesReferenced(src: string): string[] {
	const code = codeOf(src);
	return NODE_VIEW_TABLES.filter((t) => new RegExp(`\\b${t}\\b`).test(code));
}

function resolveSpec(from: string, spec: string): string | null {
	const alias: [RegExp, string][] = [
		[/^\$indexer\//, 'indexer/'],
		[/^\$db\//, 'db/'],
		[/^\$blurt\//, 'blurt/'],
		[/^\$api\//, 'api/'],
		[/^\$lib\//, 'lib/'],
		[/^\$config\//, 'config/']
	];
	let p: string | null = null;
	if (spec === '$config') p = join(SRC, 'config/index');
	for (const [re, dir] of alias) if (re.test(spec)) p = join(SRC, spec.replace(re, dir));
	if (spec.startsWith('.')) p = resolve(dirname(from), spec);
	if (p === null) return null;
	p = p.replace(/\.js$/, '');
	for (const c of [`${p}.ts`, join(p, 'index.ts'), p]) {
		if (existsSync(c) && statSync(c).isFile()) return c;
	}
	return null;
}

/** Every source module the seeds reach through value imports and re-exports. */
function closure(seeds: string[]): string[] {
	const seen = new Set<string>();
	const queue = seeds.map((s) => join(SRC, s));
	while (queue.length > 0) {
		const f = queue.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const src = readFileSync(f, 'utf8');
		const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
		for (let m = re.exec(src); m !== null; m = re.exec(src)) {
			if (m[2]) continue; // type-only
			const r = resolveSpec(f, m[3]!);
			if (r !== null) queue.push(r);
		}
	}
	return [...seen].map((f) => relative(SRC, f)).sort();
}

describe('consensus code reads no table that is this node’s own view', () => {
	it('the scanner sees a read in code and ignores one in a comment', () => {
		expect(tablesReferenced('await q(`SELECT 1 FROM related_accounts WHERE x`);')).toEqual([
			'related_accounts'
		]);
		expect(
			tablesReferenced('// SELECT 1 FROM related_accounts\n/* suspicious_reciprocity */')
		).toEqual([]);
		expect(tablesReferenced('q(`SELECT 1 FROM moderation_flag_clearances c`)')).toEqual([
			'moderation_flag_clearances'
		]);
		expect(tablesReferenced("log.info('rpc_directory_merged')")).toEqual([]);
	});

	it('the walk reaches the fee-attestation quorum and the pure verdicts through the handlers', () => {
		const files = closure(SEEDS.filter((s) => s.startsWith('indexer/handlers/')));
		expect(files).toContain('indexer/fee/attestationQuorum.ts');
		expect(files).toContain('indexer/signalVerdicts.ts');
		expect(files).toContain('indexer/attestorEligibility.ts');
	});

	it('every reference is one of the listed uses', () => {
		const offenders: string[] = [];
		for (const f of closure(SEEDS)) {
			const used = tablesReferenced(readFileSync(join(SRC, f), 'utf8'));
			const allowed = new Set(ALLOWED[f]?.tables ?? []);
			for (const t of used) if (!allowed.has(t)) offenders.push(`${f}: ${t}`);
		}
		expect(offenders).toEqual([]);
	});
});

/**
 * The same walk, for the fee numbers and settings that are this node's own
 * (2026-10-29).
 *
 * From the consensus activation time a fee verdict is judged by the
 * federation's numbers as of the op's block (fee/feeRulesAtBlock.ts,
 * feeRecipients.ts), never by this node's settings — MORPHIT_INDEXER_FEE_TOLERANCE,
 * _FEE_BASE_BLURT, _FEATURE_FEE_BLURT_PER_HOUR, _FEE_RECIPIENT, _DISABLED_ASSETS,
 * _DISABLED_PAYMENT_METHODS, whether it checks BTC / XMR — or by the pin the
 * poller holds NOW (`feeAmounts`, TreasurySource: the newest release seen, not
 * the one in force at the op's block). Each remaining read must sit inside its
 * activation gate, quoted below exactly; the gate is checked to be there, then
 * cut out, and any read left over fails. A new read fails until it is gated
 * and listed here.
 */
const NODE_FEE_INPUTS: [string, RegExp][] = [
	['the node fee tolerance', /\.feeTolerance\b/],
	['the node env BLURT base', /\.feeBaseBlurt\b/],
	['the live pin (feeAmounts)', /\bfeeAmounts\.(?:blurtBase|btcSatoshis|xmrPiconero)\b/],
	['the live pin (re-check amounts)', /\bamounts\.(?:btcSatoshis|xmrPiconero)\b/],
	// No leading \b: whitespace is removed before the scan (`new TreasurySource`).
	['the live pin (TreasurySource)', /[Tt]reasurySource\b/],
	['the node featured-slot price', /\.featureFeeBlurtPerHour\b/],
	['the node disabled assets / methods', /\.disabled(?:Assets|PaymentMethods)\b/],
	['the node fee verifiers', /\bfeeVerifiers\.(?:btc|xmr)\b/],
	['the node fee recipient', /\b(?:config|ctx|input)\.feeRecipient\b/]
];

/** A StrangerFeeInput field: evaluateStrangerFee reads it only through its
 *  gates (listed under strangerFee.ts). */
const STRANGER_FEE_INPUT_WHY =
	'hands the node setting to evaluateStrangerFee, which applies it only before the activation time';

/** file → the gated expressions (code; whitespace does not matter) that may read
 *  a node fee input, and why each decides nothing a peer could disagree on. A
 *  listed gate must be present: deleting one fails too. */
const GATED_FEE_READS: Record<string, { gates: string[]; why: string }> = {
	'indexer/fee/feeRulesAtBlock.ts': {
		gates: [
			'return consensusV2Active(blockTime) ? FEDERATION_FEE_TOLERANCE : nodeTolerance;',
			'return consensusV2Active(blockTime) ? FEDERATION_FEATURE_FEE_BLURT_PER_HOUR : nodePrice;',
			'if (!consensusV2Active(at.blockTime)) return legacy();',
			`baseBlurt: blurtBaseOf(await treasuryPinAt(db, at.blockNum)) ?? FEDERATION_BLURT_BASE,
			 feeTolerance: FEDERATION_FEE_TOLERANCE`
		],
		why: 'the gates themselves: the caller’s own inputs before the activation time, the federation’s from it'
	},
	'indexer/handlers/order.ts': {
		gates: [
			`await listingFeeInputsAt(client, ctx, () => ({
				baseBlurt: ctx.feeAmounts.blurtBase ?? ctx.config.feeBaseBlurt,
				feeTolerance: ctx.config.feeTolerance
			}))`,
			'const nodeGates = !consensusV2Active(ctx.blockTime);',
			'if (nodeGates && ctx.config.disabledAssets.includes(v.asset)) {',
			`nodeGates &&
				ctx.config.disabledPaymentMethods.length > 0 &&
				v.payment_methods.every((m) => ctx.config.disabledPaymentMethods.includes(m.toLowerCase()))`,
			'if (nodeGates) {' +
				"const verifier = v.fee_method === 'btc' ? ctx.feeVerifiers.btc : ctx.feeVerifiers.xmr;" +
				'if (verifier === undefined) {' +
				'return { ok: false, reason: `fee_method_not_configured_${v.fee_method}` };' +
				'}' +
				'const expectedAmount: number | bigint | undefined =' +
				"v.fee_method === 'btc' ? ctx.feeAmounts.btcSatoshis : ctx.feeAmounts.xmrPiconero;",
			`} else if (
				externalFeeAmountOf(await treasuryPinAt(client, ctx.blockNum), v.fee_method) === undefined
			) {`,
			'await ownerRecipientsAt(client, ctx.config.feeRecipient, ctx.payload, ctx)'
		],
		why: 'the listing-fee base / tolerance, the disabled assets / methods, the BTC/XMR verifier and amount, the own fee recipient: this node’s view before the activation time only'
	},
	'indexer/blurtFeeReverify.ts': {
		gates: [
			// Which ops to re-fetch, not a verdict.
			'const own = this.deps.config.feeRecipient;',
			`await ownerRecipientsAt(client, this.deps.config.feeRecipient, payload, {
				blockNum,
				blockTime: new Date(row.block_time)
			})`,
			`const opBlockTime = new Date(row.block_time);
			 if (consensusV2Active(opBlockTime)) return [];`,
			`await listingFeeInputsAt(client, { blockNum, blockTime }, async () => ({
				baseBlurt: (await pinnedBlurtBaseAsOf(client, blockNum)) ?? cfg.feeBaseBlurt,
				feeTolerance: cfg.feeTolerance
			}))`
		],
		why: 'the re-judged listing fee: the node settings before the activation time only, as at intake; `own` picks which ops to re-fetch'
	},
	'indexer/handlers/featureBid.ts': {
		gates: [
			'feeToleranceAt(ctx.blockTime, ctx.config.feeTolerance)',
			'featureFeeBlurtPerHourAt(ctx.blockTime, ctx.config.featureFeeBlurtPerHour)',
			`consensusV2Active(ctx.blockTime)
				? await chainFeePayeesAt(client, ctx.blockNum)
				: ctx.config.feeRecipient,`
		],
		why: 'the bid’s band, price and payee: the node settings before the activation time only'
	},
	'indexer/handlers/strangerFee.ts': {
		gates: [
			'const tolerance = feeToleranceAt(input.blockTime, input.feeTolerance);',
			'feeTolerance: ctx.config.feeTolerance,',
			'feeRecipient: ctx.config.feeRecipient,',
			'await ownerRecipientsAt(client, input.feeRecipient, input.payload, input)',
			'...(consensusV2Active(input.blockTime) ? [] : (input.extraOwnerRecipients ?? []))'
		],
		why: 'the stranger fee’s band and payees: the node settings before the activation time only'
	},
	'indexer/headStrangerFees.ts': {
		gates: [
			'feeTolerance: ctx.feeTolerance,',
			'feeRecipient: ctx.feeRecipient,',
			// The fast path's cheap pre-filter: which head fees it looks at, for
			// a fast inbox only; it writes nothing (fastpath-writes-nothing).
			'hasFeeTransfer(trx, payer, ctx.feeRecipient)'
		],
		why: STRANGER_FEE_INPUT_WHY
	},
	'indexer/headTailer.ts': {
		gates: ['feeTolerance: this.config.feeTolerance,', 'feeRecipient: this.config.feeRecipient,'],
		why: STRANGER_FEE_INPUT_WHY
	},
	'indexer/dispatcher.ts': {
		gates: [
			`collectFeeTransfers(
				block,
				blockNum,
				blockTime,
				block.transaction_ids,
				config.feeRecipient
			)`
		],
		why: 'fee_transfers: an audit list of transfers to this node’s own account; no verdict reads it'
	},
	'indexer/feeRecipients.ts': {
		gates: [
			`if (!consensusV2Active(at.blockTime)) {
				return ownerRecipientsFor(client, ownRecipient, payload, at.blockNum);
			}
			return chainFeePayeesAt(client, at.blockNum);`
		],
		why: 'the owner-leg payees: this node’s own recipient before the activation time only'
	},
	'indexer/fee/externalFeeRecheck.ts': {
		gates: [
			`row.fee_method === 'btc' ? deps.amounts.btcSatoshis : deps.amounts.xmrPiconero`,
			'addressExpected(row, deps.amounts.btcSatoshis)',
			`if (postedFromActivation(row.created_at)) {
				return externalFeeAmountOf(row.pin_at_block, row.fee_method);
			}`,
			'if (postedFromActivation(row.created_at)) return posted;',
			`const postedBlockTime = createdAt instanceof Date ? createdAt : new Date(createdAt);
			 return consensusV2Active(postedBlockTime);`
		],
		why: 'today’s pin, asked for only for orders before the activation time (expectedFor, addressExpected)'
	}
};

/** Code with every whitespace run removed, so a gate matches however it is wrapped. */
const squash = (s: string): string => s.replace(/\s+/g, '');

/** What a file reads of NODE_FEE_INPUTS outside its listed gates, and which of
 *  its listed gates are missing. */
export function ungatedFeeReads(
	src: string,
	gates: readonly string[]
): { reads: string[]; missingGates: string[] } {
	let code = squash(codeOf(src));
	const missingGates: string[] = [];
	for (const g of gates) {
		const gs = squash(g);
		if (!code.includes(gs)) missingGates.push(g);
		code = code.split(gs).join('#');
	}
	return {
		reads: NODE_FEE_INPUTS.filter(([, re]) => re.test(code)).map(([n]) => n),
		missingGates
	};
}

describe('consensus code judges fees by the federation’s numbers, as of the block', () => {
	it('the scanner sees an ungated read, and none inside its gate', () => {
		const gate = 'feeToleranceAt(ctx.blockTime, ctx.config.feeTolerance)';
		expect(ungatedFeeReads('const t = ctx.config.feeTolerance;', []).reads).toEqual([
			'the node fee tolerance'
		]);
		expect(
			ungatedFeeReads(`const t = feeToleranceAt(ctx.blockTime,\n  ctx.config.feeTolerance);`, [
				gate
			])
		).toEqual({
			reads: [],
			missingGates: []
		});
		expect(ungatedFeeReads('const b = ctx.feeAmounts.blurtBase; // x', []).reads).toEqual([
			'the live pin (feeAmounts)'
		]);
		expect(ungatedFeeReads('// ctx.config.feeTolerance', [gate])).toEqual({
			reads: [],
			missingGates: [gate]
		});
	});

	it('every node fee input is read only inside its activation gate', () => {
		const offenders: string[] = [];
		for (const f of closure(SEEDS)) {
			const listed = GATED_FEE_READS[f];
			const { reads, missingGates } = ungatedFeeReads(
				readFileSync(join(SRC, f), 'utf8'),
				listed?.gates ?? []
			);
			for (const r of reads) offenders.push(`${f}: ${r}`);
			for (const g of missingGates) offenders.push(`${f}: gate missing: ${g}`);
		}
		for (const f of Object.keys(GATED_FEE_READS)) {
			if (!closure(SEEDS).includes(f)) offenders.push(`${f}: listed but not reached`);
		}
		expect(offenders).toEqual([]);
	});
});
