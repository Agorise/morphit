# Locale graduation: PLANNED → SUPPORTED

This document is the procedural checklist for graduating a `PLANNED_LOCALES` entry to `SUPPORTED_LOCALES` — i.e. turning a scaffolded language into a shipped one that users see in the switcher.

Read [`CONTRIBUTING-TRANSLATIONS.md`](./CONTRIBUTING-TRANSLATIONS.md) first if you haven't. That doc explains the JSON-file shape, placeholders, pluralization, RTL handling, and what makes a translation review-ready. This doc is the mechanical "now that the translation is ready, how do I ship it" walkthrough.

## When to graduate

A locale is ready to graduate when ALL of these are true:

1. A complete `apps/web/src/lib/i18n/locales/<code>.json` exists, mirroring `en.json`'s key shape exactly.
2. The translation has been reviewed by a native speaker (not just a machine translation passed through unchecked).
3. The translator-diff tool reports zero missing keys:

   ```bash
   npx tsx apps/web/scripts/i18n-translator-diff.ts <code>
   # Expected:  "Missing in <code>: 0 keys"
   ```

4. Placeholders, ICU plural blocks, and inline HTML tags are preserved correctly (the parity smoke catches structural drift but not semantic errors — that's the native reviewer's job).

If any of those four are false, the locale stays in `PLANNED_LOCALES` and the translation work continues.

## The graduation steps

Performed by the maintainer landing the PR. Designed to be done in a single sitting because every step is needed for the locale to ship correctly.

### 1. Drop the JSON file

```bash
cp some-translator-pr/<code>.json apps/web/src/lib/i18n/locales/<code>.json
```

The file MUST exist at this path or the prerender step fails.

### 2. Move the registry entry

Edit `apps/web/src/lib/i18n/locales.ts`. Cut the locale's entry from `PLANNED_LOCALES` and paste it into `SUPPORTED_LOCALES` at the position you want it to appear in the language-switcher dropdown.

The entry shape is identical between the two arrays — just relocate it.

```ts
// Before:
//   SUPPORTED_LOCALES = [ ..., {code: 'zh-HK', ...} ]
//   PLANNED_LOCALES   = [ {code: 'hi', ...}, {code: 'ar', ...}, ... ]
//
// After (graduating Hindi):
//   SUPPORTED_LOCALES = [ ..., {code: 'zh-HK', ...}, {code: 'hi', ...} ]
//   PLANNED_LOCALES   = [ {code: 'ar', ...}, ... ]
```

That single edit is all the code change graduation requires. `i18n-locale-registry-smoke` enforces the disjointness invariant — you can't accidentally leave the entry in both arrays.

### 3. Run the smoke battery

```bash
bash scripts/run-smokes.sh
```

Expect failures in this category — they're the drift detectors firing:

- **`brag-list-claim-parity-smoke`** — flags every "N languages/locales" claim in `MORPHIT-BRAG-LIST.md`, `README.md`, and `apps/web/static/llms.txt` that still says the old count. The smoke output lists the exact `file:line` of each.
- **`i18n-locale-parity-smoke`** — verifies the new locale JSON has every key from `en.json`. If anything's missing this is your last chance to catch it.
- **`i18n-locale-registry-smoke`** — confirms the disjointness + JSON-file-existence invariants now hold for the new locale.
- **`mediakit-freshness-smoke`** — if `MORPHIT-BRAG-LIST.md` got edited to update locale counts, the bundled `morphit-mediakit.zip` goes stale; rebuild via `bash scripts/build-mediakit.sh`.

Some smokes that load locales via `readdirSync` auto-adapt and just pass. Others that load via `SUPPORTED_LOCALES.map(...)` also auto-adapt. The only ones that fail are the claim-parity ones — by design.

### 4. Update the prose-side claims the smokes flagged

For each `file:line` reported by `brag-list-claim-parity-smoke`, change the number. Example diff:

```diff
- 170. **10 locales shipped at v0.** English, Spanish, ...
+ 171. **11 locales shipped at v0.** English, Spanish, ..., Hindi.
```

The smoke output is a complete checklist — no need to grep separately.

Touchpoints typically affected (count from cp140 baseline):
- `MORPHIT-BRAG-LIST.md` — 15 mentions
- `README.md` — 1 mention
- `apps/web/static/llms.txt` — 1 mention (line 42)
- `MORPHIT-BRAG-LIST.md` trailer — "Last updated" date + the per-asset asset-count line that mentions locales

The brag-list count itself shifts at the line about "N locales shipped." Update that to N+1 and add the new language name.

### 5. Update untracked prose mentions

