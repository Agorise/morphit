# Adding a workspace to the Morphit monorepo

This is the maintainer-facing checklist for introducing a new
workspace (under `apps/` or `packages/`) to the Morphit
monorepo.  Follow it whenever you add `apps/<new-thing>/` or
`packages/<new-thing>/` — even if the new workspace seems tiny.

The cp140 → cp146 progression is what this doc exists to
prevent.  `apps/mcp-server` was added in cp140, and four
separate problems went undetected for ~24 hours, each of them
caused by skipping one sub-pipeline of the install + build +
publish + smoke surface:

- **cp142** — The new workspace's smoke spawned `node dist/main.js`, but `dist/` was gitignored and never built.  Smoke hung indefinitely on every fresh checkout (including every CI run).
- **cp143** — The hang would burn the runner's full default ceiling.  Added per-smoke timeout as a runtime complement.
- **cp144** — `package-lock.json` was never regenerated after adding the workspace.  `npm ci` (CI's install command) refused to install with EUSAGE for ~24 hours.  Every downstream CI job was red.
- **cp145** — No CI job had `timeout-minutes`.  Defense-in-depth complement to cp143.
- **cp146** — The workspace's `package.json:files` array declared `LICENSE` but the file didn't exist.  `npm publish` would have shipped a tarball without a license.

Read those checkpoints in `docs/REVISIT-LIST.md` before doing
this work — the lessons there explain *why* each step matters,
not just what to do.

The checklist below ensures every sub-pipeline gets exercised
from a clean state before the PR lands.

---

## Phase 1 — Decide the workspace shape

Before writing any code, answer these.  Write the answers down
in the PR description so reviewers can sanity-check them.

### 1. What kind of workspace?

- **`apps/<name>/`** — runnable software (a server, CLI, web
  app, daemon).  Has `bin` if it's CLI-invokable, otherwise
  consumed by other workspaces.
- **`packages/<name>/`** — internal library code shared across
  multiple `apps/`.  Almost always `"private": true`.  Imported
  via `@morphit/<name>` aliases.

If the new code is consumed by exactly one other workspace,
consider whether it should be a folder INSIDE that workspace
instead of a separate workspace.  Multiplying workspaces
multiplies the work below.

### 2. Will it be published to npm?

- **No** (default for `packages/*`): set `"private": true` in
  `package.json`.  Skip the LICENSE and `files` array steps in
  Phase 4.
- **Yes** (some `apps/*`, especially CLIs like `morphit-mcp`):
  set up the full publishable surface.  See Phase 4.

### 3. Does it ship compiled artifacts?

- **No** (most cases): bin/main points at `.ts` files (consumed
  via `tsx` at runtime); `npm run build` is a no-op or absent.
- **Yes** (e.g. `apps/mcp-server` ships `dist/main.js` as its
  bin): the workspace needs a `build` script + `tsconfig.build.json`
  + a smoke that lazy-builds.  See cp142 lesson #2 in REVISIT.

### 4. Does it call out over the network?

- **No**: skip the SSRF + timeout review in Phase 3.
- **Yes**: every fetch needs (a) a timeout, (b) `redirect: 'manual'`,
  (c) `User-Agent` header, (d) URL-redaction in error paths
  (don't echo userinfo from URLs into errors).  Lift helpers
  from `apps/indexer/src/lib/federationProbe.ts` if you find
  yourself reimplementing this.

---

## Phase 2 — Create the workspace

### 1. Create the directory + skeleton files

```bash
mkdir -p apps/<name>/src apps/<name>/scripts
# OR packages/<name>/src for libraries
```

Minimum files:

- `apps/<name>/package.json` (see template below)
- `apps/<name>/tsconfig.json` (see template below)
- `apps/<name>/src/main.ts` (or `src/index.ts` for libraries)
- `apps/<name>/README.md` (even if it's three lines — see Phase 4)

### 2. `package.json` template

```json
{
  "name": "morphit-<name>",          // or "@morphit/<name>" for packages/
  "version": "1.0.0-beta.20",        // MUST equal the root package.json version — version-consistency-smoke fails the build if any workspace drifts
  "type": "module",
  "license": "AGPL-3.0-only",
  "private": false,                  // or true for packages/
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "dev": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@morphit/asset-registry": "*"   // workspace links use "*"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

If the workspace ships a CLI binary:

```json
  "bin": {
    "morphit-<name>": "src/main.ts"           // tsx-runnable; no build needed
  }
```

If the workspace ships a COMPILED binary (rare; only when the
binary needs `node` rather than `tsx`):

```json
  "bin": {
    "morphit-<name>": "dist/main.js"
  },
  "scripts": {
    ...
    "build": "tsc -p tsconfig.build.json"
  },
  "files": [
    "dist/",
    "src/",
    "README.md",
    "LICENSE"
  ]
```

— **and** add the entries described in Phase 4 step 3.

### 3. `tsconfig.json` template

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*", "scripts/**/*"]
}
```

### 4. Add LICENSE if publishable

If the workspace will be published (not `"private": true`):

```bash
cp LICENSE apps/<name>/LICENSE
```

This is non-negotiable.  `npm publish` silently skips missing
files from the `files` array — the cp146 `package-files-exist-smoke`
catches this, but it's easier to do it right the first time.

---

## Phase 3 — Wire into the monorepo

### 1. Register the workspace in root `package.json`

```json
{
  "workspaces": [
    "apps/web",
    "apps/relay",
    "apps/indexer",
    "apps/ops-cli",
    "apps/matrix-bot",
    "apps/mcp-server",
    "apps/<your-new-workspace>",       // <-- add here
    "packages/indexer-client",
    ...
  ]
}
```

### 2. Regenerate `package-lock.json` — CRITICAL

```bash
npm install
git diff package-lock.json | head -20    # confirm new workspace entries appear
```

**Do not skip this step.**  This is the cp144 failure mode.
Adding the workspace to `package.json:workspaces` without
regenerating the lockfile causes CI's `npm ci` to fail with
EUSAGE, gating every downstream job.

After `npm install`, run:

```bash
npm ci --dry-run --no-audit --no-fund
```

It should print `added N packages` (with N including your new
workspace).  If it errors with `EUSAGE` or `Missing: ...`, the
lockfile is stale — re-run `npm install` and verify.

### 3. Register the workspace tsconfig in `scripts/typecheck-sweep.sh`

```bash
# In the project() invocations near the bottom:
project "<name>"        apps/<name>/tsconfig.json
```

Run `bash scripts/typecheck-sweep.sh` — your workspace should
appear in the output as "0 errors" (or with whatever errors
need fixing).

### 4. If publishable, add the LICENSE to `package.json:files`

Already shown in the publishable `package.json` template
above.  The `package-files-exist-smoke` will fail at build
time if you list LICENSE but the file doesn't exist; the
inverse failure (file exists but not in `files`) isn't a
smoke-catchable bug but matters for the npm tarball.

### 5. If the workspace ships compiled artifacts

Add a build step to `.forgejo/workflows/ci.yml`'s smokes job:

```yaml
      - name: Build workspaces that ship compiled artifacts
        run: |
          npm run build -w apps/mcp-server
          npm run build -w apps/<your-new-workspace>   # <-- add
```

The cp142 `spawn-dist-prebuild-coverage-smoke` will fail if a
smoke spawns from `dist/` without a corresponding guard; the
CI build step is the legible counterpart so failures surface
as a named step rather than buried in smoke output.

---

## Phase 4 — Build smokes

Smokes are how the workspace gets continuously verified.
Skipping them means the workspace silently rots between audits.

### 1. At minimum

Create `apps/<name>/scripts/<name>-smoke.ts` covering:

- **Wire-up sanity:** the workspace's main entry imports cleanly
  and exports its public surface.
- **Happy path:** the main use case end-to-end.
- **Error path:** at least one invalid-input case returns a
  legible error.

### 2. If the workspace spawns its own bin from `dist/`

Read `scripts/spawn-dist-prebuild-coverage-smoke.ts` (cp142).
The smoke MUST contain either `ensureBuilt(` or `existsSync(<dist path>)`
before the spawn, in non-comment code.  The meta-smoke verifies
this with a comment-stripped scan; without the guard, the
meta-smoke fails the build.

A self-healing helper looks like:

```typescript
function ensureBuilt(cwdPath: string): void {
  const distMain = resolvePath(cwdPath, 'dist', 'main.js');
  if (existsSync(distMain)) return;
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: cwdPath,
    stdio: 'inherit'
  });
  if (build.status !== 0) process.exit(1);
}
```

Call it at the top of `main()` before any `spawn`.

### 3. Register in `scripts/run-smokes.sh`

```bash
SMOKES=(
  ...
  "apps/<name>:<name>-smoke"
  ...
)
```

The runner counts smokes by parsing this array.  cp143's
`timeout --signal=TERM --kill-after=5 240` wraps each smoke;
if your smoke needs longer than 240 seconds, write it so it
DOESN'T (split into multiple smokes; reduce scenario size).

### 4. The smoke MUST emit `✓ all N scenarios passed`

The runner's exit-zero branch greps for `^✓ all` to count
scenarios.  Smokes that pass the runner but emit no canonical
line are flagged as failures.  Use the same final-line
convention as every other smoke in the repo.

### 5. If the workspace ships compiled artifacts, also build dist/ at smoke startup

The cp142 self-healing pattern.  Without it, a fresh-checkout
CI run hangs indefinitely (which cp143 catches with a 240s
timeout, but you don't want hangs in the first place).

---

## Phase 5 — Pre-PR verification

Before opening the PR, run these IN ORDER.  Any failure means
you have more work to do; don't paper over with "I'll fix it
in CI."

### 1. Fresh-checkout sanity

```bash
# In a separate clone or scratch directory:
git clone https://git.agorise.net/agorise/morphit fresh-clone
cd fresh-clone
git fetch origin <your-branch>
git checkout <your-branch>
npm ci --no-audit --no-fund    # CI's exact install command
```

If `npm ci` fails: your lockfile is stale.  Go back to Phase 3
step 2.

### 2. Build any compiled workspaces

```bash
npm run build -w apps/<your-new-workspace>    # if applicable
```

### 3. Typecheck sweep

```bash
bash scripts/typecheck-sweep.sh
```

Every workspace including yours should report "0 errors."

### 4. Triple-pulse smokes

```bash
for i in 1 2 3; do
  echo "=== Pulse $i ==="
  bash scripts/run-smokes.sh
done
```

Three runs catch flakes.  Total scenario count should be the
same all three pulses.  Zero runners failed all three pulses.

### 5. svelte-check (if your workspace touches `apps/web`)

```bash
cd apps/web && npm run check
```

Zero errors and zero warnings.

### 6. Meta-smokes

The four cp142–146 meta-smokes are in the run-smokes.sh
battery and should all pass automatically:

- `spawn-dist-prebuild-coverage-smoke` (cp142)
- `lockfile-sync-smoke` (cp144)
- `ci-workflow-hardening-smoke` (cp145)
- `package-files-exist-smoke` (cp146)

If any of these fail, the failure message points at the file +
class-of-bug.  Don't bypass them — they exist because the
cp140 oversight that this doc exists to prevent.

---

## Phase 6 — Docs

### 1. The workspace README

`apps/<name>/README.md` should answer:

- What the workspace does in one paragraph.
- How to install / run it (from-source instructions first;
  npm / Docker forthcoming markers if those pipelines haven't
  shipped yet — cp146 lesson #4).
- Configuration env vars (with defaults).
- Privacy posture if the workspace is user-facing.
- Where to file bugs (`git.agorise.net/agorise/morphit/issues`).

### 2. ADR if the workspace introduces an architectural shift

If the workspace establishes a new external surface
(e.g. ADR-0044 for the MCP server), write an ADR explaining:

- Context: why this exists.
- Decision: what shape it takes.
- Alternatives considered.
- Consequences (positive + negative).
- Source: links to the workspace files.

Pure internal libraries that don't change the user-facing
surface don't need an ADR.

### 3. Brag list entry — only if user-facing

If the workspace is a user-facing capability (not internal
plumbing), add a concise public-facing brag entry to
`MORPHIT-BRAG-LIST.md`.  Follow the existing entry style: 2–4
sentences, verifiable in code or honestly disclosed as backlog,
inserted in the proper themed section.

### 4. Update this doc if you find a new gotcha

If your workspace add surfaces a problem that none of cp142–
cp146 caught, add it as a new cp checkpoint with REVISIT entry
+ extend this doc.  Then we've raised the floor for next time.

---

## What gets caught automatically

The cp142–cp146 meta-smokes catch the following classes
without any action on your part:

| Smoke | Catches |
|---|---|
| `spawn-dist-prebuild-coverage-smoke` | Smoke spawns from `dist/` with no build guard |
| `lockfile-sync-smoke` | `package-lock.json` out of sync with root `package.json` |
| `ci-workflow-hardening-smoke` | Any new CI job missing `timeout-minutes` or pinning `-latest` |
| `package-files-exist-smoke` | Workspace `files` array references missing files or no LICENSE |

That's the safety net.  Use the checklist above to avoid
needing it.

---

## Reference: the cp140 → cp146 sequence

| cp | Caught | Fix |
|---|---|---|
| 140 | (the oversight) workspace added without exercising all sub-pipelines | — |
| 142 | smoke spawned `dist/main.js` without `dist/` existing | self-healing lazy-build + meta-smoke |
| 143 | hung smoke would burn runner's full default ceiling | per-smoke `timeout 240` |
| 144 | `package-lock.json` was stale, blocking CI's `npm ci` for ~24h | regenerated lockfile + lockfile-sync smoke |
| 145 | no CI job had `timeout-minutes` | per-job ceilings + meta-smoke |
| 146 | `package.json:files` listed missing LICENSE; 3 places bypassed `getInstanceUrl()`; user-facing copy claimed "no IP logging by design" | LICENSE created + DRY + honest copy + meta-smoke |

Five checkpoints' worth of work, all preventable by following
the checklist above.
