# Morphit v1.10.9

**Theme: a clean, trustworthy upgrade. The upgrade output no longer prints alarming-looking (but harmless) warnings that could make a new operator think something went wrong.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**No more "getcwd: cannot access parent directories" errors during an upgrade.** The upgrade backs up the install directory by renaming it, but the running tool was still "inside" that directory — so every helper it started afterward complained that its working directory had vanished. The upgrade now steps out to a stable directory before the rename, so those errors are gone. (They were always harmless — the upgrade completed correctly — but they read like a broken install.)

**Quieter dependency install.** The upgrade's dependency step printed several "npm warn deprecated" lines about third-party packages Morphit doesn't control and an operator can't act on. Those are now suppressed during an upgrade; genuine errors still show. (Developer builds keep the full output.)

**No stray "large chunk" build hint during an upgrade.** The frontend build's chunk-size hint — useful when developing, noise when upgrading — is no longer shown during an operator upgrade.

**The "is the new frontend actually being served?" check no longer gives a false "could not verify."** That check ran the instant the web container restarted, usually before it had finished coming back up, and reported it couldn't confirm. It now waits and retries briefly, so a successful upgrade reports a clean confirmation instead.

## Notes

- No database migrations. No breaking changes.
- These are all cosmetic-output fixes; v1.10.8 upgrades completed correctly despite the noise.
