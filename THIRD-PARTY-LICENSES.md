# Third-party licenses

Morphit itself is licensed **AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). It is
built on open-source dependencies obtained via npm, each under its own license;
Morphit does not relicense them. This file discloses the licensing of those
dependencies, with particular attention to anything that is **not** a standard
permissive license.

## Summary

With the one exception noted below, the dependency tree is entirely permissive
and compatible with AGPL-3.0:

- The overwhelming majority are **MIT**, **ISC**, **Apache-2.0**, or
  **BSD-2/3-Clause** (plus a handful of **Unlicense / 0BSD / MIT-0 / CC0-1.0 /
  BlueOak-1.0.0 / Python-2.0**) — all permissive and AGPL-compatible.
- **MPL-2.0** dependencies are compatible with AGPL-3.0 via MPL-2.0's
  secondary-license provision.
- A few dual-licensed packages (`json-schema`: _AFL-2.1 OR BSD-3-Clause_; and a
  _MIT OR WTFPL_ package) are used under their permissive branch.
- `caniuse-lite` (**CC-BY-4.0**) is build-time browser-compatibility _data_ and
  is not distributed as part of the runtime application.

To regenerate the full picture from an installed tree:

```bash
npx license-checker --summary     # high-level counts
npm ls --all                      # full dependency graph
```

## Notable: `@beblurt/dblurt` — BSD-3-Clause-No-Military-License

Morphit's Blurt blockchain client, **`@beblurt/dblurt`**, is licensed
**`BSD-3-Clause-No-Military-License`** — a standard 3-clause BSD license **plus
a "no military use" field-of-use restriction**. It is a **runtime** dependency
of three shipping components — the **indexer**, the **relay**, and the **web
app** — where it provides the Blurt JSON-RPC client, key/crypto primitives, and
transaction types.

What this means:

- **It is not a standard "free / open-source" license.** A field-of-use
  restriction (here, prohibiting military use) is generally considered non-free
  — it fails the Open Source Definition's criterion of "no discrimination
  against fields of endeavor."
- **It interacts with Morphit's AGPL-3.0 license.** The AGPL guarantees the
  freedom to run the software for any purpose; the no-military clause on this
  dependency removes that freedom for the combined, deployed system. Morphit
  uses `@beblurt/dblurt` under its own terms (npm fetches it; it is not copied
  into Morphit's source), but anyone who **deploys or redistributes** Morphit
  together with this dependency is bound by the no-military restriction.
- **Downstream packaging.** Distributions that require strictly free software
  in their main archives (e.g. Debian `main`, Fedora) would treat a dependency
  carrying this clause as non-free.

If the no-military restriction is unacceptable for your use, the dependency can
in principle be replaced. Morphit already ships its own `@noble`-based Blurt
signing path (`apps/web/src/lib/blurt/nobleSigner.ts`) and thin RPC-client
wrappers (`apps/{indexer,relay,web}/src/.../blurt/client.ts`), and the remaining
uses of `@beblurt/dblurt` — the JSON-RPC client, the key primitives, and the
transaction _types_ — have permissively licensed equivalents. A migration off
`@beblurt/dblurt` is tracked as a possible future change. For now the
dependency is disclosed here so operators and redistributors can make an
informed decision.
