/**
 * scripts/build-offline-bundle.sh, step 5, with a `docker` on PATH that saves
 * the way Docker 29.8.2 does (verified on both image stores):
 *  - `docker save name:tag@digest` writes RepoTags null — after `docker load`
 *    the image has an ID and no name, so nothing finds it (the bug);
 *  - `docker save name:tag` writes the name, and in the containerd image store
 *    keeps the original index (the pinned digest) inside; the classic store
 *    rewrites the manifests, so the pinned index is not there.
 * The bundle must save by tag, and must refuse a save that cannot prove the
 * loaded image is the pinned one.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'build-offline-bundle.sh');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Step 5 of the script, verbatim, run against a fake repo root. */
function step5(store: 'containerd' | 'classic') {
	const dir = mkdtempSync(join(tmpdir(), 'bundle-base-'));
	try {
		const index = Buffer.from('{"schemaVersion":2,"manifests":[]}');
		const hex = sha(index);
		const ref = `nginx:1.30.5-alpine@sha256:${hex}`;
		const tag = 'nginx:1.30.5-alpine';
		mkdirSync(join(dir, 'repo/ops/ansible/group_vars'), { recursive: true });
		mkdirSync(join(dir, 'repo/ops/bunkerweb/frontend'), { recursive: true });
		writeFileSync(
			join(dir, 'repo/ops/ansible/group_vars/all.yml'),
			'bunkerweb_image: bunkerity/bunkerweb:1.5.10\nbunkerweb_scheduler_image: bunkerity/bunkerweb-scheduler:1.5.10\n'
		);
		writeFileSync(join(dir, 'repo/ops/bunkerweb/frontend/Dockerfile'), `FROM ${ref}\n`);
		// What `docker save` writes for each reference.
		const mk = (name: string, repoTags: string[] | null, withIndex: boolean): string => {
			const d = join(dir, `save-${name}`);
			mkdirSync(join(d, 'blobs/sha256'), { recursive: true });
			writeFileSync(
				join(d, 'manifest.json'),
				JSON.stringify([{ Config: 'blobs/sha256/c', RepoTags: repoTags, Layers: [] }])
			);
			writeFileSync(join(d, 'blobs/sha256/c'), '{}');
			if (withIndex) writeFileSync(join(d, `blobs/sha256/${hex}`), index);
			const t = join(dir, `${name}.tar`);
			// as `docker save` writes it: no ./ prefix on the members
			spawnSync('tar', ['-cf', t, '-C', d, 'manifest.json', 'blobs']);
			return t;
		};
		const byRef = mk('byref', null, store === 'containerd');
		const byTag = mk('bytag', [tag], store === 'containerd');
		const other = mk('other', ['x:1'], false);
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'docker'),
			`#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(join(dir, 'argv'))}
case "$1" in
	save) case "$2" in
		${JSON.stringify(ref)}) cat ${JSON.stringify(byRef)} ;;
		${JSON.stringify(tag)}) cat ${JSON.stringify(byTag)} ;;
		*) cat ${JSON.stringify(other)} ;;
	esac ;;
esac
exit 0
`
		);
		chmodSync(join(bin, 'docker'), 0o755);
		const harness = join(dir, 'harness.sh');
		writeFileSync(
			harness,
			`set -euo pipefail
REPO_ROOT=${JSON.stringify(join(dir, 'repo'))}; VENDOR=${JSON.stringify(join(dir, 'vendor'))}
log() { printf '==> %s\\n' "$*"; }
die() { printf 'DIE %s\\n' "$*" >&2; exit 1; }
mkdir -p "$VENDOR/docker"
eval "$(awk '/^# ── 5\\. Docker images/{p=1} p{print} p&&/^done$/{exit}' ${JSON.stringify(SCRIPT)})"
`
		);
		const r = spawnSync('bash', [harness], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
		});
		const saved = join(dir, 'vendor/docker', `${ref.replace(/[/:]/g, '_')}.tar.gz`);
		let repoTags: unknown = undefined;
		try {
			const mf = spawnSync('tar', ['-xzOf', saved, 'manifest.json'], { encoding: 'utf8' }).stdout;
			repoTags = JSON.parse(mf)[0].RepoTags;
		} catch {
			repoTags = undefined;
		}
		return {
			status: r.status,
			out: `${r.stdout}\n${r.stderr}`,
			argv: readFileSync(join(dir, 'argv'), 'utf8'),
			repoTags,
			files: readdirSync(join(dir, 'vendor/docker'))
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("the offline bundle's frontend base (scripts/build-offline-bundle.sh)", () => {
	it('is saved under its name, so `docker load` gives it one, with the pinned index inside', () => {
		const r = step5('containerd');
		expect(r.out).not.toMatch(/DIE/);
		expect(r.status).toBe(0);
		expect(r.argv).toMatch(/^save nginx:1\.30\.5-alpine$/m);
		expect(r.argv).not.toMatch(/^save nginx:1\.30\.5-alpine@/m);
		expect(r.repoTags).toEqual(['nginx:1.30.5-alpine']);
	});
	it('a Docker whose save rewrites the manifests (classic image store) is refused with what to do — never a bundle that cannot be proven', () => {
		const r = step5('classic');
		expect(r.status).not.toBe(0);
		expect(r.out).toMatch(/containerd image store/);
	});
});
