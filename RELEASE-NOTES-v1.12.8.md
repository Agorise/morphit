# Morphit v1.12.8

**Theme: the fix that stops the false "Build integrity check failed" banner now actually takes effect. v1.12.7 shipped the prebuilt frontend but couldn't deploy it on the same upgrade that delivered it (an upgrade runs the previous version's code); this release closes that gap at the build-script level, so it works on every upgrade from here on — from any prior version.**

## Fixed

**The prebuilt frontend is now used no matter how old the upgrading node is.** v1.12.7 made instances deploy the canonical prebuilt frontend instead of rebuilding it locally — but because `morphit-ops upgrade` runs the code of the version you're upgrading *from*, the v1.12.7 upgrade itself still rebuilt. The decision now lives in the build script (`apps/web`), which always comes from the new release, so upgrading to this version (and every version after) deploys the shipped, byte-identical frontend that matches the on-chain hashes — regardless of which version the node is coming from. Instances that were tripping the tamper banner will stop once they're on this release and re-registered.

## Notes

- No database migration in this release.
- After upgrading, a federated instance serves byte-for-byte the same frontend as the canonical build, so its `/verify.json` matches the on-chain-pinned hashes and the build-integrity check passes.
- Everything from v1.12.7 (hidden-only RPC on tor-only sites, honest RPC-connectivity reporting, self-healing first backup, 15-second offline register timeout) is included.
