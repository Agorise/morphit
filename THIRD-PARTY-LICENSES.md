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
- The fonts in the repository are under the **SIL Open Font License 1.1**, with
  the license file next to them: Comfortaa (`apps/web/static/fonts`, served to
  browsers) and Comfortaa + Vazirmatn (`apps/ops-cli/assets/og`, used on the
  server to draw a branded instance's link-preview image).

**What the browser receives.** The web build writes
`apps/web/build/licenses.txt`: every package whose code is in the JavaScript a
Morphit site sends to the browser, with its version, license and the notices
its authors ship (for example `@beblurt/dblurt`, libsodium, and `pako`
(MIT AND Zlib) and `rgbcolor` (MIT), which arrive inside `jspdf` for the chat
PDF export). Every instance serves it at `/licenses.txt`, linked from the
site footer.

To see the full dependency graph from an installed tree:

```bash
npm ls --all
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

## The offline bundles

Every release ships `morphit-X.Y.Z-offline.tar.gz` (signed), built by the
release job: Morphit's source, its npm dependencies (above), the prebuilt
frontend, and the Node.js runtime and Kubo where those are downloaded. The
**appliance** bundle, built by anyone with `scripts/build-offline-bundle.sh` on
an Ubuntu 24.04 machine with Docker so that a node can be installed with no
network, also carries the Ubuntu packages and the container images. Between them
they redistribute third-party software under that software's own licenses:

| Contents | Where in the bundle | License | Source |
|---|---|---|---|
| Node.js runtime (22.x) | `vendor/node/` | MIT, with bundled components under their own permissive licenses (its `LICENSE` file lists them) | https://github.com/nodejs/node, tag of the bundled version |
| Kubo (IPFS) | `vendor/kubo/` | MIT OR Apache-2.0 | https://github.com/ipfs/kubo, tag of the bundled version |
| Ubuntu 24.04 packages, appliance bundle only (the `.deb` closure: PostgreSQL, Tor, i2pd, Docker Engine, Ansible, fail2ban, AIDE, rkhunter, Postfix, certbot and their dependencies) | `vendor/apt/` | each package's own license, in its `/usr/share/doc/<package>/copyright` once installed (GPL, LGPL, BSD, MIT, Apache-2.0, PostgreSQL and others) | Ubuntu: `apt-get source <package>` on a 24.04 system, or https://launchpad.net/ubuntu/+source/<package>; Docker Engine: https://github.com/moby/moby |
| BunkerWeb 1.5.10 and its scheduler (container images), appliance bundle only | `vendor/docker/` | AGPL-3.0 (BunkerWeb), with the images' Linux userland under its own licenses | https://github.com/bunkerity/bunkerweb, tag `v1.5.10` |
| nginx (alpine) base image of the `frontend` container, appliance bundle only | `vendor/docker/` | BSD-2-Clause (nginx), Alpine userland under its own licenses | https://nginx.org/en/download.html and https://gitlab.alpinelinux.org/alpine/aports |

`vendor/BUNDLE-MANIFEST.txt` in each bundle lists the exact versions and
checksums.

## Written offer for source code

For the GPL-, LGPL- and AGPL-licensed software in the offline bundle, the
corresponding source code is available from the upstream locations in the table
above, at the versions listed in that bundle's `BUNDLE-MANIFEST.txt`. If you
cannot obtain it there, ask the Morphit maintainers in the public Matrix room
`#agorise:matrix.org` within three years of the release, and we will provide
the corresponding source for that release, for no more than the cost of
providing it. Morphit's own source is in the same release, and every operator
running a modified Morphit must offer theirs under the AGPL.
