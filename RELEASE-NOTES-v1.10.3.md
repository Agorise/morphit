# Morphit v1.10.3

**Theme: smoother upgrades, and a federation that welcomes regional and right-to-left instances. This release fixes a false upgrade error, lets instances brand themselves with the project name, and makes every text field work correctly in Persian, Arabic, and other RTL languages.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**Upgrades no longer fail with a false integrity error.** Since v1.10.1 every release ships two download files — the small standard tarball and a larger self-contained "offline" bundle — each with its own checksum. The upgrader picked whichever tarball it found first and, separately, whichever checksum it found first, with no guarantee they were the same file. So an online upgrade could fetch the tarball from one place and its checksum from another, decide they didn't match, and stop with a "SHA-256 mismatch" even though nothing was wrong. The upgrader now always uses the small standard tarball for an online upgrade and matches its checksum and signature to that exact file; the offline bundle is used only for genuine offline installs where you supply the file yourself. The integrity check is exactly as strict as before — it was simply comparing the wrong pair.

**Instances can brand themselves with the project name.** Registering an instance whose display name contained "Morphit" (for example "Morphit Latino") was being rejected as impersonation, which blocked the whole point of running a regional instance. The rule now allows the brand as part of a longer, distinct name while still blocking bare-handle impersonation ("morphit", "@morphit"), look-alike/homograph attacks, and the reserved infrastructure handles ("morphit-fees" and friends). The rightful owner of a reserved name is also exempt for that name, matching how user profiles already worked.

**Right-to-left languages now work everywhere text is entered or shown.** The half-space (ZWNJ) that Persian and other scripts rely on was being rejected as a forbidden character across instance names, order titles and terms, feedback, and payment-method labels — so a Farsi name or description couldn't be saved at all. That character (and the related joiner) is now accepted everywhere, while the genuinely dangerous zero-width space and bidirectional-override controls stay blocked. On top of that, every field where a user types text and every place user text is displayed now renders right-to-left correctly. Editing an instance's title and description in Farsi through `morphit-ops` works too.

## Notes

- No database migrations. No breaking changes.
- If a v1.10.1 or v1.10.2 upgrade stopped on a "SHA-256 mismatch," this release resolves it.
- An instance rejected earlier for a "Morphit …" name (or a right-to-left name) can register once the instances processing it are on v1.10.3.
