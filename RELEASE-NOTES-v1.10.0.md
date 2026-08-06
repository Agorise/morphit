# Morphit v1.10.0

**Theme: Morphit now installs completely offline. From a single self-contained download, with the network cable unplugged, the guided install runs start to finish — and the few steps that genuinely need the internet (your real HTTPS certificate, connecting to Blurt, and, if you opt in, listing your instance on-chain) complete themselves automatically the first time the box sees a connection.**

This finishes the offline appliance. An instance can be brought up in a place with no internet at all, on the local network, and it upgrades itself the moment a real link appears — retrying quietly until it succeeds, then stepping out of the way.

## Added

**Completely offline install.** There are now two downloads on each release:

- the usual slim source tarball, which fetches its dependencies while installing (needs internet), and
- a self-contained `-offline` tarball, which bundles *everything* — the application libraries, the operating-system packages, the Docker images, the Node runtime, and Kubo. Installing from it touches the network for nothing: `apt`, Docker, and every other step install from the bundle. It is a large download by design.

To install with no internet: download the `-offline` tarball on any machine, copy it to the target, extract it, and run the guided install. When the box is later connected, normal package updates are automatically restored (the offline install temporarily points `apt` at the bundled packages using a reversible setting that leaves your system's own package sources untouched; the finish-when-online helper removes it once you're online).

**Finish-when-online.** After the install, a background helper (`morphit-first-online`) watches for a real internet connection — it actually checks that it can reach several Blurt nodes, not just that a cable is plugged in. The first time it succeeds it obtains your real Let's Encrypt certificate (until then the site is served over HTTPS on your local network with a self-signed certificate, so it still works), connects the indexer and relay to Blurt, and — if you opted in — publishes your on-chain instance listing. Each step is done once and remembered; anything that can't finish yet is retried on the next cycle; when everything is done the helper retires itself.

**Opt-in automatic on-chain listing.** The guided install asks whether to list your instance on-chain automatically once online, or leave it for you to run `morphit-ops register` yourself later. The unattended path reuses the same relay key and passphrase your relay already runs with — no key is entered by hand.

**Fast initial sync.** A brand-new instance replays the Blurt chain from the beginning to build its local view. That catch-up used to fetch one block-window at a time; it now fetches several windows at once, each aimed at a *different* one of your configured Blurt nodes — so no single node is leaned on, and a slow or failing node is stepped around automatically — while still writing every block in strict order, one per transaction. A fresh instance reaches the chain head dramatically faster, and exactly the same data ends up stored. Nothing to configure; a tuning knob (`MORPHIT_INDEXER_BACKFILL_CONCURRENCY`) exists for the curious but defaults to one window per node.

## Changed

**The HTTPS step never blocks the install.** If Let's Encrypt can't be reached when you install (offline, or your domain isn't resolving yet), the certificate step is deferred to the finish-when-online helper instead of stopping the install. The site comes up immediately and upgrades to the real certificate automatically once it can.

## Fixed

**Guided-install robustness — from the first real federated deployment.** Standing up the first independent Morphit instance surfaced a batch of first-install issues, all now fixed so a fresh install comes up cleanly end to end:

- The real HTTPS certificate is made readable by the proxy on both first issue *and* on renewal, so the site keeps serving over the renewed certificate without hand-holding.
- The reverse-proxy and firewall containers now start in the right order, with the file permissions and controlled Docker access they need, instead of racing each other on a cold boot.
- The single shared database is set up once and used by both the indexer and the relay (an earlier layout created a second, empty database the relay then couldn't use).
- A multi-word instance name — and your optional Tor and I2P addresses — are now captured and stored intact, so your instance's name and onion/I2P links show up correctly.

## Notes

- No database migrations. No breaking changes. An ordinary online install behaves exactly as before — every offline mechanism is dormant unless a bundle is actually present.
- **Building the `-offline` tarball (for release maintainers):** run `bash scripts/build-offline-bundle.sh` on an Ubuntu 24.04 machine with Docker; it assembles the bundle and writes `morphit-v1.10.0-offline.tar.gz`. The release CI attempts this automatically on a best-effort basis, so a build machine without Docker never blocks a release.
- If a past install stopped waiting on a certificate or a Blurt connection, nothing needs undoing — re-run the guided install with this version; it finishes offline and the helper takes care of the rest when you're online.
