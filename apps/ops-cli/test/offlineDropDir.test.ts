/**
 * The offline drop directory: a release
 * publishes the offline bundle with only its .sha256 (no .asc — it is checked
 * against the signed on-chain offline_sha256). The drop-dir fallback required
 * an .asc, so it could never find a published bundle.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLocalOfflineRelease } from '../src/commands/upgrade.ts';

const d = mkdtempSync(join(tmpdir(), 'offline-drop-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));

describe('findLocalOfflineRelease', () => {
	it('finds a bundle dropped with exactly the release page assets (.tar.gz + .sha256)', () => {
		const install = join(d, 'morphit');
		mkdirSync(`${install}-offline`, { recursive: true });
		writeFileSync(join(`${install}-offline`, 'morphit-v1.21.0-offline.tar.gz'), 'x');
		writeFileSync(join(`${install}-offline`, 'morphit-v1.21.0-offline.tar.gz.sha256'), 'y');
		const r = findLocalOfflineRelease(install);
		expect(r, 'a published bundle was not found').not.toBeNull();
		expect(r!.tag).toBe('v1.21.0');
		expect(r!.sigPath).toBeNull();
	});
});
