/**
 * One copy of Morphit's ModSecurity exemption in BunkerWeb — never two. (v1.20.1)
 *
 * WHY. Morphit's JSON API needs ModSecurity off for /v1/ and /relay/ (rule id
 * 1990001; its base64 payloads trip the Core Rule Set). Since v1.16.9 the
 * upgrade put that rule in TWO ways: as the setting
 * CUSTOM_CONF_MODSEC_morphit_json_api_off (BunkerWeb stores it as the custom
 * config `morphit_json_api_off`, "CREATED BY ENV", method "scheduler") AND as a
 * file `morphit-json-api-off.conf` in the scheduler's /data/configs/modsec,
 * which BunkerWeb 1.5 imports into its database as a second custom config
 * (method "manual") and keeps after the file is gone. When both are loaded,
 * nginx refuses the whole config ("Rule id: 1990001 is duplicated") and
 * BunkerWeb keeps serving the last config that worked — so no BunkerWeb setting
 * changed on that box ever again (morphitir: frozen since Sep 7, including
 * `USE_REAL_IP=no`, so visitors could choose their own address). morphit.io had
 * only the first copy and worked.
 *
 * WHAT. Find every copy of the rule — database rows and files, in the scheduler
 * — and keep exactly one: the setting's copy when BunkerWeb has it (the
 * documented mechanism, rendered on every box we have seen), otherwise the
 * oldest other copy. The rest are removed after a backup of BunkerWeb's
 * database, and can be put back (restoreRuleCopies) if the result does not
 * check out. The PLAN is pure; the runtime is one Python script run inside the
 * scheduler (BunkerWeb's own images ship python3 + sqlite3).
 */
import { spawnSync } from 'node:child_process';

export const RULE_ID = '1990001';
/** The custom config BunkerWeb makes from CUSTOM_CONF_MODSEC_morphit_json_api_off. */
export const KEEP_NAME = 'morphit_json_api_off';

export interface RuleRow {
	readonly id: number;
	readonly serviceId: string | null;
	readonly type: string;
	readonly name: string;
	readonly method: string;
	readonly checksum: string | null;
	/** base64 of the stored bytes (for restoring). */
	readonly data: string;
}

export interface RuleCopies {
	/** null: BunkerWeb's database could not be read here (e.g. not sqlite). */
	readonly rows: readonly RuleRow[] | null;
	/** Files in the scheduler's config dirs that carry the rule. */
	readonly files: readonly string[];
}