A few comments and docstrings in source files casually mention "10 supported locales" or "the ten languages." These are not enforced by any smoke (they're docstring text, not contracts), so they drift silently. Grep them after the smokes go green:

```bash
git grep -nE "all (10|ten) (locales|languages)|10 supported locales|10 fully localized" \
    apps/ scripts/ docs/ README.md MORPHIT-BRAG-LIST.md
```

Update each to either the new exact number, or to "all supported locales" / "every supported locale" if it reads naturally that way.

Typical locations as of cp140:
- `apps/web/src/lib/i18n/index.test.ts` — docstring header
- `apps/web/src/routes/[lang]/+page.ts` — prerender-output comment
- `apps/web/src/routes/[lang]/+layout.ts` — prerender-output comment
- `apps/web/src/lib/seo/routes.ts` — "17 indexable routes × 10 locales" math comment
- A handful of `// 30 strings × 10 locales` style comments in smokes

### 6. Rebuild the mediakit + the comparison image

If you touched `MORPHIT-BRAG-LIST.md` (you did, step 4):

```bash
bash scripts/build-mediakit.sh
```

If `MORPHIT-BRAG-LIST.md` got a new entry, also rebuild:

```bash
python3 scripts/comparison-image/build_comparison.py
```

The relevant comparison-table row to bump is "N fully localized languages." Edit `scripts/comparison-image/build_comparison.py` and update the row label.

### 7. Re-run the full smoke battery

```bash
bash scripts/run-smokes.sh
```

Expected: clean pulse. If anything is still failing, fix it before opening the PR.

### 8. Triple-pulse stability check

Per the standing project rule, every meaningful change runs three back-to-back full pulses to detect flakes:

```bash
for i in 1 2 3; do bash scripts/run-smokes.sh > /tmp/pulse$i.txt 2>&1; tail -1 /tmp/pulse$i.txt; done
```

All three pulses should report the same `Total: N scenarios passed, 0 runners failed`.

### 9. Persona walkthroughs

Open every page in the new locale and click around. Pay special attention to:

- **The language switcher** — the new locale is in the dropdown, with the right native name.
- **RTL languages (Arabic, Hebrew, etc.)** — every layout flips cleanly. The CSS isn't always perfect on the first RTL pass; minor adjustments are normal. Persian (`fa`) is the production RTL canary, so most issues are already fixed for it.
- **Long-form pages (`/faq`, `/run-a-node`, `/post`)** — check that translations don't overflow buttons, break grids, or get truncated.
- **Currency/number/date formatting** — `Intl.NumberFormat` and `Intl.DateTimeFormat` handle locale-specific formatting automatically; spot-check that the formatted output matches local conventions.

### 10. Open the PR

The PR description should include:

- Translator name + Matrix handle (for credit and follow-ups).
- Native-speaker reviewer name + Matrix handle.
- A note confirming all smokes pass triple-pulse.
- A note about any RTL/layout quirks found during step 9.

## What's NOT in the graduation steps

These are intentionally NOT part of graduation; flagging them so they don't accidentally creep in:

- **No DNS / domain work.** Languages are URL segments (`/hi/...`), not subdomains. No `hi.morphit.io` setup needed.
- **No CDN preheat.** The build emits 17 indexable routes × N supported locales as static HTML at prerender time; the new files ship with the next deploy.
- **No federation announcement.** Federation runs over the public Blurt blockchain at the data layer; locale is a UI concern that's per-instance.
- **No relay/indexer change.** The backend is locale-agnostic. The relay never sees translated strings; it sees i18n keys at most (and in practice doesn't even see those — error messages get translated client-side).

## Reverting a graduation

If a graduation goes wrong (translation quality issue surfaces post-deploy, etc.), revert is a single-array edit: move the locale's entry back from `SUPPORTED_LOCALES` to `PLANNED_LOCALES`. The next deploy stops prerendering it and stops showing it in the switcher. The JSON file can stay in place; the registry smoke just confirms it's a SUPPORTED locale and PLANNED locales have no JSON file — so if you revert, delete or rename the JSON to `<code>.json.held` until you re-graduate.

Reverting is rare. The translator-diff tool + native review should catch quality issues before graduation.

## Reference

- `apps/web/src/lib/i18n/locales.ts` — registry SSoT (`SUPPORTED_LOCALES` + `PLANNED_LOCALES`)
- `apps/web/scripts/i18n-translator-diff.ts` — translator-facing diff tool
- `apps/web/scripts/i18n-locale-parity-smoke.ts` — master key-shape parity
- `apps/web/scripts/i18n-locale-registry-smoke.ts` — registry-shape invariants
- `scripts/brag-list-claim-parity-smoke.ts` — public-doc claim-parity (catches stale counts)
- `docs/CONTRIBUTING-TRANSLATIONS.md` — the translator-side guide
- This document — `docs/LOCALE-GRADUATION.md`
