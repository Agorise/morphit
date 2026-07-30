import { describe, expect, it } from 'vitest';
import {
	generatePlaintextCodes,
	hashCodesForStorage,
	redeemBackupCode,
	canonicalize,
	displayFormat,
	unusedSlotCount,
	BACKUP_CODE_LENGTH,
	BACKUP_CODE_COUNT,
	type BackupCodeSlot
} from './backupCodes';

describe('backup codes — generation', () => {
	it('generates BACKUP_CODE_COUNT distinct codes', () => {
		const codes = generatePlaintextCodes();
		expect(codes.length).toBe(BACKUP_CODE_COUNT);
		expect(BACKUP_CODE_COUNT).toBe(10);
		expect(new Set(codes).size).toBe(codes.length); // all unique
	});

	it('each code is in display form: XXXX-XXXX', () => {
		const codes = generatePlaintextCodes();
		for (const code of codes) {
			expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		}
	});

	it('canonicalized codes are 8 characters from the Crockford alphabet', () => {
		const codes = generatePlaintextCodes();
		for (const code of codes) {
			const c = canonicalize(code);
			expect(c.length).toBe(BACKUP_CODE_LENGTH);
			expect(c).toMatch(/^[A-HJ-NP-Z2-9]+$/); // Crockford: no 0, O, 1, I
		}
	});

	it('canonicalize is idempotent and case-insensitive', () => {
		expect(canonicalize('ABCD-EFGH')).toBe('ABCDEFGH');
		expect(canonicalize('abcd-efgh')).toBe('ABCDEFGH');
		expect(canonicalize(' ab-cd-ef-gh ')).toBe('ABCDEFGH');
		expect(canonicalize(canonicalize('ABCD-EFGH'))).toBe('ABCDEFGH');
	});

	it('displayFormat inserts dash at position 4', () => {
		expect(displayFormat('ABCDEFGH')).toBe('ABCD-EFGH');
		expect(displayFormat('abcd-efgh')).toBe('ABCD-EFGH');
	});
});

describe('backup codes — hashing + redemption round-trip', () => {
	it('a freshly-generated code redeems successfully', async () => {
		const plaintext = generatePlaintextCodes();
		const slots = await hashCodesForStorage(plaintext);
		expect(slots.length).toBe(BACKUP_CODE_COUNT);

		// Pick the 3rd code, try to redeem it.
		const result = await redeemBackupCode(plaintext[2]!, slots);
		expect(result.kind).toBe('matched');
		if (result.kind === 'matched') {
			expect(result.index).toBe(2);
			expect(result.slots[2]!.used).toBe(true);
			expect(result.slots[2]!.usedAt).toBeGreaterThan(0);
			// The other slots are unchanged.
			expect(result.slots[0]!.used).toBe(false);
			expect(result.slots[1]!.used).toBe(false);
			expect(result.slots[3]!.used).toBe(false);
		}
	}, 30_000);

	it('redemption is case- and dash-insensitive', async () => {
		const plaintext = generatePlaintextCodes();
		const slots = await hashCodesForStorage(plaintext);

		// Try the first code with weird casing + extra spaces.
		const display = plaintext[0]!; // e.g. "ABCD-EFGH"
		const weirdInput = display.toLowerCase().replace('-', ' - ') + ' ';
		const result = await redeemBackupCode(weirdInput, slots);
		expect(result.kind).toBe('matched');
	}, 30_000);

	it('redeeming the same code twice fails the second time', async () => {
		const plaintext = generatePlaintextCodes();
		const slots = await hashCodesForStorage(plaintext);

		const first = await redeemBackupCode(plaintext[0]!, slots);
		expect(first.kind).toBe('matched');
		if (first.kind !== 'matched') return;

		// Use the UPDATED slots for the second attempt.
		const second = await redeemBackupCode(plaintext[0]!, first.slots);
		expect(second.kind).toBe('already_used');
	}, 60_000);

	it('an unknown code returns no_match', async () => {
		const plaintext = generatePlaintextCodes();
		const slots = await hashCodesForStorage(plaintext);

		const result = await redeemBackupCode('XXXX-YYYY', slots);
		expect(result.kind).toBe('no_match');
	}, 30_000);

	it('a malformed (wrong-length) code returns no_match without hashing', async () => {
		const plaintext = generatePlaintextCodes();
		const slots = await hashCodesForStorage(plaintext);

		expect((await redeemBackupCode('AB', slots)).kind).toBe('no_match');
		expect((await redeemBackupCode('ABCDEFGHIJ', slots)).kind).toBe('no_match');
		expect((await redeemBackupCode('', slots)).kind).toBe('no_match');
	}, 30_000);

	it('unusedSlotCount tracks redemptions', async () => {
		const plaintext = generatePlaintextCodes();
		let slots = await hashCodesForStorage(plaintext);
		expect(unusedSlotCount(slots)).toBe(10);

		const r1 = await redeemBackupCode(plaintext[0]!, slots);
		if (r1.kind === 'matched') slots = r1.slots;
		expect(unusedSlotCount(slots)).toBe(9);

		const r2 = await redeemBackupCode(plaintext[5]!, slots);
		if (r2.kind === 'matched') slots = r2.slots;
		expect(unusedSlotCount(slots)).toBe(8);
	}, 60_000);

	it('hashCodesForStorage rejects malformed input', async () => {
		await expect(hashCodesForStorage(['SHORT', 'ABCD-EFGH'])).rejects.toThrow(/canonicalized/);
	});
});
