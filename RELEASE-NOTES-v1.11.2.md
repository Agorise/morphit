# Morphit v1.11.2

**Theme: more places to find the source, a licence tag that finally matches the licence, quieter upgrades, and an easy on-ramp for making your own instance your own.**

## Added

**Nine more independent source mirrors.** The signed source is now pushed to nine additional git hosts — gitgud.io, forge.chapril.org, git.disroot.org, git.kaki87.net, codefloe.com, git.gay, bolha.dev, opencommit.eu, and sij.ai — bringing the download page and the on-chain distribution record to eighteen mirrors in total. More independent copies means the code is that much harder to take offline: blocking any one host does nothing when seventeen others still serve the same GPG-signed bytes.

**A clear guide to rebranding your own instance.** New guidance — in the run-a-node walkthrough and a new FAQ entry (in all ten languages) — walks through making a Morphit instance your own. Swapping the logo, colours, name, and wording needs no programming at all; deeper layout changes use SvelteKit. It recommends the free Visual Studio Code editor with the "Svelte for VS Code" extension and a live-reload preview, and links the official Svelte tutorial for anyone starting from scratch.

## Fixed

**Quieter, less alarming upgrades.** `morphit-ops upgrade` no longer surfaces two benign, unactionable messages that made a successful upgrade look uncertain: a build-tool note about the page fallback, and a "could not auto-verify the served frontend" line that appeared on nodes (like Tor-only or home boxes) that simply can't reach their own public URL to check. The upgrade still reports real problems loudly.

## Notes

- **No database migrations. No breaking changes.**
- **Licence metadata now reads AGPL-3.0-or-later** — matching what the `LICENSE` file itself has always granted ("version 3 … or, at your option, any later version"). Nothing about your rights changes; the SPDX tag simply now agrees with the licence text. (This also lets the project list on source-hosting sites that require future-GPL compatibility.) Cosmetic rebrands remain fully allowed — the only rule is that a *modified* public instance must offer its changed source to its users.
- **Operators on older versions:** this release records eighteen mirrors on-chain, more than the previous limit. An instance still running v1.11.1 or earlier will not accept this release's on-chain announcement until it upgrades — the canonical instance upgrades first, exactly as every release ceremony already does. Existing releases keep working on older instances until each one upgrades.
- **Housekeeping:** removed a redundant CI workflow (the offline install bundle is already built and attached automatically with every release).
