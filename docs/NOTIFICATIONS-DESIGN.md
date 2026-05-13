# Morphit notifications system — design doc

**Status:** Phases 1, 2, 4 ✅ SHIPPED; Phase 3 (Web Push for
tab-closed delivery) deferred to post-launch.

Shipped infrastructure lives at `apps/web/src/lib/notifications/`:
- `ambient.ts` — title-bar prefix, favicon canvas badge, App
  Badging API.
- `native.ts` — Notification API (tab-open OS-level pings).
- `audio.ts` — opt-in audio cue (default off).
- `vibrate.ts` — opt-in vibration (default off, mobile only).
- `preferences.ts` — per-category opt-in storage.
- `tradeNotifications.ts` — order / chat / feedback event
  glue against the indexer streams.
- `crossPageTradeEvents.ts` — BroadcastChannel fan-out so the
  same event in two open tabs only pings once.
- `index.ts` — public `notify(event)` surface called from
  every notification site.

`UnreadCounts` Readable store drives the title prefix +
favicon badge + the in-app inbox-tab unread dots.

Phase 3 (Web Push + service worker, tab-closed delivery)
remains the largest open piece — see "Decision needed from
you" section for the unresolved push-service-architecture
question.

**Last updated:** 2026-04-21 (design); shipped iteratively
across Phases 5d-F.

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
about a message they're already staring at.

### Coalesce bursts

If 3 events of the same category fire within 30 seconds, produce ONE
coalesced notification: "3 new messages from @alice" instead of three
separate pings. Debounce window resets on each event.

### Per-category granularity

Three independent opt-in toggles in Settings:

- **Order events** — your order filled, expired, was replaced by
  counterparty offer, etc. RECOMMENDED ON. Highest signal-to-noise.
- **Chat messages** — new message in an active trade chat. DEFAULT
  OFF for high-volume traders; DEFAULT ON for low-volume.
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

If user declines, don't ask again for a week. If they decline twice,
don't ask again this month. If they decline three times, never ask
again (respect their decision, show a "Enable notifications" button
in Settings for them to opt in if they change their mind).

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

## Decision needed from you

1. **Approve the phased ship plan** — phases 1-4 as proposed.
2. **Approve the annoyance policy** — no-notify-when-focused,
   coalesce-30s, per-category opt-in, audio/vibrate default OFF,
   point-of-relevance permission request.
3. **Push service architecture** — self-hosted only, browser-default
   acceptable, or user-selectable? (The user-selectable option is
   most privacy-respectful but most complex.)
4. **Default states** — chat notifications default ON or OFF? High-
   volume traders want them OFF by default to reduce noise; low-
   volume users want them ON so they don't miss messages. Asking
   on first chat ("enable notifications for this thread?") is an
   alternative.

Once answered, phase 1 is ~half a day of work, phase 2 is another
half day, phase 3 is 1-2 days depending on push infrastructure
choice, phase 4 is a couple hours.
