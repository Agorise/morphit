# Morphit notifications system — design doc

**Status:** Phases 1, 2, 3, 4 ✅ ALL SHIPPED.  Phase 3 (Web Push
for tab-closed delivery) landed.

Shipped infrastructure lives at `apps/web/src/lib/notifications/`:
- `ambient.ts` — title-bar prefix, favicon canvas badge, App
  Badging API.
- `native.ts` — Notification API (tab-open OS-level pings).
- `audio.ts` — opt-in audio cue (default off).
- `vibrate.ts` — opt-in vibration (default off, mobile only).
- `push.ts` — Web Push subscribe / unsubscribe client.
- `preferences.ts` — per-category opt-in storage.
- `crossPageTradeEvents.ts` — the on/off switch (localStorage
  `morphit.crossPageTradeEvents.enabled`, default on; Settings →
  Privacy) for the cross-page trade listener below. It is not a
  BroadcastChannel fan-out: nothing de-duplicates an event between two
  open tabs except the OS notification's tag.
- `chatUnread.ts` — the chat unread count, from read state plus the
  account-wide chat activity stream (`lib/chat/globalChatActivityStream.ts`).
- `chatNudge.ts` — when the in-chat "turn on chat notifications" nudge
  shows.
- (An earlier list named a `tradeNotifications.ts`; no such file
  exists. Trade events are the job of `lib/trades/tradeEventListener.ts`,
  described below.)

The cross-page trade listener (`lib/trades/tradeEventListener.ts`,
started by the root layout while signed in and the switch above is on)
flips order badges and raises order notifications for structured chat
messages (address shared, funds sent, …) without the chat being open.
Since v1.21.14 (W-H2) it opens no stream of its own — it used to keep one
chat stream open per recent peer, up to five, which with the app's other
streams used up the six connections a browser allows per site on a
plain-HTTP Tor/I2P instance. It listens to the account-wide activity
stream; on a ping naming a peer (a fast message, or a durable inbound one
whose ping carries no order) it reads that peer's conversation ONCE (a
chat stream closed after its snapshot, or after 30 s), one peer at a
time, and applies the new messages. A trade message only counts when it
names the order of the thread it arrived in and its sender is a party to
that order (W-H1); a party it cannot check yet is retried with back-off.
- `index.ts` — public `notify(event)` surface called from
  every notification site.

Backend-side push infrastructure:
- `apps/relay/src/policy/pushSubscriptions.ts` — subscription
  store (upsert / list / delete, failure-counter cleanup).
- `apps/relay/src/policy/pushSender.ts` — drains the
  `push_pending` queue, encrypts payloads per RFC 8291 via the
  `web-push` library, handles 410 Gone and transient failures.
- `apps/relay/src/api/push.ts` — `GET /v1/push/vapid-public-key`,
  `POST /v1/push/subscribe`, `POST /v1/push/unsubscribe`.
- `apps/web/src/service-worker.ts` — `push` and
  `notificationclick` handlers (dedup via tag, deeplink
  open/focus).
- Schema v33 — `push_subscriptions` + `push_pending` tables
  in `apps/indexer/src/db/schema.sql`.
- Indexer event emission — `push_pending` rows are written in
  three places (checked 2026-10-21, v1.21.14):
  - `apps/indexer/src/indexer/chatPushEnqueue.ts`
    (`enqueueChatPush`), called by the durable chat handler
    (`handlers/chat.ts`), by the head tailer (`headTailer.ts`,
    including its rechecks), by a verified federation push and a
    local delivery (`chatFastFederation.deliverVerifiedPush` with
    the gates from `api/federationChatFast.ts`), and by a parked
    first contact released when its stranger fee is recognised
    (`parkedFirstContacts.ts`, from either fast route). Every
    caller has already applied the block list; every route keys
    the row on the transaction id, so a message is pushed once
    however many routes deliver it. It also queues the offline
    notice (`offlineNoticeEnqueue.ts` → `offline_notify_pending`),
    whether or not the recipient has a push subscription.
  - `apps/indexer/src/indexer/feedbackPushEnqueue.ts`
    (`enqueueFeedbackPush`), called by the durable feedback
    handler and by the head tailer.
  - `apps/indexer/src/indexer/handlers/featureBid.ts`, directly:
    the "outbid" push to a displaced featured-slot bidder.

  Chat routes order-permlink messages under `category='order'`
  and other messages under `category='chat'` so users can opt
  out of chat noise but still get trade alerts. Until the
  recipient has written to the sender, a sender's messages earn
  one chat push per 24 hours (`chatPushEnqueue.ts`,
  `NO_REPLY_PUSH_WINDOW_MS`; the relay keeps chat and order
  tombstones 24 hours so the rule can see earlier pushes,
  v1.21.14). A fast-path push goes out before the chain has the
  message, by design; a message that never reaches the chain can
  therefore have been pushed.

