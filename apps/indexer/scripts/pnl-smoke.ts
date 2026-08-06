/**
 * Morphit smoke — P&L categorizer + CSV builder.
 *
 * Pure logic; verifies categorization rules, CSV quoting,
 * CSV-injection mitigation, date filtering, and timestamp
 * normalization.
 */

import {
	categorizeOp,
	filterByDateRange,
	type HistoryOp,
	type CategorizerPredicates,
	type PnlRow
} from '../../web/src/lib/pnl/categorize';
import { buildPnlCsv, type CsvHeaders, type CategoryLabels } from '../../web/src/lib/pnl/exportCsv';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── pnl smoke ────────────────────────────────────────────\n');

const PREDS: CategorizerPredicates = {
	isFeesAccount: (n) => n === 'morphit-fees',
	isOperatorAccount: (n) => n === 'morphit',
	isFeaturedBidMemo: (m) => /^featured-bid:/.test(m)
};

function transferOp(args: {
	from: string;
	to: string;
	amount: string;
	memo?: string;
	timestamp?: string;
}): HistoryOp {
	return {
		block: 100_000,
		trx_id: 'abc123',
		timestamp: args.timestamp ?? '2024-08-15T14:32:18',
		op: ['transfer', { from: args.from, to: args.to, amount: args.amount, memo: args.memo ?? '' }]
	};
}

// ─── categorizeOp ───────────────────────────────────────────────────

scenario('categorizeOp: incoming BLURT from random user → blurt_received', () => {
	const r = categorizeOp(
		transferOp({ from: 'alice', to: 'me', amount: '10.000 BLURT' }),
		'me',
		PREDS
	);
	if (!r) throw new Error('expected row');
	if (r.category !== 'blurt_received') throw new Error(`got ${r.category}`);
	if (r.blurtSigned !== 10) throw new Error(`amt ${r.blurtSigned}`);
	if (r.counterparty !== 'alice') throw new Error('counterparty');
});

scenario('categorizeOp: outgoing BLURT to random user → blurt_sent', () => {
	const r = categorizeOp(transferOp({ from: 'me', to: 'bob', amount: '5.000 BLURT' }), 'me', PREDS);
	if (!r) throw new Error('expected row');
	if (r.category !== 'blurt_sent') throw new Error(`got ${r.category}`);
	if (r.blurtSigned !== -5) throw new Error(`amt ${r.blurtSigned}`);
	if (r.counterparty !== 'bob') throw new Error('counterparty');
});

scenario('categorizeOp: outgoing to fees account → order_fee', () => {
	const r = categorizeOp(
		transferOp({
			from: 'me',
			to: 'morphit-fees',
			amount: '0.500 BLURT',
			memo: 'morphit-order:abcd'
		}),
		'me',
		PREDS
	);
	if (!r) throw new Error('expected row');
	if (r.category !== 'order_fee') throw new Error(`got ${r.category}`);
	if (r.blurtSigned !== -0.5) throw new Error(`amt ${r.blurtSigned}`);
});

scenario('categorizeOp: outgoing to operator with featured-bid memo → featured_bid', () => {
	const r = categorizeOp(
		transferOp({ from: 'me', to: 'morphit', amount: '1.234 BLURT', memo: 'featured-bid:slot-3' }),
		'me',
		PREDS
	);
	if (!r) throw new Error('expected row');
	if (r.category !== 'featured_bid') throw new Error(`got ${r.category}`);
});

scenario('categorizeOp: outgoing to operator WITHOUT featured-bid memo → blurt_sent', () => {
	const r = categorizeOp(
		transferOp({ from: 'me', to: 'morphit', amount: '1.000 BLURT', memo: 'donation' }),
		'me',
		PREDS
	);
	if (!r) throw new Error('expected row');
	if (r.category !== 'blurt_sent') throw new Error(`got ${r.category}`);
});

scenario('categorizeOp: incoming from operator → featured_payout', () => {
	const r = categorizeOp(
		transferOp({ from: 'morphit', to: 'me', amount: '50.000 BLURT' }),
		'me',
		PREDS
	);
	if (!r) throw new Error('expected row');
	if (r.category !== 'featured_payout') throw new Error(`got ${r.category}`);
});

