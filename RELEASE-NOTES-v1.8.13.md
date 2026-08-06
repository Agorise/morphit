# Morphit v1.8.13

## Nobody's name or picture changes in front of you any more

This is the whole release, really. Everywhere Morphit shows who someone is, it used to guess first and correct itself a moment later.

An order card would appear with `@username` and a default heart icon, then — sometimes seven seconds later — replace both with the person's real name and photo. The same thing happened in chat, on order pages, in review lists, and in your inbox.

That is a bad thing for a marketplace to do. If you are deciding whether to trade with someone and their identity rewrites itself while you watch, the reasonable reaction is to walk away. It looks exactly like someone swapping the card out from under you. Nobody should have to know it was harmless.

Two changes fix it:

- **Order listings now arrive with the poster's name and picture already attached**, instead of fetching them separately afterwards. The card is right the moment it appears.
- **Everywhere else, Morphit now waits instead of guessing.** While someone's details are still loading you see a quiet placeholder, not a wrong name. The change you see is from *nothing* to *the truth*, never from one identity to another.

Nine places were affected; all nine are fixed, and a check now runs on every build to catch any new page that guesses.

## Clearing a flag now clears the flag

If Morphit's self-dealing checks flag two accounts, their reviews stop counting toward each other's score — and the person running the node can clear that when it's a false positive.

The menu offered to clear "both signals". There are four. Picking it recorded a decision about two of them, reported success, and left the others in place, so the reputations stayed hidden and nothing on screen explained why. Clearing part of something while saying "done" is worse than refusing outright.

The menu now lists all four checks, and "all signals" means all four. Two of them re-arm rather than being permanent — if the pattern genuinely resumes, it is caught again — and the tool now says so, because someone who thinks a decision is final will not understand a later re-flag.

## Reviews that don't count say why

The badge on an uncounted review claimed the reviewer was "flagged as related". That was often untrue — four different checks can exclude a review, and since the last release the badge also appears on reviews not linked to an order, where nobody is flagged at all. It now simply says **"Not counted toward the rating"**, and the reputation card above explains the rest.

The FAQ said Morphit ran two pattern detectors. It runs four. Corrected, and translated into all ten languages.

## For people running a node

**No database changes.** This release is frontend and tooling only.

Two fixes to the upgrade itself, both of which you would have seen last time:

- **The false schema warning is gone.** v1.8.12 ended by warning that the database schema had changed "not via a numbered migration" and pointing at a reset procedure. It had shipped a numbered migration, which was applied automatically — the check only compared schema files and never looked for the migration. A false alarm that recommends rebuilding a database is worse than no alarm at all.
- **The `getcwd` errors are gone.** Upgrading from inside `/opt/morphit` left your shell on a directory the upgrade had just replaced, and every subsequent step printed an error about it. Harmless, but noise that looks like breakage teaches you to skim past the warnings that matter.

Your data, your keys, your trades — all untouched throughout.
