# Contributing translations

Morphit ships in 10 locales today and has 7 more scaffolded for upcoming work. This doc is for translators, native-speaker reviewers, and operators who want to help complete an existing language, add a new one, or just understand how the translation system works.

The whole system is designed around two ideas:

1. **English is the source of truth.** `en.json` is the only file that gets new keys directly. Every other locale's job is to translate those keys.
2. **Missing keys fall back to English at runtime.** Translation work can be incremental. A half-translated locale never breaks the UI — it just shows English text for the un-translated keys.

## File layout

All translation files live in a single directory:

```
apps/web/src/lib/i18n/locales/
  en.json     ← source of truth
  es.json
  de.json
  pl.json
  fr.json
  it.json
  ru.json
  fa.json     ← right-to-left
  zh-CN.json  ← Simplified Chinese (Mandarin)
  zh-HK.json  ← Traditional Chinese (Cantonese)
```

The full locale registry — display names, RTL flags, and which locales are "planned but not yet shipping" — lives in `apps/web/src/lib/i18n/locales.ts` as two arrays:

- **`SUPPORTED_LOCALES`** — translations complete and native-speaker reviewed. Shown in the language switcher. Ships a JS bundle. Has a JSON file in `locales/`.
- **`PLANNED_LOCALES`** — scaffolded for upcoming translation work. Has metadata (display name, RTL flag) but NO JSON file yet. Does not appear in the switcher, does not ship a JS bundle.

A locale graduates from `PLANNED_LOCALES` to `SUPPORTED_LOCALES` when its JSON file exists, every key from `en.json` is present (parity smoke confirms), and a native speaker has reviewed. The mechanical steps a maintainer runs at graduation time are documented in [`LOCALE-GRADUATION.md`](./LOCALE-GRADUATION.md) — that doc is the procedural checklist; this doc explains how to produce the translation in the first place.

## JSON file structure

`en.json` is hierarchical. Top-level keys group related strings:

```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel",
    "loading": "Loading…"
  },
  "orderbook": {
    "title": "Orderbook",
    "filter": {
      "by_asset": "Filter by asset",
      "by_country": "Filter by country"
    }
  }
}
```

Your locale file must mirror this shape **exactly** — same key names at every level. Only the string *values* change. Renaming keys breaks the lookup at runtime.

Total strings in `en.json` today: about 3,100. Most are short UI labels. About 100 are multi-paragraph FAQ answers.

## Placeholders: `{name}`, `{count}`, `{amount}`

206 strings have curly-brace placeholders that get filled in at runtime:

```json
{
  "assets": {
    "usdt": {
      "address_share": {
        "warning": "Send USDT on {network} only. Sending USDT on any other network to this address loses your funds permanently."
      }
    }
  }
}
```

**Rules for placeholders:**

1. **Preserve them exactly.** `{network}` becomes the network name at runtime (e.g. "Ethereum"). Renaming `{network}` to `{red}` or `{réseau}` breaks the substitution.
2. **Reorder them freely.** Word order varies by language. If the English is `"Pay {amount} in {currency}"` and your language puts currency first, write `"En {currency} pagar {amount}"`. The substitution still works.
3. **Don't add new placeholders.** The code passes a specific set of values. Adding `{newvar}` won't get filled.
4. **Drop placeholders only if your language genuinely doesn't need them.** Rare, but acceptable. If the English template needs the value to make sense in English but yours doesn't, you can omit it — the runtime won't crash on an unused variable.

## Pluralization: ICU `{count, plural, ...}`

Seven strings use ICU MessageFormat for pluralization:

```json
{
  "feedback_reminder": {
    "heading": "{count, plural, one {You have a pending review to leave} other {You have # pending reviews to leave}}"
  }
}
```

This means: when `count == 1`, show "You have a pending review to leave"; otherwise show "You have # pending reviews to leave" (where `#` becomes the actual number).

**Languages with more than two plural forms** (Russian, Polish, Arabic, Welsh, etc.) get more clauses:

```json
{
  "feedback_reminder": {
    "heading": "{count, plural, one {Masz # niedokończoną recenzję} few {Masz # niedokończone recenzje} many {Masz # niedokończonych recenzji} other {Masz # niedokończonych recenzji}}"
  }
}
```

CLDR plural categories for each language: see https://cldr.unicode.org/index/cldr-spec/plural-rules.

**Don't omit clauses you don't need.** Always include at least `one` and `other`. If your language only has those two forms, that's fine.

## HTML inside strings

Nine strings contain inline HTML (Markdown bold, em, links). Examples:

```json
"how_to_build_high_reputation": "Reputation on Morphit is built **organically** — by trading consistently…"
```

- **Preserve tags exactly:** `**bold**`, `*italic*`, `[link text](url)`.
- **Translate the text inside the tags.** `**organically**` becomes `**organisch**` in German.
- **Don't add new tags.** The renderer only knows how to render the tag types already in `en.json`.

## How to translate

### Setup

```bash
git clone https://git.agorise.net/agorise/morphit.git
cd morphit
npm ci    # installs everything; takes ~2 minutes
```

You don't need to run Morphit itself to translate. Just edit JSON files.

### Find what needs translating

Use the translator-diff tool to see what's missing in your target locale:

```bash
npx tsx apps/web/scripts/i18n-translator-diff.ts es
```

This outputs three files into `apps/web/scripts/translator-output/`:

