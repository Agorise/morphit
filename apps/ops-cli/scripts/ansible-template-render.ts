/**
 * Render an Ansible role template the way the playbook would, for smokes that
 * check what a fresh install really gets (not the template's text).
 *
 * Uses Python's jinja2 (Ansible's own template engine) with the variables of
 * ops/ansible/group_vars/all.yml, resolved against each other, plus the
 * caller's overrides (the wizard's answers). The few Ansible-only filters the
 * roles use are provided with Ansible's semantics. No Ansible run, no host.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PY = String.raw`
import json, sys, os, posixpath, re, shlex
import yaml, jinja2
repo, tpl, overrides = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
gv = yaml.safe_load(open(os.path.join(repo, 'ops/ansible/group_vars/all.yml'))) or {}
gv.update(overrides)
def to_bool(v):
    if isinstance(v, bool): return v
    return str(v).strip().lower() in ('1', 'yes', 'true', 'on', 'y')
env = jinja2.Environment(undefined=jinja2.ChainableUndefined, keep_trailing_newline=True,
                         trim_blocks=True, lstrip_blocks=False)
env.filters.update({
    'bool': to_bool,
    'quote': lambda s: shlex.quote(str(s)),
    'basename': posixpath.basename,
    'dirname': posixpath.dirname,
    'to_json': json.dumps,
    'mandatory': lambda v: v,
    'regex_replace': lambda s, p, r='': re.sub(p, r, str(s)),
    'ternary': lambda c, a, b=None: a if c else b,
})
# group_vars reference each other ({{ morphit_domain }} …): resolve a few passes.
for _ in range(5):
    for k, v in list(gv.items()):
        if isinstance(v, str) and '{{' in v:
            try: gv[k] = env.from_string(v).render(**gv)
            except Exception: pass
src = open(os.path.join(repo, tpl)).read()
sys.stdout.write(env.from_string(src).render(**gv))
`;

/** The rendered text of `templateRel` (repo-relative). Throws when it cannot. */
export function renderAnsibleTemplate(
	templateRel: string,
	overrides: Record<string, unknown> = {}
): string {
	const r = spawnSync('python3', ['-c', PY, REPO, templateRel, JSON.stringify(overrides)], {
		encoding: 'utf8'
	});
	if (r.status !== 0) throw new Error(`cannot render ${templateRel}: ${r.stderr}`);
	return r.stdout;
}

const PY_TASKS = PY.replace(
	'src = open(os.path.join(repo, tpl)).read()\nsys.stdout.write(env.from_string(src).render(**gv))',
	String.raw`tasks = yaml.safe_load(open(os.path.join(repo, tpl))) or []
def r(v, extra):
    if isinstance(v, str): return env.from_string(v).render(**{**gv, **extra})
    if isinstance(v, list): return [r(x, extra) for x in v]
    if isinstance(v, dict): return {k: r(x, extra) for k, x in v.items()}
    return v
def cond(w, extra):
    ws = w if isinstance(w, list) else [w]
    return all(to_bool(env.from_string('{{ ' + str(x) + ' }}').render(**{**gv, **extra})) for x in ws)
out = []
for t in tasks:
    t = dict(t)
    when = t.pop('when', None)
    loop = t.pop('loop', None)
    items = r(loop, {}) if loop is not None else [None]
    for it in items:
        extra = {} if it is None else {'item': it}
        out.append({'name': t.get('name', ''), 'skip': (when is not None and not cond(when, extra)),
                     'item': it, 'task': r({k: v for k, v in t.items() if k != 'name'}, extra)})
sys.stdout.write(json.dumps(out))`
);

/** Every task of a role's tasks file as the playbook would run it with
 *  group_vars + `overrides`: strings rendered, `loop` expanded (one entry per
 *  item), and `when` evaluated (`skip`). Throws when it cannot. */
export function renderAnsibleTasks(
	tasksRel: string,
	overrides: Record<string, unknown> = {}
): Array<{ name: string; skip: boolean; item: unknown; task: Record<string, unknown> }> {
	if (PY_TASKS === PY) throw new Error('the task renderer could not be built');
	const r = spawnSync('python3', ['-c', PY_TASKS, REPO, tasksRel, JSON.stringify(overrides)], {
		encoding: 'utf8'
	});
	if (r.status !== 0) throw new Error(`cannot render ${tasksRel}: ${r.stderr}`);
	return JSON.parse(r.stdout) as Array<{
		name: string;
		skip: boolean;
		item: unknown;
		task: Record<string, unknown>;
	}>;
}

/** `KEY=value` lines of an env file (last wins, surrounding quotes removed). */
export function parseEnvText(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split('\n')) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2]!.trim();
		if (v.length >= 2 && /^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
		out.set(m[1]!, v);
	}
	return out;
}

export const repoPath = (rel: string): string => join(REPO, rel);