scenario('categorizeOp: non-transfer op → null', () => {
	const r = categorizeOp(
		{ block: 1, trx_id: 'x', timestamp: '2024-01-01T00:00:00', op: ['vote', {}] },
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

scenario('categorizeOp: non-BLURT amount → null', () => {
	const r = categorizeOp(
		transferOp({ from: 'alice', to: 'me', amount: '10.000 BBD' }),
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

scenario('categorizeOp: unrelated transfer (we are neither sender nor receiver) → null', () => {
	const r = categorizeOp(
		transferOp({ from: 'alice', to: 'bob', amount: '1.000 BLURT' }),
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

scenario('categorizeOp: zero amount → null', () => {
	const r = categorizeOp(
		transferOp({ from: 'alice', to: 'me', amount: '0.000 BLURT' }),
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

scenario('categorizeOp: timestamp normalized to Z', () => {
	const r = categorizeOp(
		transferOp({
			from: 'alice',
			to: 'me',
			amount: '1.000 BLURT',
			timestamp: '2024-08-15T14:32:18'
		}),
		'me',
		PREDS
	);
	if (!r) throw new Error('expected row');
	if (r.timestamp !== '2024-08-15T14:32:18Z') throw new Error(`got ${r.timestamp}`);
});

scenario('categorizeOp: WIF-shaped substring in memo gets redacted', () => {
	const wif = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
	const r = categorizeOp(
		transferOp({
			from: 'alice',
			to: 'me',
			amount: '1.000 BLURT',
			memo: `payment ref ${wif} attached`
		}),
		'me',
		PREDS
	);
	if (!r) throw new Error('expected row');
	if (r.memo.includes(wif)) throw new Error('WIF survived redaction');
	if (!r.memo.includes('[REDACTED-WIF-SHAPE]')) throw new Error('redaction marker missing');
});

scenario('categorizeOp: malformed transfer body → null', () => {
	const r = categorizeOp(
		{
			block: 1,
			trx_id: 'x',
			timestamp: '2024-01-01T00:00:00',
			op: ['transfer', { from: 'alice' }]
		},
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

// ─── Audit fix #7: defensive op.op shape guards ─────────────────────

scenario('categorizeOp: op.op is null → null (no crash)', () => {
	const r = categorizeOp(
		{
			block: 1,
			trx_id: 'x',
			timestamp: '2024-01-01T00:00:00',
			op: null as unknown as [string, Record<string, unknown>]
		},
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

scenario('categorizeOp: op.op is empty array → null', () => {
	const r = categorizeOp(
		{
			block: 1,
			trx_id: 'x',
			timestamp: '2024-01-01T00:00:00',
			op: [] as unknown as [string, Record<string, unknown>]
		},
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

scenario('categorizeOp: op.op[1] is not an object → null', () => {
	const r = categorizeOp(
		{
			block: 1,
			trx_id: 'x',
			timestamp: '2024-01-01T00:00:00',
			op: ['transfer', null as unknown as Record<string, unknown>]
		},
		'me',
		PREDS
	);
	if (r !== null) throw new Error('expected null');
});

// ─── filterByDateRange ──────────────────────────────────────────────

scenario('filterByDateRange: inclusive on both ends', () => {
	const rows: PnlRow[] = [
		{
			timestamp: '2024-01-01T00:00:00Z',
			trxId: 'a',
			block: 1,
			category: 'blurt_received',
			counterparty: 'x',
			blurtSigned: 1,
			memo: ''
		},
		{
			timestamp: '2024-06-15T12:00:00Z',
			trxId: 'b',
			block: 2,
			category: 'blurt_received',
			counterparty: 'x',
			blurtSigned: 1,
			memo: ''
		},
		{
			timestamp: '2024-12-31T23:59:59Z',
			trxId: 'c',
			block: 3,
			category: 'blurt_received',
			counterparty: 'x',
			blurtSigned: 1,
			memo: ''
		}
	];
	const start = Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000);
	const end = Math.floor(Date.parse('2024-12-31T23:59:59Z') / 1000);
	const filtered = filterByDateRange(rows, start, end);
	if (filtered.length !== 3) throw new Error(`got ${filtered.length}`);
});

scenario('filterByDateRange: excludes outside range', () => {
	const rows: PnlRow[] = [
		{
			timestamp: '2023-12-31T23:59:59Z',
			trxId: 'a',
			block: 1,
			category: 'blurt_received',
			counterparty: 'x',
			blurtSigned: 1,
			memo: ''
		},
		{
			timestamp: '2024-06-15T12:00:00Z',
			trxId: 'b',
			block: 2,
			category: 'blurt_received',
			counterparty: 'x',
			blurtSigned: 1,
			memo: ''
		},
		{
			timestamp: '2025-01-01T00:00:01Z',
			trxId: 'c',
			block: 3,
			category: 'blurt_received',
			counterparty: 'x',
			blurtSigned: 1,
			memo: ''
		}
	];
	const start = Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000);
	const end = Math.floor(Date.parse('2024-12-31T23:59:59Z') / 1000);
	const filtered = filterByDateRange(rows, start, end);
	if (filtered.length !== 1) throw new Error(`got ${filtered.length}`);
	if (filtered[0]!.trxId !== 'b') throw new Error('wrong row');
});

// ─── buildPnlCsv ────────────────────────────────────────────────────

const HEADERS: CsvHeaders = {
	timestamp: 'Timestamp (UTC)',
	category: 'Category',
	counterparty: 'Counterparty',
	blurtAmount: 'Net BLURT change',
	memo: 'Memo',
	trxId: 'Transaction ID',
	block: 'Block'
};
const LABELS: CategoryLabels = {
	blurt_received: 'BLURT received',
	blurt_sent: 'BLURT sent',
	order_fee: 'Order fee',
	featured_bid: 'Featured bid',
	featured_payout: 'Featured payout'
};

function makeRow(overrides: Partial<PnlRow> = {}): PnlRow {
	return {
		timestamp: '2024-08-15T14:32:18Z',
		trxId: 'abc123',
		block: 100_000,
		category: 'blurt_received',
		counterparty: 'alice',
		blurtSigned: 10,
		memo: '',
		...overrides
	};
}

scenario('buildPnlCsv: starts with UTF-8 BOM', () => {
	const csv = buildPnlCsv([makeRow()], HEADERS, LABELS);
	if (csv.charCodeAt(0) !== 0xfeff) throw new Error('no BOM');
});

scenario('buildPnlCsv: header line + one row, CRLF separated', () => {
	const csv = buildPnlCsv([makeRow()], HEADERS, LABELS);
	const lines = csv.slice(1).split('\r\n');
	// Trailing \r\n produces an empty final element.
	if (lines.length !== 3) throw new Error(`expected 3 (hdr+row+trailing), got ${lines.length}`);
	if (!lines[0]!.startsWith('Timestamp (UTC)')) throw new Error('header');
	if (!lines[1]!.startsWith('2024-08-15T14:32:18Z')) throw new Error('row');
});

scenario('buildPnlCsv: numeric column unquoted, signed', () => {
	const csv = buildPnlCsv(
		[makeRow({ blurtSigned: -5.5 }), makeRow({ blurtSigned: 10 })],
		HEADERS,
		LABELS
	);
	const lines = csv.slice(1).split('\r\n');
	// row 1: blurtSigned column (4th col) should be -5.500
	if (!lines[1]!.includes(',-5.500,')) throw new Error('row1 amt');
	if (!lines[2]!.includes(',10.000,')) throw new Error('row2 amt');
});

scenario('buildPnlCsv: memo with comma is quoted', () => {
	const csv = buildPnlCsv([makeRow({ memo: 'hello, world' })], HEADERS, LABELS);
	if (!csv.includes('"hello, world"')) throw new Error('not quoted');
});

scenario('buildPnlCsv: memo with quote is escaped', () => {
	const csv = buildPnlCsv([makeRow({ memo: 'she said "hi"' })], HEADERS, LABELS);
	if (!csv.includes('"she said ""hi"""')) throw new Error('not escaped');
});

scenario('buildPnlCsv: memo starting with = is CSV-injection-prefixed', () => {
	const csv = buildPnlCsv([makeRow({ memo: '=cmd|"calc"' })], HEADERS, LABELS);
	// Should be quoted AND prefixed with single-quote.
	if (!csv.includes('"\'=cmd|""calc"""')) {
		throw new Error('CSV-injection prefix missing or wrong');
	}
});

scenario('buildPnlCsv: memo starting with @ is CSV-injection-prefixed', () => {
	const csv = buildPnlCsv([makeRow({ memo: '@SUM(A1:A2)' })], HEADERS, LABELS);
	if (!csv.includes('"\'@SUM(A1:A2)"')) throw new Error('@ prefix missing');
});

scenario('buildPnlCsv: counterparty starting with - is CSV-injection-prefixed', () => {
	const csv = buildPnlCsv([makeRow({ counterparty: '-2-cmd' })], HEADERS, LABELS);
	if (!csv.includes('"\'-2-cmd"')) throw new Error('- prefix missing');
});

scenario('buildPnlCsv: unicode in memo preserved', () => {
	const csv = buildPnlCsv([makeRow({ memo: 'café — résumé' })], HEADERS, LABELS);
	if (!csv.includes('café — résumé')) throw new Error('unicode mangled');
});

scenario('buildPnlCsv: empty rows produce header-only', () => {
	const csv = buildPnlCsv([], HEADERS, LABELS);
	const lines = csv.slice(1).split('\r\n');
	if (lines.length !== 2) throw new Error(`expected hdr + trailing, got ${lines.length}`);
});

scenario('buildPnlCsv: localized category labels in output', () => {
	const csv = buildPnlCsv([makeRow({ category: 'order_fee' })], HEADERS, {
		...LABELS,
		order_fee: 'Frais de commande'
	});
	if (!csv.includes('Frais de commande')) throw new Error('label not applied');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
