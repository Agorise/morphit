/**
 * Morphit — P&L CSV builder.
 *
 * Pure: takes a list of categorized P&L rows + locale, returns a
 * CSV string.  The headers are explanatory ("Timestamp (UTC)",
 * "Net BLURT change") not abbreviations, so the user opening the
 * file in Excel/LibreOffice/Numbers doesn't ask "wtf is this
 * column showing me?".
 *
 * RFC 4180 quoting:
 *   - Fields are wrapped in double quotes if they contain `,`,
 *     `"`, `\r`, `\n`, OR a leading `=`/`+`/`-`/`@` (CSV-injection
 *     mitigation; some spreadsheet apps interpret those as
 *     formulas).
 *   - Embedded `"` is escaped as `""`.
 *   - Lines are joined with `\r\n` per the RFC.
 *
 * The output is ASCII-safe in the structural bytes; user content
 * (memo, counterparty) is UTF-8 and the file is intended to be
 * opened as UTF-8.  We prepend a UTF-8 BOM so Excel-on-Windows
 * doesn't mojibake the memos.
 */

import type { PnlRow, PnlCategory } from './categorize';

/** Static column headers.  i18n message keys are passed in by the
 *  caller; the builder doesn't import svelte-i18n directly so it
 *  stays smoke-testable with plain strings. */
export interface CsvHeaders {
	readonly timestamp: string;
	readonly category: string;
	readonly counterparty: string;
	readonly blurtAmount: string;
	readonly memo: string;
	readonly trxId: string;
	readonly block: string;
}

/** Localized labels for each category.  Caller-supplied so the
 *  CSV reads in the user's locale. */
// `K` is a mapped-type binder, used immediately in scope. ESLint's
// no-unused-vars rule treats mapped-type binders as variables and
// trips a false positive — TypeScript's `noUnusedLocals` correctly
// does NOT flag this.
// eslint-disable-next-line no-unused-vars
export type CategoryLabels = { readonly [K in PnlCategory]: string };

/** Quote a CSV field per RFC 4180 + CSV-injection mitigation. */
function quote(s: string): string {
	if (s.length === 0) return '';
	let needsQuotes = false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 34 /* " */ || c === 44 /* , */ || c === 13 || c === 10) {
			needsQuotes = true;
			break;
		}
	}
	// CSV-injection: a leading =, +, -, @ would be interpreted
	// as a formula in Excel/LibreOffice.  Force-quote and prefix
	// with a tab to disable formula interpretation.  This is the
	// OWASP-recommended mitigation.
	const c0 = s.charCodeAt(0);
	const dangerousLead =
		c0 === 0x3d /* = */ ||
		c0 === 0x2b /* + */ ||
		c0 === 0x2d /* - */ ||
		c0 === 0x40 /* @ */ ||
		c0 === 0x09 /* tab */ ||
		c0 === 0x0d; /* CR */
	if (dangerousLead) {
		// Prefix with a single quote — most spreadsheet apps
		// treat this as "literal text, do not parse as formula".
		return `"'${s.replace(/"/g, '""')}"`;
	}
	if (needsQuotes) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/** Format a signed BLURT amount as a fixed-precision string with
 *  3 fractional digits, sign always shown.  Spreadsheets parse
 *  this cleanly into a numeric column when CSV-injection
 *  prefixing isn't applied. */
function formatSignedBlurt(n: number): string {
	if (!Number.isFinite(n)) return '';
	// toFixed handles negatives.  We DON'T add a + for positives
	// because a leading + would trigger the CSV-injection guard,
	// turning the column into text in spreadsheets.  Negative
	// numbers are fine — `-` IS in the dangerous-lead list, but
	// only when it's THE FIRST character of an otherwise-text
	// field.  Pure numeric values bypass the dangerous-lead check
	// because formatSignedBlurt produces only digits, decimal
	// point, and a possible leading minus.  Spreadsheets parse
	// "-0.500" correctly as a number.
	//
	// HOWEVER, our `quote()` function would still detect the
	// leading `-` and force-prefix.  Bypass by writing the
	// numeric column WITHOUT going through quote().  Direct
	// concat is safe because the value is always a clean numeric
	// literal.
	return n.toFixed(3);
}

/** Build a CSV string from a P&L row list.  Output starts with a
 *  UTF-8 BOM so Excel-on-Windows opens UTF-8 memos without
 *  mojibake. */
export function buildPnlCsv(
	rows: readonly PnlRow[],
	headers: CsvHeaders,
	categoryLabels: CategoryLabels
): string {
	const headerLine = [
		quote(headers.timestamp),
		quote(headers.category),
		quote(headers.counterparty),
		quote(headers.blurtAmount),
		quote(headers.memo),
		quote(headers.trxId),
		quote(headers.block)
	].join(',');

	const lines: string[] = [headerLine];
	for (const r of rows) {
		// Numeric column: no quoting (we control the format).
		// Other columns: quote-as-needed.
		const cols = [
			quote(r.timestamp),
			quote(categoryLabels[r.category]),
			quote(r.counterparty),
			formatSignedBlurt(r.blurtSigned),
			quote(r.memo),
			quote(r.trxId),
			String(r.block)
		];
		lines.push(cols.join(','));
	}

	// UTF-8 BOM so Excel on Windows handles UTF-8 memos correctly.
	const BOM = '\uFEFF';
	return BOM + lines.join('\r\n') + '\r\n';
}

/** Convenience: trigger a browser download of a CSV string.
 *  Caller controls filename. */
export function downloadCsv(csv: string, filename: string): void {
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	// Defer revoke so the click handler has time to read.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
