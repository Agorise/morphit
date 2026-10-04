/**
 * Re-installing a clearnet node as tor-only:
 * the wizard says the old identity stays linkable and offers fresh .onion and
 * I2P addresses (the old key directories are moved aside, kept).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offerTorOnlyRekey, readPriorIdentity } from '../src/lib/torOnlyRekey.ts';

function box(origin: string | null) {
	const d = mkdtempSync(join(tmpdir(), 'rekey-'));
	const cfg = join(d, 'morphit.config.env');
	writeFileSync(cfg, `MORPHIT_INSTANCE_ORIGIN=${origin ?? ''}\nMORPHIT_OPERATOR_ACCOUNT=oldop\n`);
	mkdirSync(join(d, 'tor', 'morphit'), { recursive: true });
	writeFileSync(join(d, 'tor', 'morphit', 'hs_ed25519_secret_key'), 'k');
	mkdirSync(join(d, 'i2pd'));
	writeFileSync(join(d, 'i2pd', 'morphit-web.dat'), 'k');
	const paths = {
		configEnvFiles: [cfg],
		torHsDir: join(d, 'tor', 'morphit'),
		i2pKeyFile: join(d, 'i2pd', 'morphit-web.dat')
	};
	return { d, paths };
}

describe('tor-only over a former clearnet node', () => {
	it('warns that the old identity stays linked and, on yes, moves the onion and I2P keys aside', async () => {
		const { d, paths } = box('https://trade.example.com');
		const out: string[] = [];
		const asked: string[] = [];
		const r = await offerTorOnlyRekey(
			readPriorIdentity(paths),
			{
				print: (s) => void out.push(s),
				askYesNo: async (q) => (asked.push(q), true)
			},
			paths
		);
		expect(out.join('\n')).toMatch(
			/trade\.example\.com[\s\S]*link[\s\S]*NEW Blurt operator account \(not @oldop\)/
		);
		expect(asked.join(' ')).toMatch(/fresh \.onion and I2P/);
		expect(r).toBe('rekeyed');
		expect(existsSync(paths.torHsDir)).toBe(false);
		expect(existsSync(paths.i2pKeyFile)).toBe(false);
		expect(readdirSync(join(d, 'tor')).some((n) => n.startsWith('morphit.linked-'))).toBe(true);
	});

	it('on no, keeps the keys and says the node stays linkable', async () => {
		const { paths } = box('https://trade.example.com');
		const out: string[] = [];
		const r = await offerTorOnlyRekey(
			readPriorIdentity(paths),
			{ print: (s) => void out.push(s), askYesNo: async () => false },
			paths
		);
		expect(r).toBe('kept');
		expect(existsSync(paths.torHsDir)).toBe(true);
		expect(out.join('\n')).toMatch(/stays linkable/);
	});

	it('a box that was never clearnet is not asked', async () => {
		const { paths } = box(null);
		let asked = false;
		const r = await offerTorOnlyRekey(
			readPriorIdentity(paths),
			{ print: () => {}, askYesNo: async () => (asked = true) },
			paths
		);
		expect(r).toBe('not-needed');
		expect(asked).toBe(false);
	});

	it('the install wizard offers it right after the tor-only choice', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('../src/init/runAnsibleInstall.ts', import.meta.url), 'utf8');
		expect(src).toMatch(
			/const torOnly = await askTorOnly\(\);\s*(?:\/\/[^\n]*\n\s*)*if \(torOnly\)\s*await offerTorOnlyRekey\(readPriorIdentity\(\)/
		);
	});
});
