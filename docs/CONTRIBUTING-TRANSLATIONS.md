# Contributing translations

Morphit ships in 10 locales today (en, es, de, pl, fr, it, ru, fa, zh-CN, zh-HK) and has 7 more scaffolded for upcoming translations (hi, ar, bn, pt, id, ja, vi). This doc is for translators or operators who want to help complete or add a language.

## How the i18n system works

Each language is a single JSON file at `apps/web/src/lib/i18n/locales/<code>.json`. The structure mirrors `en.json` exactly; the i18n parity smoke (`apps/web/scripts/i18n-locale-parity-smoke.ts`) enforces that every key in `en.json` appears in every other locale's JSON. A missing key blocks CI.

At runtime, svelte-i18n looks up the user's chosen locale and falls back to `en` for any key that's missing — so translation work can be incremental without breaking the UI.

## Locale states

Locales live in one of two arrays in `apps/web/src/lib/i18n/index.ts`:

- **`SUPPORTED_LOCALES`** — translations are complete and native-speaker reviewed. Appears in the language-switcher dropdown. Ships a JS bundle.
- **`PLANNED_LOCALES`** — scaffolded for translation work. Does NOT appear in the switcher. Does NOT ship a JS bundle. Has metadata (display name, RTL flag) but no JSON file yet.

A locale graduates from `PLANNED_LOCALES` to `SUPPORTED_LOCALES` when:

1. The `<code>.json` file exists at `apps/web/src/lib/i18n/locales/<code>.json`.
2. Every key from `en.json` is present (the parity smoke confirms this).
3. A native speaker has reviewed the translation.
4. The reviewer has approved with a signed message in the project's Matrix room (`#agorise:matrix.org`).

## Adding a new language

If the language you want to add isn't in either array:

1. Edit `apps/web/src/lib/i18n/index.ts`. Add a single entry to `PLANNED_LOCALES`:
   ```ts
   { code: 'sw', nativeName: 'Kiswahili', englishName: 'Swahili', rtl: false }
   ```
2. Open a PR. The PLANNED entry doesn't ship anything to users; it just signals work-in-progress.
3. Start translating into a `<code>.json` file. You don't need to translate everything at once — partial translations live as branches against the project until they're complete.

## Translating an existing PLANNED locale

1. Copy `apps/web/src/lib/i18n/locales/en.json` to `apps/web/src/lib/i18n/locales/<code>.json`.
2. Replace every English string with the translation. Preserve key names exactly — they're not translated.
3. Preserve placeholders like `{name}`, `{count}`, `{amount}`. These are filled in at runtime; renaming them breaks the substitution.
4. Run `tsx apps/web/scripts/i18n-locale-parity-smoke.ts` to verify completeness.
5. Get a native-speaker reviewer to sign off in the Matrix room.
6. Move the entry from `PLANNED_LOCALES` to `SUPPORTED_LOCALES` in `index.ts` (one line).
7. Open a PR.

## Translation tooling

The project doesn't currently host a Weblate/Tolgee instance, but operators are encouraged to. If you stand one up:

1. Mirror `apps/web/src/lib/i18n/locales/` into your Weblate.
2. Open translations to the public.
3. Pull approved translations back via PR.
4. Announce in `#agorise:matrix.org` so other operators can route their translation contributions to the same instance.

## Quality bar

Machine-translated content (Google Translate, DeepL, ChatGPT) is acceptable as a STARTING point but not as the shipped translation. Two reasons:

1. Idiom and tone matter. "Wrong passphrase. Retry." translates to wildly different registers in different languages — overly formal in some, oddly clinical in others. A native speaker catches this.
2. Crypto/finance terminology has language-specific conventions. "wallet" is *cartera* in Spain but *billetera* in much of Latin America; "key" might be *llave* (physical) or *clave* (cryptographic). Native review picks the right register.

A reviewed machine translation is fine. An unreviewed machine translation isn't.

## RTL languages

Persian (`fa`) is the production RTL canary. Arabic (`ar`) joins it once translation lands. RTL just-works because Tailwind utility usage is consistent across the codebase, but every new RTL locale should get a manual UI walkthrough — open every page, click every modal, verify the layout flips cleanly. A bug here is surprising and hurts trust.

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

Translations welcome in any order — pick whichever you can find a native speaker for. The order isn't sacred.
