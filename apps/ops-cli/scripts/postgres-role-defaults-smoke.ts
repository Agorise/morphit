/**
 * postgres-role-defaults-smoke.
 *
 * The postgres role's "session defaults" task, run for real: its shell is
 * taken from roles/postgres/tasks/main.yml, rendered for a scratch login role
 * and run (as the TEST_DATABASE_URL user, standing in for postgres) twice.
 * A new session of the role must then show jit = off and
 * idle_in_transaction_session_timeout = 5min, and the second run must report
 * no change. ops/postgres/init.sql (a manual install's script) must set the
 * same defaults, and no task may run init.sql (it creates the role, so it
 * failed — silently — on every converge).
 * Without TEST_DATABASE_URL or psql it runs only the static checks.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { repoPath } from './ansible-template-render.ts';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const tasksText = readFileSync(repoPath('ops/ansible/roles/postgres/tasks/main.yml'), 'utf8');
const initSql = readFileSync(repoPath('ops/postgres/init.sql'), 'utf8');
const py = spawnSync(
	'python3',
	[
		'-c',
		`import sys,yaml,json; t=yaml.safe_load(open(sys.argv[1])); print(json.dumps([{k: v for k, v in x.items()} for x in t], default=str))`,
		repoPath('ops/ansible/roles/postgres/tasks/main.yml')
	],
	{ encoding: 'utf8' }
);
const tasks = JSON.parse(py.stdout || '[]') as Array<Record<string, unknown>>;
const runsInit = tasks.some(
	(t) => JSON.stringify(t).includes('init.sql') && !/^Give the indexer role/.test(String(t.name))
);
check('no postgres-role task runs ops/postgres/init.sql', !runsInit);
check(
	'init.sql sets jit off and the idle-transaction cap for morphit_indexer',
	/^ALTER ROLE morphit_indexer SET jit = 'off';$/m.test(initSql) &&
		/^ALTER ROLE morphit_indexer SET idle_in_transaction_session_timeout = '300s';$/m.test(initSql)
);
const task = tasks.find((t) => /^Give the indexer role its session defaults/.test(String(t.name)));
const cmd = (task?.['ansible.builtin.shell'] as { cmd?: string } | undefined)?.cmd;
check(
	'the postgres role has the session-defaults task',
	typeof cmd === 'string' && tasksText.length > 0
);

const url = process.env.TEST_DATABASE_URL;
const havePsql =
	spawnSync('sh', ['-c', 'command -v psql'], { encoding: 'utf8' }).stdout.trim() !== '';
if (url && havePsql && cmd) {
	const u = new URL(url);
	const env = {
		...process.env,
		PGHOST: u.hostname,
		PGPORT: u.port || '5432',
		PGUSER: decodeURIComponent(u.username),
		PGPASSWORD: decodeURIComponent(u.password),
		PGDATABASE: u.pathname.slice(1)
	};
	const role = `fix_e_pgdefaults_${process.pid}`;
	const psql = (sql: string, extra: Record<string, string> = {}) =>
		spawnSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
			encoding: 'utf8',
			env: { ...env, ...extra }
		});
	psql(`DROP ROLE IF EXISTS ${role}`);
	psql(`CREATE ROLE ${role} LOGIN PASSWORD 'fix-e'`);
	try {
		const shell = cmd
			.replace(/\{\{ postgres_indexer_user \}\}/g, role)
			.replace(/-d postgres/g, `-d ${env.PGDATABASE}`);
		const asRole = () =>
			psql(
				"SELECT current_setting('jit') || ' ' || current_setting('idle_in_transaction_session_timeout')",
				{
					PGUSER: role,
					PGPASSWORD: 'fix-e'
				}
			).stdout.trim();
		check(
			'a fresh role starts with JIT on and no cap (the case the task is for)',
			asRole() === 'on 0',
			asRole()
		);
		const first = spawnSync('bash', ['-c', shell], { encoding: 'utf8', env });
		check(
			'the task sets both and says so',
			first.status === 0 && /^set:/m.test(first.stdout),
			`${first.status} ${first.stdout}${first.stderr}`
		);
		check(
			'a new session of the role shows jit = off, idle_in_transaction_session_timeout = 5min',
			asRole() === 'off 5min',
			asRole()
		);
		const second = spawnSync('bash', ['-c', shell], { encoding: 'utf8', env });
		check(
			'a second run changes nothing',
			second.status === 0 && second.stdout.trim() === 'unchanged',
			second.stdout
		);
	} finally {
		psql(`DROP ROLE IF EXISTS ${role}`);
	}
} else {
	check('skipped the live part: no TEST_DATABASE_URL or psql here', true);
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} postgres-role-defaults checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} postgres-role-defaults checks failed`);
process.exit(1);
