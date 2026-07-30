/**
 * local-install-smoke.ts (cp600) — locks the two changes that make the Ansible
 * playbook safe to run LOCALLY on grandma's box (the real run is Beelink-only,
 * so this guards against a future edit silently reintroducing a hard-fail):
 *   1. the pre-flight allows running as root when morphit_local_install is set
 *      (a local console has no SSH session to lock out);
 *   2. the morphit role deploys the operator's DOWNLOADED release
 *      (morphit_local_source_path) instead of cloning git — so "just the
 *      tarball" is genuinely enough.
 * Also re-checks the touched YAML still parses.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 local-install smoke (cp600) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

const playbook = R('ops/ansible/playbook.yml');
const cloneBuild = R('ops/ansible/roles/morphit/tasks/clone_and_build.yml');
const allYml = R('ops/ansible/group_vars/all.yml');

// helper: strip comment lines before grepping (a fix's own comment can name the
// pattern it replaced — same rule as the other smokes).
const noComments = (s: string): string =>
	s
		.split('\n')
		.filter((l) => !l.trimStart().startsWith('#'))
		.join('\n');
const pb = noComments(playbook);
const cb = noComments(cloneBuild);

// 1. root allowed for a local install.
check('pre-flight allows root when morphit_local_install is set', /ansible_user\s*!=\s*"root"\s*or\s*\(?\s*morphit_local_install/.test(pb));
check('pre-flight still requires non-root in general (remote SSH safety kept)', /ansible_user\s*!=\s*"root"/.test(pb));

// 2. local-source deploy (the tarball is enough).
check('git clone is GATED to the no-local-source case', /morphit_local_source_path[^\n]*length\s*==\s*0/.test(cb));
check('there is a task copying the local source into place (tar-pipe, excludes node_modules)', /tar -C/.test(cb) && /--exclude=node_modules/.test(cb) && /morphit_local_source_path/.test(cb));
check('the local copy is gated to when a source path is given', /morphit_local_source_path[^\n]*length\s*>\s*0/.test(cb));
check('the local copy is skipped when source == repo path (no self-copy)', /morphit_local_source_path\s*!=\s*morphit_repo_path/.test(cb));
check('npm install + build still run regardless of source (shared tasks kept)', /npm install --workspaces/.test(cb) && /npm run build --workspaces/.test(cb));

// 3. the group_var defaults exist (off by default → remote installs unaffected).
check('all.yml defines morphit_local_install (default false)', /morphit_local_install:\s*false/.test(allYml));
check('all.yml defines morphit_local_source_path (default empty)', /morphit_local_source_path:\s*""/.test(allYml));

// 4. the touched YAML still parses (python yaml.safe_load, like ddns-role-smoke).
function parses(relPath: string): boolean {
	const r = spawnSync('python3', ['-c', 'import yaml,sys; yaml.safe_load(open(sys.argv[1])); print("ok")', join(ROOT, relPath)], { encoding: 'utf-8' });
	return r.status === 0 && /ok/.test(r.stdout);
}
check('playbook.yml still parses', parses('ops/ansible/playbook.yml'));
check('clone_and_build.yml still parses', parses('ops/ansible/roles/morphit/tasks/clone_and_build.yml'));
check('group_vars/all.yml still parses', parses('ops/ansible/group_vars/all.yml'));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} local-install checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} local-install checks failed`);
	process.exit(1);
}
