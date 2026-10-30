/**
 * scripts/generate-onion.sh and scripts/generate-i2p.sh, run for real with a
 * stand-in for the slow key grinder (mkp224o / vain): the next steps they
 * print install the key into the service the server ALREADY runs.
 *
 *  - Tor: the key files go INTO /var/lib/tor/morphit, owned by debian-tor,
 *    mode 700 (Tor refuses a directory it does not own — the old "copy the
 *    directory, root-owned 0700" broke the onion), no torrc lines (Ansible
 *    manages them), `scp -O` (a hardened server has SFTP off).
 *  - I2P: the key replaces /var/lib/i2pd/morphit-web.dat (owner i2pd) — the
 *    file the Ansible [morphit-web] tunnel uses — instead of a second
 *    [morphit] tunnel; `scp -O`, not plain scp as a non-root user.
 *  - The I2P address is computed without xxd (not on every computer).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');
let dir = '';
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'gen-alt-'));
	mkdirSync(join(dir, 'bin'));
	mkdirSync(join(dir, 'run'));
	// mkp224o -n 1 -d DIR -t N PREFIX: one "found" key directory.
	writeFileSync(
		join(dir, 'bin', 'mkp224o'),
		'#!/bin/sh\nd="$4"; a="$7$(printf \'a%.0s\' $(seq 1 $((56-${#7}))))"\n' +
			'mkdir -p "$d/$a.onion"; echo "$a.onion" > "$d/$a.onion/hostname"\n' +
			'head -c 96 /dev/zero > "$d/$a.onion/hs_ed25519_secret_key"; head -c 64 /dev/zero > "$d/$a.onion/hs_ed25519_public_key"\n'
	);
	// vain PREFIX: writes private.dat in the current directory.
	writeFileSync(join(dir, 'bin', 'vain'), '#!/bin/sh\nhead -c 600 /dev/urandom > private.dat\n');
	chmodSync(join(dir, 'bin', 'mkp224o'), 0o755);
	chmodSync(join(dir, 'bin', 'vain'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** PATH with the stand-ins and without xxd. */
function pathWithoutXxd(): string {
	const noXxd = join(dir, 'sys');
	mkdirSync(noXxd);
	for (const tool of [
		'sh',
		'bash',
		'head',
		'mkdir',
		'find',
		'basename',
		'sha256sum',
		'cut',
		'base32',
		'tr',
		'openssl',
		'printf',
		'seq',
		'nproc',
		'cat',
		'dirname',
		'echo'
	]) {
		const w = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
		if (w.startsWith('/')) spawnSync('ln', ['-s', w, join(noXxd, tool)]);
	}
	return `${join(dir, 'bin')}:${noXxd}`;
}

const run = (script: string, args: string[], path: string): string => {
	const r = spawnSync('bash', [join(REPO, 'scripts', script), ...args], {
		cwd: join(dir, 'run'),
		encoding: 'utf8',
		env: { PATH: path, HOME: dir }
	});
	expect(r.status, r.stderr).toBe(0);
	return r.stdout;
};

describe('generate-onion.sh', () => {
	it('prints steps that put the key into the existing hidden service, owned by Tor', () => {
		const out = run(
			'generate-onion.sh',
			['morph', 'root@node.example'],
			`${join(dir, 'bin')}:${process.env.PATH}`
		);
		const onion = `morph${'a'.repeat(51)}.onion`;
		expect(out).toContain(`Your new address is:\n  ${onion}`);
		expect(out).toMatch(/On THIS computer, copy the key to your server:/);
		expect(out).toContain(
			'scp -O hs_ed25519_secret_key hs_ed25519_public_key hostname root@node.example:/root/'
		);
		expect(out).toMatch(/On the SERVER \(logged in as root\), keep a copy of the current key/);
		expect(out).toContain(
			'sudo install -o debian-tor -g debian-tor -m 600 /root/hs_ed25519_secret_key /root/hs_ed25519_public_key /var/lib/tor/morphit/'
		);
		expect(out).toContain('sudo chown -R debian-tor:debian-tor /var/lib/tor/morphit');
		expect(out).toContain('sudo chmod 700 /var/lib/tor/morphit');
		expect(out).toContain('sudo systemctl restart tor');
		expect(out).toContain('sudo cat /var/lib/tor/morphit/hostname');
		expect(out).not.toMatch(/HiddenServiceDir|torrc|root-owned/);
		expect(out).not.toMatch(/(^|\s)scp (?!-O)/m);
	});
});

describe('generate-i2p.sh', () => {
	it('replaces the [morphit-web] key file (owner i2pd), adds no tunnel, and works without xxd', () => {
		const out = run('generate-i2p.sh', ['morph', 'root@node.example'], pathWithoutXxd());
		const key = readFileSync(join(dir, 'run', 'hidden-services', 'i2p-morph', 'private.dat'));
		const b32 = base32(createHash('sha256').update(key.subarray(0, 391)).digest());
		expect(out).toContain(`Your address is:\n  ${b32}.b32.i2p`);
		expect(out).toMatch(/scp -O "[^"]+private\.dat" root@node\.example:\/root\/morphit-web\.dat/);
		expect(out).toContain(
			'sudo install -o i2pd -g i2pd -m 600 /root/morphit-web.dat /var/lib/i2pd/morphit-web.dat'
		);
		expect(out).toContain('sudo systemctl restart i2pd');
		expect(out).not.toMatch(/^\s*\[morphit\]\s*$/m);
		expect(out).not.toMatch(/keys = morphit\.dat/);
		expect(out).not.toMatch(/(^|\s)scp (?!-O)/m);
	});
});

