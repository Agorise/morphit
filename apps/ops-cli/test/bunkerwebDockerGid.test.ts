/**
 * `morphit-ops bunkerweb` brings up the shipped compose, whose scheduler needs
 * the host's docker group: Compose refuses to
 * start without DOCKER_GID in /etc/bunkerweb/.env. The installer writes it
 * before `docker compose pull/up`, and keeps a value the operator set.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bw from '../src/commands/bunkerweb.ts';

type Ensure = (
	dir: string,
	gidOf?: () => string | null
) => Promise<{ ok: boolean; detail: string }>;
const ensure = (bw as { ensureDockerGidEnv?: Ensure }).ensureDockerGidEnv;
const root = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(!root)('DOCKER_GID for the BunkerWeb scheduler', () => {
	it('is written to a missing .env, root-only readable', async () => {
		expect(ensure, 'the installer never writes DOCKER_GID').toBeTypeOf('function');
		const d = mkdtempSync(join(tmpdir(), 'bw-gid-'));
		const r = await ensure!(d, () => '998');
		expect(r.ok).toBe(true);
		expect(readFileSync(join(d, '.env'), 'utf8')).toBe('DOCKER_GID=998\n');
		expect(statSync(join(d, '.env')).mode & 0o777).toBe(0o640);
	});

	it('is appended to an existing .env without a newline at its end', async () => {
		const d = mkdtempSync(join(tmpdir(), 'bw-gid-'));
		writeFileSync(join(d, '.env'), 'OTHER=1');
		expect((await ensure!(d, () => '998')).ok).toBe(true);
		expect(readFileSync(join(d, '.env'), 'utf8')).toBe('OTHER=1\nDOCKER_GID=998\n');
	});

	it('keeps a value the operator set', async () => {
		const d = mkdtempSync(join(tmpdir(), 'bw-gid-'));
		writeFileSync(join(d, '.env'), 'DOCKER_GID=123\n');
		expect((await ensure!(d, () => '998')).ok).toBe(true);
		expect(readFileSync(join(d, '.env'), 'utf8')).toBe('DOCKER_GID=123\n');
	});

	it('says so when the server has no docker group', async () => {
		const d = mkdtempSync(join(tmpdir(), 'bw-gid-'));
		const r = await ensure!(d, () => null);
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/no docker group/);
	});
});
