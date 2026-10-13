/**
 * Ctrl+C in the install's own steps before the playbook (saving the password,
 * installing Ansible, its pre-flight): the run stops as a Ctrl+C — the wizard
 * then says so, with the command to start again — and the vars file holding
 * the database password is removed.
 *
 * Before v1.21.7 only the playbook itself handled it: here the process died
 * with exit 130, no word, and the vars file left in /run (review, 2026-10-12).
 */
import { describe, expect, it } from 'vitest';

import { assembleInstall } from '../src/init/assembleInstall.ts';

const plan = {
	vars: { x: 1 },
	secretsToSave: [],
	playbookPath: '/nonexistent/ops/ansible/playbook.yml',
	varsFilePath: '/nonexistent/vars.json'
};

function deps(at: 'save' | 'ansible' | 'preflight') {
	const seen: string[] = [];
	const ctrlC = (): void => void process.emit('SIGINT');
	return {
		seen,
		d: {
			readOsRelease: () => '',
			writeVarsFile: () => void seen.push('write'),
			removeVarsFile: () => void seen.push('remove'),
			promptSave: async () => {
				seen.push('save');
				if (at === 'save') ctrlC();
			},
			ensureAnsible: async () => {
				seen.push('ansible');
				if (at === 'ansible') ctrlC();
				// The apt child died with the Ctrl+C too.
				return at !== 'ansible';
			},
			probeHosts: async () => {
				seen.push('preflight');
				if (at === 'preflight') ctrlC();
				return { exitCode: 0, output: '  hosts (1):\n    localhost\n' };
			},
			spawn: async () => {
				seen.push('playbook');
				return 0;
			},
			print: () => undefined
		}
	};
}

describe('Ctrl+C before the playbook', () => {
	for (const at of ['save', 'ansible', 'preflight'] as const) {
		it(`during ${at}: stops as a Ctrl+C, the playbook never runs, the vars file is removed`, async () => {
			const before = process.listenerCount('SIGINT');
			const { seen, d } = deps(at);
			await expect(assembleInstall(plan, d)).rejects.toMatchObject({ name: 'AbortError' });
			expect(seen).not.toContain('playbook');
			// Nothing after the step that was stopped (Ansible is not installed
			// after a Ctrl+C at the password screen).
			const next = { save: 'ansible', ansible: 'preflight', preflight: 'playbook' }[at];
			expect(seen).not.toContain(next);
			expect(seen.at(-1)).toBe('remove');
			expect(process.listenerCount('SIGINT')).toBe(before);
		});
	}
});