- **`<locale>-missing.json5`** — keys in `en.json` that are absent from your locale. Each entry includes the English source as an inline comment for context.
- **`<locale>-fallback.txt`** — keys present in your locale but byte-identical to the English source (likely placeholder copies still awaiting translation).
- **`<locale>-extra.txt`** — keys in your locale that don't exist in `en.json` (probably stale; remove or report).

Translate the strings in `-missing.json5`, then merge them into your `<locale>.json` file by hand (or use any JSON5 → JSON converter).

### Verify your work

```bash
npx tsx apps/web/scripts/i18n-locale-parity-smoke.ts
```

This is the master parity check. It enforces that every locale's JSON has every key from `en.json`, no extras, with the same nested shape.

### Quality bar

Machine translation (Google Translate, DeepL, ChatGPT) is acceptable as a **starting point** but never as the final shipped translation:

1. **Idiom and tone matter.** "Wrong passphrase. Retry." reads naturally in one register in English. Machine-translated, it'll be overly formal in some languages and oddly clinical in others. A native speaker catches this.
2. **Crypto/finance terminology has language-specific conventions.** "Wallet" is *cartera* in Spain but *billetera* in much of Latin America; "key" is *llave* (physical) or *clave* (cryptographic) — different words in Spanish. Native review picks the right register.

A reviewed machine translation is fine. An unreviewed machine translation is not.

### Submit

1. Open a PR against the Forgejo repo: `git.agorise.net/agorise/morphit`.
2. Tag a native-speaker reviewer in the PR description (the reviewer doesn't have to be the translator).
3. The reviewer signs off in the project Matrix room: `#agorise:matrix.org`.

If you don't have a Forgejo account or prefer not to open a PR, you can send the translated JSON to `@agorise:matrix.org` directly.

## Adding a new language

If the language you want to add isn't in either array:

1. Edit `apps/web/src/lib/i18n/locales.ts`. Add one entry to `PLANNED_LOCALES`:

   ```ts
   { code: 'sw', nativeName: 'Kiswahili', englishName: 'Swahili', rtl: false }
   ```

   Code is the BCP-47 language tag (lowercase ISO 639-1 for most languages; ISO 639-3 fallback for rare ones; add a script subtag like `-Hant` for cases like Traditional Chinese).

2. Open a PR. The PLANNED entry doesn't ship anything to users — it just signals work-in-progress.
3. Once the JSON file is complete and reviewed, move the entry from `PLANNED_LOCALES` to `SUPPORTED_LOCALES` (one-line edit).

## Right-to-left (RTL) languages

Persian (`fa`) is the production RTL canary. Arabic (`ar`) joins when its translation lands. The layout flips automatically based on the `rtl: true` flag in `locales.ts` — Tailwind utility usage is consistent across the codebase, so the flip is mostly transparent.

**That said, every new RTL locale should get a manual UI walkthrough**: open every page, click every modal, verify the layout flips cleanly. A bug here is surprising and hurts trust.

## Why is there no Weblate / Tolgee instance?

The project doesn't host one because hosting one adds infrastructure complexity that's only worth it past a certain volume of translators. We're not at that scale yet. Operators are welcome to stand one up and mirror translations back via PR.

If you do stand one up:

1. Mirror `apps/web/src/lib/i18n/locales/` into your Weblate.
2. Open translations to the public.
3. Pull approved translations back via PR to the Morphit Forgejo repo.
4. Announce in `#agorise:matrix.org` so other translators route their work to the same instance.

## Common pitfalls

- **Renaming a placeholder.** `{network}` → `{red}` breaks substitution. Translate around the placeholder, not the placeholder itself.
- **Translating a key name.** Key names like `assets.usdt.address_share.warning` are code identifiers — don't translate them.
- **Forgetting a plural form.** Languages with `one`/`few`/`many`/`other` need all four in ICU plural blocks.
- **Removing HTML tags.** `**bold**` markers stay; translate the words between them.
- **Adding extra keys.** Anything in your locale that isn't in `en.json` is dead weight; the parity smoke will flag it.

## Languages currently planned

In rough audience-priority order (post-launch addition queue):

| Code  | Native name        | English name | RTL  | Speakers   |
|-------|--------------------|--------------|------|------------|
| `hi`  | हिन्दी               | Hindi        | no   | ~600M      |
| `ar`  | العربية            | Arabic       | yes  | ~370M      |
| `bn`  | বাংলা              | Bengali      | no   | ~270M      |
| `pt`  | Português          | Portuguese   | no   | ~260M      |
| `id`  | Bahasa Indonesia   | Indonesian   | no   | ~200M      |
| `ja`  | 日本語             | Japanese     | no   | ~125M      |
| `vi`  | Tiếng Việt         | Vietnamese   | no   | ~85M       |

Translations welcome in any order — pick whichever you can find a native speaker for. The order isn't sacred. If a language not on this list matters to you, open a PR adding it to `PLANNED_LOCALES`.

## Reference

- `apps/web/src/lib/i18n/locales.ts` — locale registry (SUPPORTED + PLANNED arrays + matchSupported helper)
- `apps/web/src/lib/i18n/locales/` — JSON files, one per supported locale
- `apps/web/scripts/i18n-locale-parity-smoke.ts` — enforces parity across locales
- `apps/web/scripts/i18n-locale-registry-smoke.ts` — validates the locales.ts shape + 1:1 JSON correspondence
- `apps/web/scripts/i18n-translator-diff.ts` — translator-facing diff tool (added cp141)
- `docs/LOCALE-GRADUATION.md` — graduation procedure (the maintainer-side counterpart to this doc)
- This document — `docs/CONTRIBUTING-TRANSLATIONS.md`