describe('the account the copies go to (a hardened server refuses root over ssh)', () => {
	it('generate-onion.sh with alice@…: the key goes to alice’s home, installed from there with sudo', () => {
		const out = run(
			'generate-onion.sh',
			['morph', 'alice@node.example'],
			`${join(dir, 'bin')}:${process.env.PATH}`
		);
		expect(out).toContain(
			'scp -O hs_ed25519_secret_key hs_ed25519_public_key hostname alice@node.example:\n'
		);
		expect(out).toMatch(/On the SERVER \(logged in as alice\)/);
		expect(out).toContain(
			'sudo install -o debian-tor -g debian-tor -m 600 ~/hs_ed25519_secret_key ~/hs_ed25519_public_key /var/lib/tor/morphit/'
		);
		expect(out).toContain('sudo shred -u ~/hs_ed25519_secret_key');
		expect(out).not.toMatch(/root@|\/root\/hs_ed25519/);
	});

	it('generate-i2p.sh with alice@…: the key goes to alice’s home', () => {
		const out = run('generate-i2p.sh', ['morph', 'alice@node.example'], pathWithoutXxd());
		expect(out).toMatch(/scp -O "[^"]+private\.dat" alice@node\.example:morphit-web\.dat$/m);
		expect(out).toContain(
			'sudo install -o i2pd -g i2pd -m 600 ~/morphit-web.dat /var/lib/i2pd/morphit-web.dat'
		);
		expect(out).not.toMatch(/root@|\/root\/morphit-web\.dat /);
	});
});

describe('run again with the same letters', () => {
	it('generate-onion.sh: a new folder, and the NEW address and its exact folder are the ones printed', () => {
		const path = `${join(dir, 'bin')}:${process.env.PATH}`;
		// A stand-in that makes a different address each run.
		writeFileSync(
			join(dir, 'bin', 'mkp224o'),
			'#!/bin/sh\nd="$4"; n=$(cat "$HOME/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$HOME/n"\n' +
				'l=$(printf "%s" "abcdefghij" | cut -c$n); a="$7$(printf "$l%.0s" $(seq 1 $((56-${#7}))))"\n' +
				'mkdir -p "$d/$a.onion"; echo "$a.onion" > "$d/$a.onion/hostname"; : > "$d/$a.onion/hs_ed25519_secret_key"\n'
		);
		run('generate-onion.sh', ['morph', 'root@node.example'], path);
		const second = run('generate-onion.sh', ['morph', 'root@node.example'], path);
		const newOnion = `morph${'b'.repeat(51)}.onion`;
		const folder = join(dir, 'run', 'hidden-services', 'tor-morph-2', newOnion);
		expect(second).toContain(`Your new address is:\n  ${newOnion}`);
		expect(second).toContain(`cd "${folder}"`);
		expect(second).not.toContain(`morph${'a'.repeat(51)}`);
		// The first key is where it was.
		expect(
			readFileSync(
				join(
					dir,
					'run',
					'hidden-services',
					'tor-morph',
					`morph${'a'.repeat(51)}.onion`,
					'hostname'
				),
				'utf8'
			)
		).toContain('morph');
	});

	it('generate-i2p.sh: a new folder; the first key is not overwritten, the new one is the one used', () => {
		const path = pathWithoutXxd();
		const first = run('generate-i2p.sh', ['morph', 'root@node.example'], path);
		const key1 = readFileSync(join(dir, 'run', 'hidden-services', 'i2p-morph', 'private.dat'));
		const second = run('generate-i2p.sh', ['morph', 'root@node.example'], path);
		const key2 = readFileSync(join(dir, 'run', 'hidden-services', 'i2p-morph-2', 'private.dat'));
		expect(readFileSync(join(dir, 'run', 'hidden-services', 'i2p-morph', 'private.dat'))).toEqual(
			key1
		);
		const b32 = (k: Buffer): string =>
			`${base32(createHash('sha256').update(k.subarray(0, 391)).digest())}.b32.i2p`;
		expect(first).toContain(`Your address is:\n  ${b32(key1)}`);
		expect(second).toContain(`Your address is:\n  ${b32(key2)}`);
		expect(second).toContain(
			`"${join(dir, 'run', 'hidden-services', 'i2p-morph-2', 'private.dat')}"`
		);
	});
});

/** RFC 4648 base32, lower case, no padding. */
function base32(buf: Buffer): string {
	const A = 'abcdefghijklmnopqrstuvwxyz234567';
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of buf) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += A[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += A[(value << (5 - bits)) & 31];
	return out;
}
