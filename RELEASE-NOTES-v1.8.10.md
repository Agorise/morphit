# Morphit v1.8.10

## Profiles now show the right person

Opening one profile and then another showed you the **first** person's reputation and reviews on the second person's page. Reloading fixed it, which is why it looked like a caching quirk — it wasn't. Moving between two profiles reuses the same page, and the page only ever fetched its data once, when it first opened. Everything after that was stale: reputation, ratings, reviews, live orders.

Profiles now reload whenever you move to a different one, and the old person's details are cleared before the new ones arrive, so there is never a moment where you are looking at a mix of the two.

## One reputation number, not two

The same trader could show **4.75** on their profile and **3.97** on their order card. Both numbers were correct, but they were measuring different things, and only one of them was ever explained.

The number on order cards and in chat is a considered score: it starts cautious and rises as good trades accumulate, so a newcomer with three glowing reviews can't look like a veteran. The profile was showing the plain average instead — which always flattered, on the one page a person visits to decide whether to trust someone.

Profiles now lead with the same score you see everywhere else, with the plain average shown underneath and labelled, since that's what the star breakdown beneath it counts.

## Old accounts can post again

If your Blurt account dates back to Steem and you've never changed your posting key, Morphit would let you sign in and then refuse everything you tried to do — setting a display name, uploading an avatar — insisting your key "doesn't control any account on the blockchain". It does, and other Blurt sites accept it happily.

Morphit asks the chain which account a key belongs to. For accounts of that vintage the chain's index simply has no record, and Morphit treated "no record" as "no such account". It now falls back to the account name you gave when signing in, and then checks that name against your account's real published keys before anything is broadcast. Nothing is trusted that wasn't verified; the check that matters is now the one being used.

## Avatar size warnings that make sense

Three things were wrong here, all from the same cause: the upload screen was checking against limits that didn't match the real ones.

- A **3.5 KB** image was reported as over a "3.0 KB maximum". The actual limit is 6 KB — it was never too big.
- A **2.9 KB** image got a red error saying it was near the limit. It was less than half way.
- A file that genuinely was too large would have been told, reassuringly, that it was "getting close".

The screen now uses the real limits, and says three different things depending on which is true: nothing at all when you're fine, a gentle amber note as you approach 6 KB, and a clear red message — naming the actual maximum — if you go over. The text beside the picture no longer squashes into a narrow ribbon.

## You can use your own name

If you sign in as **@agorise** or **@kencode**, you can now write that in your display name. Those names are protected so strangers can't pose as them, but the protection was catching the actual owners: you could set exactly `agorise` and nothing else — not `Agorise` with a capital, not `@agorise`, not `Ken @ Agorise`.

Signing in proves who you are, so the account that holds a protected name is now free to use it. Everyone else is still blocked, including lookalikes built from Cyrillic or accented characters. Your short bio was never restricted.

## Smaller touches

- **The Send button stops shouting.** Before you've typed anything, and while a message is sending, it's disabled — but it was rendering bright white and reading as the main thing to press. It now matches the message box beside it.
- **More of the subject line fits.** The "RE:" line under a chat header was cut short with obvious empty space to its right; the ⋮ menu was reserving room across all three lines. The subject now uses the full width.
- **Quieter artwork.** The large icons on the three settings cards are now grey and much fainter.

## For people running a node

**A failed backup is no longer kept as if it worked.** This is the second half of the backup problem from v1.8.9, and it is worth reading if you run a node.

If your database was unreachable when the nightly backup fired, the script still wrote a small file, gave it a proper backup name, reported success, and exited cleanly. The health check then reported it as a fresh backup — because it genuinely was the newest file. A directory that looked like months of backups could have been months of 20-byte fragments.

The cause is that the standard shell on Debian and Ubuntu doesn't support the option that reports a failure in the middle of a chain of commands, so the script only ever saw the *last* step succeed. It now checks whether the database dump itself succeeded, and refuses to keep anything that failed or came back empty. `morphit-ops health` additionally refuses to call an implausibly small dump fresh.

**What to do once, after upgrading:**

```bash
sudo install -m 755 /opt/morphit/ops/backup/morphit-backup.sh /usr/local/lib/morphit/
ls -lS /home/morphit/backups | tail -20
```

The first command installs the corrected script — `morphit-ops upgrade` does not replace it. The second lists your backups smallest-last: anything measured in **bytes** rather than kilobytes is a failed run from before this release, and should be deleted so it can't be mistaken for something you could restore from. A real dump is tens of kilobytes at minimum.

You may now see backup failures reported where you previously saw silence. Those runs were already failing; you were simply not being told.

Your data, your keys, your trades — all untouched throughout.