`UnreadCounts` Readable store drives the title prefix +
favicon badge + the in-app inbox-tab unread dots.

The push-service-architecture decision: **user-selectable**
(self-hosted / standard / off), matching the existing
`push_notifications_privacy` FAQ entry. Operators ship a VAPID
keypair generated via `scripts/generate-vapid-keys.sh`; users
choose their privacy mode in Settings → Notifications.
Authentication on the subscribe endpoint for a later change is
rate-limited-only (no cryptographic proof of account ownership);
the trade-off is documented in `docs/OPERATIONS.md` §42.5 — a
future checkpoint may add posting-key signature verification.

> **Server side as of v1.21.14 (checked 2026-10-21).** The
> self-hosted / standard / off mode was never wired on the
> server. There is no operator push server; the relay accepts
> `privacy_mode: 'self_hosted'` from older clients and stores
> every subscription as `'standard'`
> (`apps/relay/src/policy/pushSubscriptions.ts`). "Off" means
> not subscribing. Subscribe and unsubscribe now require a
> posting-key signature by default
> (`MORPHIT_RELAY_PUSH_REQUIRE_SIGNED=true`). A relay whose chain
> endpoints are all hidden services sends no Web Push at all: a
> browser push service is a public clearnet host
> (`relayIsHiddenOnly` in `apps/relay/src/config/index.ts`;
> OPERATIONS §51).

**Last updated:** 2026-05-15 (Phase 3 shipped);
prior shipping iterated across Phases 5d-F.

## Context

Trades should complete fast so users feel momentum. A user who places an
order, walks away, and doesn't find out it filled for 4 hours is a user
who doesn't place a second order today. Notifications convert "walked
away" into "came right back."

Directive: **use every reasonable channel — visual, audible, native OS —
without being annoying.**

## The platform reality (what actually works)

### Favicon badge (canvas-redraw technique)

Works by rendering the current favicon into a `<canvas>`, drawing a
colored dot + count over it, and swapping the result into
`<link rel="icon">` as a data URI.

- ✅ Chrome, Edge, Firefox desktop — works on the **live tab**.
- ❌ iOS Safari — favicon pinned at load, cannot be updated.
- ❌ Most Android mobile browsers — same.
- ❌ Bookmarks bar — Chrome caches bookmark favicons aggressively. A
  new favicon in the tab does NOT propagate to an existing bookmark.
- ❌ Tab is closed → no JS runs → no badge.

**Verdict:** useful as a low-cost "you have unread items in this tab"
signal for users who keep Morphit open. Not a substitute for real
notifications.

### App Badging API (`navigator.setAppBadge`)

The actual native badge on OS-level app icons.

- ✅ Chrome, Edge desktop (installed PWA only)
- ✅ Safari 16.4+ on macOS/iOS (installed PWA only)
- ✅ Android Chrome (installed PWA only)
- ❌ Regular browser tab — does nothing.
- ❌ Firefox — not yet implemented (as of writing, check at impl time)

**Verdict:** the real answer for badge-on-icon when the user has the
PWA installed. Which many won't have.

### Web Push + service worker + Notification API

OS-native notification delivered even when the tab is closed.

- ✅ All major browsers on desktop (Chrome, Firefox, Edge, Safari 16+)
- ✅ Chrome on Android
- ❌ iOS Safari only if the PWA is installed to home screen (16.4+)
- ❌ Tor Browser at high security level — service workers disabled
- ❌ Firefox Focus, DuckDuckGo browser, etc. — often disabled

