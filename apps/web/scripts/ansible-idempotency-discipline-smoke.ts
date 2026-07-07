#!/usr/bin/env tsx
/**
 * ansible-idempotency-discipline-smoke — Part 122 cp69 (LL #69 / O-18).
 *
 * The Ansible README claims "Every role is written to be idempotent —
 * re-running the playbook is a no-op when the system is in the
 * desired state."  Many tasks earn this automatically (modules like
 * `user:`, `file:`, `apt:`, `template:` are idempotent by design).
 * Tasks that use `ansible.builtin.command:`, `ansible.builtin.shell:`,
 * or `ansible.builtin.raw:` execute arbitrary processes — Ansible
 * CANNOT know whether they changed state, so the operator MUST add
 * an explicit guard:
 *
 *   - `creates: <path>` — Ansible skips the task if `<path>` exists.
 *   - `removes: <path>` — Ansible skips if `<path>` doesn't exist.
 *   - `changed_when: <expr>` — operator declares the change condition.
 *   - `when: <expr>` — conditional that prevents re-run (e.g. fact gate).
 *   - `check_mode: false` + `changed_when: false` — explicitly "read-only".
 *
 * This smoke walks ops/ansible/ and identifies every `command:`,
 * `shell:`, or `raw:` task.  Each MUST have at least one of the
 * guards above.  Tasks without a guard re-run on every playbook
 * invocation, making the claim "playbook is idempotent" false.
 *
 * The smoke distinguishes a TASK-LEVEL `shell:` (the action being
 * taken) from a MODULE-PROPERTY `shell:` (e.g. `ansible.builtin.user`
 * has a `shell:` field that sets the LOGIN shell of the created
 * user).  Heuristic: a task-level `command:` / `shell:` / `raw:`
 * appears as a top-level key under `- name:`, while user-creation
 * `shell:` is indented under `ansible.builtin.user:` — at greater
 * indentation than the action key.
 *
 * Mutation test M-141: add a `command: /usr/local/bin/something` task
 * to a role's main.yml WITHOUT a guard → smoke fires with the file +
 * task name.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── ansible-idempotency-discipline smoke (cp69 LL #69 / O-18) ──\n');

interface TaskInfo {
	filePath: string;
	name: string;
	startLine: number;
	usesAction: 'command' | 'shell' | 'raw';
	hasGuard: boolean;
}

function walkYaml(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) {
			walkYaml(p, out);
		} else if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
			out.push(p);
		}
	}
}

const ansibleDir = join(REPO_ROOT, 'ops/ansible');
const ymlFiles: string[] = [];
try {
	walkYaml(ansibleDir, ymlFiles);
} catch (e) {
	fail('Walk ops/ansible/', `Could not walk: ${(e as Error).message}`);
}

const GUARD_KEYS = [
	'creates:',
	'removes:',
	'changed_when:',
	'when:',
	'check_mode:',
];

const TASK_LEVEL_ACTIONS: ('command' | 'shell' | 'raw')[] = ['command', 'shell', 'raw'];

const allTasks: TaskInfo[] = [];

for (const file of ymlFiles) {
	const src = readFileSync(file, 'utf-8');
	const lines = src.split('\n');
	// Walk task by task.  A task starts with `^- name:` or `^-name:` (any indent).
	let currentTaskStart = -1;
	let currentTaskName = '';
	let currentTaskIndent = -1;
	let currentTaskHasAction: 'command' | 'shell' | 'raw' | null = null;
	let currentTaskHasGuard = false;

	for (let i = 0; i <= lines.length; i++) {
		const isEnd = i === lines.length;
		const line = isEnd ? '' : lines[i];
		const taskStart = line.match(/^(\s*)- name:\s*(.+)$/);

		if (taskStart || isEnd) {
			// Finalize previous task
			if (currentTaskStart >= 0 && currentTaskHasAction) {
				allTasks.push({
					filePath: file,
					name: currentTaskName,
					startLine: currentTaskStart + 1,
					usesAction: currentTaskHasAction,
					hasGuard: currentTaskHasGuard,
				});
			}
			if (taskStart) {
				currentTaskStart = i;
				currentTaskIndent = taskStart[1].length;
				currentTaskName = taskStart[2].trim();
				currentTaskHasAction = null;
				currentTaskHasGuard = false;
			}
			continue;
		}

		if (currentTaskStart < 0) continue;

		// Lines that belong to the current task: indent > currentTaskIndent,
		// or empty.
		const lineIndent = (line.match(/^(\s*)/) || ['', ''])[1].length;
		if (line.trim() === '') continue;
		if (lineIndent <= currentTaskIndent) {
			// End of current task without seeing next `- name:` — shouldn't
			// happen in well-formed YAML, but bail safely.
			continue;
		}

		// Detect TASK-LEVEL action key.  Task-level keys appear at exactly
		// `currentTaskIndent + 2` spaces (the `- ` plus the key).
		const expectedTaskKeyIndent = currentTaskIndent + 2;
		if (lineIndent === expectedTaskKeyIndent) {
			for (const action of TASK_LEVEL_ACTIONS) {
				if (line.trim().startsWith(`${action}:`) || line.trim().startsWith(`ansible.builtin.${action}:`)) {
					currentTaskHasAction = action;
				}
			}
			// Detect task-level guards
			for (const guard of GUARD_KEYS) {
				if (line.trim().startsWith(guard)) {
					currentTaskHasGuard = true;
				}
			}
		}

		// Some guards belong INSIDE the action module's argument block.
		// `creates:` and `removes:` are module-level arguments under
		// `ansible.builtin.shell:` or `ansible.builtin.command:`, not
		// task-level keys.  Accept them at any deeper indent within the
		// current task.
		if (lineIndent > expectedTaskKeyIndent) {
			for (const guard of ['creates:', 'removes:']) {
				if (line.trim().startsWith(guard)) {
					currentTaskHasGuard = true;
				}
			}
		}
	}
}

const ungarded = allTasks.filter((t) => !t.hasGuard);
const guarded = allTasks.filter((t) => t.hasGuard);

console.log(`▸ Ansible task scan: ${allTasks.length} command/shell/raw tasks found`);
console.log(`  ${guarded.length} have an idempotency guard (creates/removes/changed_when/when/check_mode)`);
console.log(`  ${ungarded.length} are UNGUARDED — will re-run on every playbook invocation`);
console.log('');

// Allow-list for ungarded tasks that are LEGITIMATELY one-shot or
// where re-running is genuinely a no-op for the system state (e.g.
// commands that print info to stdout but don't change anything).
const ALLOW_LIST = new Set<string>([
	// 'ops/ansible/roles/X/tasks/Y.yml::Task name here',
]);

for (const t of ungarded) {
	const relPath = t.filePath.replace(REPO_ROOT + '/', '');
	const key = `${relPath}::${t.name}`;
	if (ALLOW_LIST.has(key)) {
		console.log(`  ⊝ ${relPath}:${t.startLine} "${t.name}" (action: ${t.usesAction}) — ALLOWED`);
		continue;
	}
	fail(
		`${relPath}:${t.startLine} task "${t.name}" has idempotency guard`,
		`Task uses \`${t.usesAction}:\` but has no guard (creates:/removes:/changed_when:/when:/check_mode:).  ` +
			`This task will re-run on every playbook invocation, violating the README's idempotency claim.  ` +
			`Add an appropriate guard or document why it's a true no-op via the smoke's ALLOW_LIST.`
	);
}

if (ungarded.length === 0 || ungarded.every((t) => ALLOW_LIST.has(`${t.filePath.replace(REPO_ROOT + '/', '')}::${t.name}`))) {
	pass(`All ${allTasks.length} command/shell/raw tasks have idempotency guards or are allow-listed`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nansible-idempotency-discipline smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} ansible-idempotency-discipline scenarios passed`);
