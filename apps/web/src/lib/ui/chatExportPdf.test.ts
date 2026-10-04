/**
 * The chat export is an ordinary PDF: no RC4 "lock" that any reader strips
 * and that the copy then oversold as tamper-proof.
 */
import { describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';

import { newChatExportPdf } from './chatExportPdf';

describe('newChatExportPdf', () => {
	it('writes an unencrypted PDF', () => {
		const doc = newChatExportPdf(jsPDF);
		doc.text('hello', 40, 40);
		const pdf = doc.output();
		expect(pdf.startsWith('%PDF-')).toBe(true);
		expect(pdf).not.toMatch(/\/Encrypt\b/);
	});
	it('(control) the options the export used before produce an encrypted file this test detects', () => {
		const doc = new jsPDF({
			unit: 'pt',
			format: 'a4',
			encryption: { ownerPassword: 'x'.repeat(48), userPermissions: ['print', 'copy'] }
		});
		doc.text('hello', 40, 40);
		expect(doc.output()).toMatch(/\/Encrypt\b/);
	});
});
