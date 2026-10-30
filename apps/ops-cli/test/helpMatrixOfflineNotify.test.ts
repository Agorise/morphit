/**
 * `morphit-ops --help` and the main menu, for two items:
 *  - `matrix`: the help listed `[set <mxid>|clear|test]`, without `setup`
 *    (the guided setup), which `matrix` itself accepts;
 *  - `offline-notify`: the help and the menu tip said every app "is tested by
 *    a test note you send yourself". Telegram sends none (its token is checked
 *    with Telegram), and email always sends one (it cannot be skipped).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
let help = '';
beforeAll(() => {
	const r = spawnSync(
		join(REPO, 'node_modules/.bin/tsx'),
		[
			'--tsconfig',
			join(REPO, 'apps/ops-cli/tsconfig.json'),
			join(REPO, 'apps/ops-cli/src/main.ts'),
			'--help'
		],
		{ encoding: 'utf8', timeout: 60_000 }
	);
	help = r.stdout;
}, 90_000);
afterEach(() => {
	vi.restoreAllMocks();
});

/** The help entry of `cmd`: its line and the indented lines after it. */
function entry(cmd: string): string {
	const lines = help.split('\n');
	const at = lines.findIndex((l) => l.startsWith(`  ${cmd} `));
	expect(at).toBeGreaterThan(-1);
	const out = [lines[at]!];
	for (const l of lines.slice(at + 1)) {
		if (!/^ {30,}\S/.test(l)) break;
		out.push(l);
	}
	return out.join('\n').replace(/\s+/g, ' ');
}

describe('matrix in the help', () => {
	it('lists exactly the actions `matrix` accepts', async () => {
		const { runMatrix } = await import('../src/commands/matrix.ts');
		const printed: string[] = [];
		vi.spyOn(console, 'log').mockImplementation(
			(...a: unknown[]) => void printed.push(a.join(' '))
		);
		const rc = await runMatrix({ flags: {}, positional: ['no-such-action'], colorEnabled: false });
		expect(rc).toBe(1);
		const accepted = new Set(
			printed.flatMap((l) => [...l.matchAll(/sudo morphit-ops matrix ([a-z]+)/g)].map((m) => m[1]!))
		);
		expect(accepted.size).toBeGreaterThan(0);
		const head = entry('matrix').match(/^\s*matrix \[([^\]]+)\]/)?.[1] ?? '';
		const listed = new Set(head.split('|').map((w) => w.split(' ')[0]!));
		expect(listed).toEqual(accepted);
	});
});

describe('offline-notify: what really tests each app', () => {
	const tip = async (): Promise<string> => {
		const { MENU_GROUPS } = await import('../src/commands/mainMenu.ts');
		const item = MENU_GROUPS.flatMap((g) => g.items).find((i) => i.subcommand === 'offline-notify');
		return item?.tip ?? '';
	};
	it.each([
		['the help', async () => entry('offline-notify [status]')],
		['the menu tip', tip]
	])('%s says it per app, never "each is tested by a test note"', async (_w, text) => {
		const t = await text();
		expect(t).not.toMatch(/each is tested by a test note/i);
		expect(t).toMatch(/Telegram[^;]*token[^;]*Telegram/);
		expect(t).toMatch(/email always sends you a test note/);
		expect(t).toMatch(/Matrix[^;]*sign-in checked/);
		expect(t).toMatch(/Session is tested only by a test note, which you may skip/);
	});
});