export interface DedupePlan {
	readonly keep: string | null;
	readonly removeRows: readonly RuleRow[];
	readonly removeFiles: readonly string[];
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const isKeeperFile = (p: string): boolean =>
	baseName(p) === `${KEEP_NAME}.conf` && /\/modsec\/[^/]+$/.test(p);

/**
 * Which copies go. The setting's copy (row `morphit_json_api_off`, global)
 * stays; with it present every other copy goes. Without it, the oldest other
 * row stays (so the API is never left without its exemption) and the rest go.
 * The setting's own rendered file (…/modsec/morphit_json_api_off.conf) is
 * BunkerWeb's output, never removed. PURE.
 */
export function planRuleDedupe(copies: RuleCopies): DedupePlan {
	const rows = copies.rows ?? [];
	const keeper =
		rows.find((r) => r.name === KEEP_NAME && r.serviceId === null) ??
		[...rows].sort((a, b) => a.id - b.id)[0] ??
		null;
	const removeRows = rows.filter((r) => r !== keeper);
	// A stray file is a copy BunkerWeb would import on its next start.
	const removeFiles = copies.files.filter((f) => !isKeeperFile(f));
	return {
		keep: keeper ? `${keeper.name} (${keeper.method})` : null,
		removeRows,
		removeFiles
	};
}

/** How many copies BunkerWeb would load. PURE. */
export function copyCount(copies: RuleCopies): number {
	const rows = copies.rows ?? [];
	const stray = copies.files.filter((f) => !isKeeperFile(f)).length;
	return rows.length + stray;
}

// ─── runtime: one script inside the scheduler ───────────────────────────

export const DEDUPE_PY = String.raw`
import base64, json, os, shutil, sqlite3, sys, time
RULE = os.environ["RULE"].encode()
MODE = os.environ["MODE"]
DB = "/data/lib/db.sqlite3"
def carries(b):
    return (b"id:" + RULE) in b or (b"id:'" + RULE) in b or (b'id:"' + RULE) in b
def rows():
    if not os.path.exists(DB):
        return None
    c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=30)
    if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bw_custom_configs'").fetchone():
        return None
    out = []
    for r in c.execute("SELECT id, service_id, type, name, method, checksum, data FROM bw_custom_configs"):
        d = r[6] if isinstance(r[6], bytes) else str(r[6] or "").encode()
        if carries(d):
            out.append({"id": r[0], "serviceId": r[1], "type": r[2], "name": r[3], "method": r[4],
                        "checksum": r[5], "data": base64.b64encode(d).decode()})
    return out
def files():
    out = []
    for root in ("/data/configs", "/etc/bunkerweb/configs"):
        for dp, dn, fn in os.walk(root):
            for f in fn:
                p = os.path.join(dp, f)
                if p.endswith(".conf"):
                    try:
                        with open(p, "rb") as h:
                            if carries(h.read()):
                                out.append(p)
                    except OSError:
                        pass
    return out
if MODE == "list":
    print(json.dumps({"rows": rows(), "files": files()}))
elif MODE == "remove":
    ids = [int(x) for x in os.environ.get("IDS", "").split(",") if x]
    paths = [p for p in os.environ.get("FILES", "").split("\n") if p]
    res = {"backup": None, "rows": 0, "moved": []}
    if ids:
        s = sqlite3.connect(DB, timeout=30)
        bk = "/data/lib/db.pre-morphit-dedupe.sqlite3"
        d = sqlite3.connect(bk)
        s.backup(d)
        d.close()
        res["backup"] = bk
        res["rows"] = s.execute("DELETE FROM bw_custom_configs WHERE id IN (%s)" % ",".join("?" * len(ids)), ids).rowcount
        s.commit()
        s.close()
    if paths:
        dest = "/data/lib/morphit-removed-configs"
        os.makedirs(dest, exist_ok=True)
        for p in paths:
            t = os.path.join(dest, "%d-%s" % (int(time.time()), os.path.basename(p)))
            try:
                shutil.move(p, t)
                res["moved"].append([p, t])
            except OSError:
                pass
    print(json.dumps(res))
elif MODE == "restore":
    data = json.load(sys.stdin)
    if data.get("rows"):
        c = sqlite3.connect(DB, timeout=30)
        for r in data["rows"]:
            c.execute("INSERT OR REPLACE INTO bw_custom_configs (id, service_id, type, name, data, checksum, method) VALUES (?,?,?,?,?,?,?)",
                      (r["id"], r["serviceId"], r["type"], r["name"], base64.b64decode(r["data"]), r["checksum"], r["method"]))
        c.commit()
        c.close()
    for src, dst in data.get("moved", []):
        try:
            shutil.move(dst, src)
        except OSError:
            pass
    print("ok")
`;

function runPy(
	scheduler: string,
	env: Record<string, string>,
	stdin = '',
	timeoutMs = 30_000
): string | null {
	try {
		const args = ['exec', '-i'];
		for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
		args.push(scheduler, 'python3', '-c', DEDUPE_PY);
		const r = spawnSync('docker', args, { input: stdin, encoding: 'utf8', timeout: timeoutMs });
		return r.status === 0 ? (r.stdout ?? '').trim() : null;
	} catch {
		return null;
	}
}

/** Every copy of the rule the scheduler holds; null when it cannot be read. */
export function listRuleCopies(scheduler: string): RuleCopies | null {
	const out = runPy(scheduler, { RULE: RULE_ID, MODE: 'list' });
	if (out === null) return null;
	try {
		const j = JSON.parse(out) as { rows: RuleRow[] | null; files: string[] };
		return { rows: j.rows, files: j.files ?? [] };
	} catch {
		return null;
	}
}

export interface RemovedCopies {
	readonly rows: readonly RuleRow[];
	readonly moved: ReadonlyArray<readonly [string, string]>;
	readonly backup: string | null;
}

/** Carry out a plan (database backed up first); null if it could not run. */
export function removeRuleCopies(scheduler: string, plan: DedupePlan): RemovedCopies | null {
	if (plan.removeRows.length === 0 && plan.removeFiles.length === 0)
		return { rows: [], moved: [], backup: null };
	const out = runPy(scheduler, {
		RULE: RULE_ID,
		MODE: 'remove',
		IDS: plan.removeRows.map((r) => r.id).join(','),
		FILES: plan.removeFiles.join('\n')
	});
	if (out === null) return null;
	try {
		const j = JSON.parse(out) as { backup: string | null; rows: number; moved: [string, string][] };
		if (j.rows !== plan.removeRows.length) return null;
		return { rows: plan.removeRows, moved: j.moved, backup: j.backup };
	} catch {
		return null;
	}
}

/** Put removed copies back exactly (rows with their ids, files to their paths). */
export function restoreRuleCopies(scheduler: string, removed: RemovedCopies): boolean {
	return (
		runPy(
			scheduler,
			{ RULE: RULE_ID, MODE: 'restore' },
			JSON.stringify({ rows: removed.rows, moved: removed.moved })
		) === 'ok'
	);
}
