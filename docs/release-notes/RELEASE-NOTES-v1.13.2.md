# Morphit v1.13.2

**Theme: a node can never come up with a broken or missing web frontend again — online *or* from a USB stick with no internet at all.**

## Fixed

**An incomplete frontend build can no longer take a whole node dark.** If the web build ever finished without its root entry point (`index.html`) — every per-locale page present but the root missing — the site returned HTTP 500 on *every* request: nginx's fallback rewrote `/index.html → /index.html` in an endless loop. A real operator's node went completely dark this way while the box itself was perfectly healthy. Three independent guards now make that impossible:

- The build guard verifies `index.html` is actually present before trusting a shipped frontend, and **rebuilds** rather than serving an incomplete one; after any fresh build it **fails loudly** if `index.html` didn't appear, so an incomplete build can never pass as success.
- The install now **stops with a clear message** (and a memory hint) if the frontend is missing its entry point, instead of deploying a dark site.
- The frontend web server now **degrades to a clean error** instead of an infinite redirect loop if the entry point is ever absent.

**Offline / USB installs now carry the prebuilt frontend.** The offline "appliance" bundle — the one you can hand someone on a USB stick for a node with no internet — was shipping everything *except* the built frontend, forcing the air-gapped machine to build it on-target. That on-target build is memory-heavy, isn't byte-for-byte reproducible with the canonical release, and (as above) could fail silently. The bundle now **builds the canonical frontend once and ships it**, so an air-gapped node serves the exact same bytes as an online one, with no build required on the target. The bundle refuses to ship if that frontend didn't make it in.

## Notes

- Display-and-packaging release: no database migration and no on-chain changes.
- Operators on a node whose site is currently returning 500 or was hand-patched will have it made permanent by upgrading to this release.
- Everything from v1.13.1 and earlier is included.
