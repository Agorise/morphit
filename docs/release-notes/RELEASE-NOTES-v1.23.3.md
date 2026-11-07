# Morphit v1.23.3

Profile pictures across the whole site.

## For people using the site

**One picture per person, everywhere.** Wherever the site shows someone — their profile
page, the explorer, the orderbook, chat, payment badges, reviews and feedback, your orders,
the Blurt Nodes page, the avatar menu — it shows, in this order:

1. the **Morphit avatar** they set in Settings. It is on chain, so it shows on every Morphit
   instance, and it always wins;
2. else their **Blurt profile picture** — once you have turned pictures on;
3. else their identicon, as before.

While the site is still finding out which one to show, it shows a quiet circle — never one
picture and then another.

**Blurt pictures are off until you turn them on.** Click **display** on the Blurt Nodes page,
or tick **Show Blurt profile pictures** in Settings → Profile pictures. Either one turns them on
across the whole site, in every tab, and this browser remembers it; **hide** (or the same
switch) turns them off again.

**Still private.** Your browser never fetches a picture from the site that hosts it: your
Morphit instance fetches it and shows it to you, so those sites never see you. The private
list of accounts you hid (Settings) never asks for pictures at all. Tor-only instances don't
fetch Blurt pictures and offer no switch; Morphit avatars show there as everywhere.

**A few places that showed only the identicon** — payment badges in chat, the leave-feedback
reminder, the peers under each of your orders, your blocked accounts in Settings — now show
the person's Morphit avatar too.

## For operators

Upgrade as usual. Nothing to configure. OPERATIONS.md §57.

- New `GET /v1/avatars/<account>`: the account's Blurt profile picture, fetched by your
  server exactly like the witnesses' pictures (the same guarded fetch, limits and Blurt image
  proxy fallback); 404 for an account with a Morphit avatar (pages show that one from the
  profile) or with no picture. The picture addresses are read from the chain in batches (one
  `get_accounts` for the accounts a page asks about at once) and kept an hour. At most 4
  fetches run at once and 64 wait. Nothing is fetched while nobody looks, and nothing for
  visitors who leave pictures off.
- A zero-clearnet instance never fetches Blurt pictures; `/v1/instance` says
  `"blurt_pictures": false` there, and the pages offer no switch.
- Picture fetches now say `User-Agent: morphit-indexer/account-picture` (the witnesses'
  pictures said `…/witness-avatar`), and their log lines are under `account-pictures`:
  `journalctl -u morphit-indexer | grep -E 'witnesses|account-pictures'`.

## For developers

- `indexer/accountPictures.ts` (new): `AccountPictures` — the picture fetcher, its caches,
  concurrency and proxy fallback, moved out of `witnessService.ts` (which re-exports the
  limits and helpers and uses the one shared instance `main.ts` passes in), plus
  `urlOf(account)` (micro-batched `get_accounts`, `PICTURE_URL_TTL_MS` = 1 h, up to
  `PICTURE_URL_CACHE_MAX` = 20,000 accounts, "no picture" kept too), `noteUrl` (fed by the
  witness list's bulk read) and `pictureOf(account)`. Bounded: `AVATAR_QUEUE_MAX` = 64
  waiting (beyond it "nothing now", no failure noted), `AVATAR_FAILED_MAX` = 10,000
  failures remembered. Tests: `accountPictures.test.ts` (10), each guard removed once to see
  a test fail.
- `api/accountPictures.ts` (new): `GET /v1/avatars/:who` (`:who`, not one of the security
  middleware's account parameters, so the public picture is cacheable), rate tier
  `account-avatar`. `hasMorphitAvatar(json_metadata)` → 404; a database error → 404 (never a
  Blurt picture that might stand in for a Morphit avatar); picture and 404 both
  `public, max-age=900`. The stored Morphit avatar is never served from here: raw, an SVG
  skips the browser sanitizer's bounds (`<use>` nesting, filters, timing), and one the
  sanitizer refuses must not come back through another door. Tests:
  `test/api/accountPictures.test.ts` (6), mutation-checked.
- `/v1/instance` gains `blurt_pictures` (`!clearnetRefused()`); `@morphit/indexer-client`
  `InstanceResponse.blurt_pictures?`; the web `instance` store carries it (false until
  loaded). Test: `instanceBlurtPictures.test.ts`, seen failing with the flag forced true.
- Web:
  - `stores/blurtPictures.ts` (`morphit.showBlurtPictures`, device tier, registered — the
    storage-key smoke's device-tier cap goes 10 → 11 for it; cross-tab through the `storage`
    event).
  - `avatar/blurtPicture.ts`: `blurtPicturesActive` (switch on ∧ instance can),
    `blurtPicturesUnknown` (switch on, instance not heard from yet → wait), a miss
    remembered for 2 minutes. `indexer/client.ts` `accountPictureUrl`.
    `indexer/profileSoon.ts`: the profile reads of one moment in one `getProfilesBatch`.
  - `IdentityLabel`: Morphit avatar → `pending` (the quiet circle; also while `hydrate` reads
    the profile, while your own profile is not read yet, and while pictures are on but
    unknown) → the Blurt picture → the identicon. New props `hydrate` (read the Morphit
    avatar here; used by `PaymentStatusBadge`, `PendingFeedbackReminderBanner`, my orders'
    peers and Settings' blocked list) and `noPicture` (Settings' hidden list, which must not
    reach the operator). `ChatMessage` passes `pending` while the peer's profile is read.
  - `AvatarMenu`, the profile page's hero and the explorer account header: the same order,
    waiting for the account's profile and the instance's answer.
  - The witnesses page: its "display" is the shared switch; its witnesses' Morphit avatars
    are read in one batch and always shown; Blurt pictures only once that batch has
    answered (review: before it, a Morphit avatar was preceded by the Blurt picture);
    non-producing witnesses get theirs from `/v1/avatars`; a broken Morphit avatar falls
    back.
  - Settings: a "Profile pictures" card (signed in; only when the instance can), badge
    "only this device". Strings `settings.blurt_pictures.*` in the 10 locales.
  - Tests: `IdentityLabel.blurtPicture.test.ts` (10) and `profileSoon.test.ts` (2), the new
    rules mutation-checked. Checked in a browser against a stubbed instance: the witnesses
    page (Morphit avatar shown with pictures off and first when on — with the profile batch
    held back, no Blurt picture is drawn first; the check saw the swap without the fix),
    the profile hero (off: identicon; on: the picture, the identicon on a 404, the Morphit
    avatar first) and the switch following across tabs. The Settings card, shown only when
    signed in, by the type check.
- Independent review before release: 1 high, 5 medium, 6 low, all fixed as above.
- Tests: the `vitest-must-pass` smoke reads up to 32 MiB of a suite's output
  (`MORPHIT_VITEST_OUTPUT_MAX_BYTES`; Node's default was 1 MiB, and the indexer's passing
  suite, at 1.03 MiB, read as "could not parse") and names an overflow as one. The failure-cap
  test keeps its ten thousand log lines instead of printing them, and checks each was logged.
  `settings-visibility-scope` smoke: the Profile pictures card, "only this device".