Requires user-granted permission. Requires a push service (we'd need to
set up a self-hosted push server or use a public VAPID-compatible one
like Mozilla's autopush or run our own).

**Verdict:** the single most important channel. Delivers when the tab is
closed, which is 95% of the use case.

### Native Notification API (tab-open only)

`new Notification("title", { body })` — OS-level notification but only
fires while the page has a live JS context. No service worker needed.

- ✅ Broad support on desktop
- ✅ Mobile browsers with open tabs
- ❌ Tab closed → no delivery

**Verdict:** simpler than Push API, no server infrastructure, but only
covers the "tab is open but not focused" case. Still valuable.

### Audio

`new Audio('/notify.mp3').play()` — straightforward but subject to
autoplay policies. User must have interacted with the page at least
once. Loud audio is annoying; use a short, quiet cue.

- ✅ All browsers, once user has interacted with page.
- ⚠️ Autoplay blocking on first page load.
- ⚠️ Disruptive if user is on a call, meeting, or has headphones in at
  high volume. MUST be opt-in.

### Vibration (mobile)

`navigator.vibrate([200, 100, 200])` — tactile notification on mobile.

- ✅ Android
- ❌ iOS (vibrate API removed)
- ⚠️ Spam-y if overused. MUST be opt-in.

### Title-bar pulsing

Update `document.title` to prefix unread count: `"(3) Morphit —
Orderbook"`. Ancient technique, works everywhere, no permissions needed.

- ✅ Every browser, every platform.
- ⚠️ Subtle — users not looking at the tab list won't see it.

## Recommended channel stack

Use ALL of these simultaneously when applicable:

1. **Title-bar prefix `"(N) Morphit — ..."`** — always on, no permission
   needed, no platform support question. Free.
2. **Favicon canvas badge** — always on, free, works for the live tab
   on desktop. No permission.
3. **App Badging API** — always on when available (installed PWA only).
   No permission beyond PWA install. Free.
4. **Notification API (tab-open)** — requires permission; opt-in per
   category (chat, orders, feedback). Triggers when event arrives AND
   tab is not focused.
5. **Web Push (tab-closed)** — requires permission; requires push
   server infrastructure; opt-in per category. Triggers regardless of
   tab state.
6. **Audio cue** — OFF by default. Opt-in in Settings. Short, quiet
   sound. Plays only when tab is not focused (no sense pinging a user
   who's staring at the page).
7. **Vibration** — OFF by default. Opt-in in Settings, mobile only.

## Annoyance-minimization policy

These rules are the actual UX contract — they're more important than
the technical stack:

### Never notify when the user is looking

Tab is `document.visibilityState === 'visible'` AND page has focus →
suppress ALL notifications except the title-bar prefix and favicon
badge (which are ambient, not alerts). The user doesn't need a ping
about a message they're already staring at. (In-page alerts, `notify()`.)

**Web Push differs** (`service-worker.ts`): a chat or order-scoped push
for a peer is suppressed whenever ANY tab on this device has that peer's
conversation open (`/chat/<peer>`), focused or not, visible or not —
having the thread open is the signal. A tab left open on a thread
therefore silences that peer's pushes on that device.

### Coalesce bursts

(Planned, not built.) The plan was ONE notification for a burst —
"3 new messages from @alice". What the code does: `notify()` remembers
each event id for 30 seconds and the same id again does not count
twice, and an OS notification carries the tag
`morphit-<category>-<id>`, so a redelivered event replaces its own
notification. Different messages are separate notifications.

### Per-category granularity

Three independent opt-in toggles in Settings:

- **Order events** — your order filled, expired, was replaced by
  counterparty offer, etc. RECOMMENDED ON. Highest signal-to-noise.
- **Chat messages** — new message in an active trade chat. DEFAULT
  ON (`preferences.ts`). (The plan said off for high-volume traders.)
- **Feedback events** — someone left you feedback, or someone
  responded to your feedback. DEFAULT ON.

Plus two orthogonal opt-ins:
- **Audible cue** — DEFAULT OFF.
- **Vibration** (mobile) — DEFAULT OFF.

### Respect OS-level DND

Browsers/OSs generally handle this for us — if the user has "Do Not
Disturb" or "Focus" on, notifications get suppressed automatically.
We don't need to detect this explicitly.

### Request permission at point of relevance

NOT on page load. First time a relevant event occurs (a message
arrives, an order fills), show an in-app banner: "You have a new
message. Want to know about future ones even when you're not here?
[Enable notifications] [Not now]". Roughly 3x the grant rate of
page-load prompts.

The permission banner (`PermissionBanner.svelte`, raised only when the
native channel is on in Settings and the browser has not been asked
yet): if user declines, don't ask again for a week. If they decline
twice, don't ask again this month. If they decline three times, never
ask again (respect their decision, show a "Enable notifications" button
in Settings for them to opt in if they change their mind).

The in-chat nudge (`ChatNotificationNudge.svelte`, `chatNudge.ts`) has
no such back-off: one "Not now" hides it for good on this browser.

### Quiet hours

Users can set explicit quiet hours in Settings ("No audible/push
notifications between 22:00 and 07:00 local time"). Visual channels
(title, favicon, badge) still work during quiet hours — they're
ambient, not alerts.

### Kill switch

One-click "Mute all notifications for [1 hour / 4 hours / until I
turn them back on]" in Settings AND in the title-bar notification
widget itself. Must be trivial to silence.

## Privacy considerations

**Push notifications go through a push service.** Standard Web Push
architecture uses either:
- Mozilla's public push service (free, used by Firefox)
- Google's FCM (free, used by Chrome — but telemetry to Google)
- Self-hosted (operator runs their own)

Every operator should be able to pick. The content of push messages
is end-to-end encrypted per Web Push spec (the push service sees
only ciphertext), but the **existence of a push** is visible to the
push service. An anonymity-conscious user may not want Chrome's FCM
knowing "this user just got pinged by morphit.io."

**Mitigation**: Settings toggle offers three levels:
- "Self-hosted only" — only subscribe to operator's push server
  (may not exist; falls back to tab-open notifications only).
- "Standard" — use browser-default push service.
- "Off" — no Web Push, tab-open notifications only.

Push message *content* is e2e encrypted in all cases, but "self-hosted
only" hides metadata from Google/Mozilla too.

> **Not built (server side, checked 2026-10-21).** No operator push
> server exists, and the relay stores every subscription as
> `'standard'`; see the note under the shipped-infrastructure list
> above. The relay delivers only to the browser vendors' push
> services (and hosts the operator adds in
> `MORPHIT_RELAY_PUSH_EXTRA_HOSTS`), and a hidden-only relay sends no
> Web Push.

## Phase plan

Ship in phases so the highest-value, lowest-risk pieces land first:

### Phase 1 — zero-permission channels (ship first)

1. Title-bar prefix with unread count.
2. Favicon canvas badge (live tab only).
3. App Badging API (installed PWA only, silently no-ops otherwise).
4. A small `notifications` store + module that owns the unread count
   per category.
5. Settings UI stubs for the opt-ins (don't wire Notification/Push
   channels yet; just persist the preferences).

Risk: ~zero. No permissions, no infra.

### Phase 2 — Notification API (tab-open)

1. Permission-request UX banner (deferred, at-point-of-relevance).
2. Settings toggle enabling per-category Notification API.
3. Coalescing + visibility-state logic.

Risk: low. No server infra. User opt-in gated.

### Phase 3 — Web Push (tab-closed)

1. Push server infrastructure decision (self-hosted vs. browser-default).
2. Service worker push event handler.
3. Per-operator push service registration.
4. The privacy-level toggle (self-hosted / standard / off).

Risk: medium. Requires operator infrastructure. Depends on service
worker caching decision being ratified too (since both use the same SW).

### Phase 4 — audio + vibration

1. Quiet cue sound asset (MIT-licensed, <5KB, <500ms).
2. Opt-in toggles in Settings.
3. Tab-not-focused check before playing.

Risk: ~zero. Opt-in by default.

## Foundational module shape

The notification abstraction needs to be ONE module that all call
sites use. Same shape regardless of which channels are active:

```typescript
// apps/web/src/lib/notifications/index.ts
export type NotificationCategory = 'order' | 'chat' | 'feedback';

export interface NotificationEvent {
  category: NotificationCategory;
  title: string;    // visible headline
  body: string;     // 1-2 sentence preview
  href?: string;    // where clicking takes the user
  id: string;       // for deduplication + coalescing
}

export function notify(event: NotificationEvent): void;
export function markRead(category?: NotificationCategory): void;
export const unreadCount: Readable<Record<NotificationCategory, number>>;
```

All call sites (chat handler, order-fill observer, feedback arrival)
call `notify(...)`. The module fans out to the channels that are
enabled for that user, applies coalescing, applies visibility rules.

Settings stores the preferences. Channels query settings at
notify()-time, not at subscribe-time, so toggling in Settings takes
effect immediately.

## Decisions made (historical record)

All four open questions from the original design doc are now
resolved.  Captured here so future contributors can read the
"why" without re-litigating settled choices.

1. **Phased ship plan** — ✅ All four phases shipped.  Phases 1
   and 2 in the original sprint; Phase 4 (audio + vibrate) close
   behind; Phase 3 (Web Push) landed after the
   wiring-completeness audit caught a "claim without code"
   regression.
2. **Annoyance policy** — ✅ Shipped as designed: no notification
   when the tab is focused, a 30-second de-duplication by event id
   (not the planned burst coalescing — see above), per-category
   opt-in (order, feedback and chat all ON by default), audio + vibrate OFF by default, permission requested
   at the point of relevance not on page-load.
3. **Push service architecture** — ✅ User-selectable
   (self-hosted / standard / off), matching the user-facing
   design the FAQ entry `push_notifications_privacy` had already
   set out.  Operators ship a VAPID keypair generated via
   `scripts/generate-vapid-keys.sh`; the client passes the
   user's choice to the relay's `/v1/push/subscribe` endpoint at
   subscribe time and the row's `privacy_mode` column records
   it. (**Corrected 2026-10-21:** the self-hosted mode was never
   wired. The column is always written `'standard'`, whatever the
   client sends; see the server note near the top.)
4. **Default states** — Chat is ON by default (`preferences.ts`; the
   original decision here was OFF). Order and feedback events are ON
   by default because they're rare and high-signal. Every category can
   be turned off in Settings → Notifications.

The push-sender worker (`apps/relay/src/policy/pushSender.ts`)
polls every 2 seconds (`MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS`,
default 2000; it was 30 s), encrypts payloads per RFC 8291
via the `web-push` library, handles 410 Gone with
auto-cleanup, and drops events older than 1 hour
(`MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS`) to avoid
delivering stale notifications.  Since v1.21.14 a pass does not
wait for the previous one: up to 32 rows are sent at once
(`PUSH_ROWS_IN_FLIGHT`), a row's devices are pushed side by side,
and one stalled push service (15 s timeout each) no longer holds
up anyone else.  A sent row is retired (`sent_at`), not deleted,
so a later enqueue of the same message lands on a conflict; the
tombstones are pruned after an hour, chat and order ones after 24
hours (`CHAT_PUSH_TOMBSTONE_RETENTION_SECONDS`, v1.21.14), because
the indexer's one-push-a-day-until-reply rule reads them.  A relay
whose chain endpoints are all hidden services runs no push sender;
a janitor retires and prunes the queue by the same rules.  Subscribe endpoint
authentication was rate-limited-only until
posting-key signature verification was added — every subscribe
request must carry a signature over
`morphit:push:subscribe:<account>:<sha256(endpoint)>:<timestamp>`
verified against the account's posting public key from chain.
±5 minute skew accepted.  Push payload strings are localized at
indexer-enqueue time using the user's locale recorded in
`push_subscriptions.locale` (also); ten locales supported
matching the client's i18n set.

**Offline notices (relay `apps/relay/src/notify/worker.ts`).** The
indexer queues an `offline_notify_pending` row from the same
enqueue as the chat push, fast path included. Since v1.21.14 the
relay sends a notice only once its message is stored in
`chat_messages` (allowing 2 minutes between the queued time, which
may be the sender's clock, and the block time): until then the row
waits, without counting as a try, for up to 3 hours after the
message, and is then dropped as never on chain. A message shown
and pushed on the fast path that never reaches the chain therefore
gets no offline notice.
