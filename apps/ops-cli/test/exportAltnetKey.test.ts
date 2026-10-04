/**
 * `export-altnet-key --out` never writes the plaintext key into a file someone
 * else already made.
 *
 * It did `writeFileSync(out, key, { mode: 0o600 })` then chmod. Mode applies
 * only to a NEW file: a file another user pre-created at the predictable path
 * the usage text recommends (/dev/shm/morphit-tor-key), mode 0666, was written
 * through, stayed owned by that user, and that user read the secret. A symlink
 * there redirected the write. The file is now created exclusively and never
 * through a symlink.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../src/init/prompt.ts', () => ({ askPassword: async () => 'correct horse battery' }));

import { runExportAltnetKey } from '../src/commands/exportAltnetKey.ts';
import { encryptAltKey, altKeystoreFilename } from '../src/init/altKeystore.ts';

const SECRET = Buffer.from('ED25519-V3:the-onion-service-secret-key');
let repo = '';
let out = '';

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'morphit-export-'));
	mkdirSync(join(repo, 'apps', 'relay', 'altnet'), { recursive: true });
	writeFileSync(
		join(repo, 'apps', 'relay', 'altnet', altKeystoreFilename('tor')),
		JSON.stringify(encryptAltKey(SECRET, 'correct horse battery', 'tor'))
	);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

beforeEach(() => {
	out = join(mkdtempSync(join(repo, 'shm-')), 'morphit-tor-key');
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

const exportTo = (path: string) =>
	runExportAltnetKey({
		flags: { network: 'tor', out: path, repo },
		positional: [],
		colorEnabled: false
	});

describe('export-altnet-key --out', () => {
	it('writes a new file, 0600, with the key', async () => {
		expect(await exportTo(out)).toBe(0);
		expect(readFileSync(out)).toEqual(SECRET);
		expect(statSync(out).mode & 0o777).toBe(0o600);
	});

	it('refuses a file that already exists, and writes nothing into it', async () => {
		writeFileSync(out, '');
		chmodSync(out, 0o666);
		if (process.getuid?.() === 0) chownSync(out, 65534, 65534); // made by "nobody"
		expect(await exportTo(out)).not.toBe(0);
		expect(readFileSync(out).length, 'the secret went into a file another user owns').toBe(0);
	});

	it('refuses a symlink, and writes nothing where it points', async () => {
		const elsewhere = join(repo, 'elsewhere');
		rmSync(elsewhere, { force: true });
		symlinkSync(elsewhere, out);
		expect(await exportTo(out)).not.toBe(0);
		expect(existsSync(elsewhere), 'the write followed a symlink').toBe(false);
		expect(lstatSync(out).isSymbolicLink()).toBe(true);
	});
});
