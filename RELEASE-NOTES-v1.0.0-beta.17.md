# Morphit v1.0.0-beta.17

A focused follow-up to beta16: it fixes a layout regression in the orderbook
filters and makes the in-app update prompt more reliable. Everyone gets the
fixes; there is nothing for operators to do beyond deploying it.

## Fixed

- **The orderbook filters no longer overlap each other.** On narrow screens
  (most visibly on phones), opening one filter could leave a second filter
  painted on top of the open list — for example, the payment-method pills
  appeared in the middle of the open currency list, and the controls looked
  tangled together. Each filter now lifts cleanly above the others while it
  is open and the idle filters sit behind the active one's backdrop, so only
  one list shows at a time and tapping elsewhere closes it. This was a
  display-only regression introduced in beta16; if you saw it, simply
  loading this build fixes it (no cache clearing or reset needed once the
  new build is served).
- **The "A Morphit update is available" prompt is more reliable.** "Load it
  now" now always applies the update — if the new version can't take over on
  its own within a moment (which can happen right after a hard refresh), the
  page reloads to pick it up instead of the button appearing to do nothing.
  A stale prompt also no longer lingers after an update has already been
  applied. (If your browser still shows a stuck prompt from before this
  build, clearing the site's data once clears it.)

## Under the hood

- The three orderbook selects (asset, currency, payment method) are stacked
  on one page; each is its own stacking context, and at an equal z-index
  sibling contexts paint in DOM order, so an open dropdown was being painted
  under the filters that follow it. The fix makes each select's z-index
  conditional on its open state — elevated above the shared backdrop while
  open, dropped below it while closed — which both layers the open list
  correctly and lets a tap on an idle filter close the open one.
- A regression smoke (`orderbook-select-stacking`) pins this layering across
  all three components so a future edit cannot silently fall back to the flat
  z-index that caused the overlap.
- The update banner now clears its reference to a waiting service worker once
  there is nothing left to apply (so it can't show a dead prompt), and "Load
  it now" has a short fallback reload guarded against a double reload, for the
  cases where the `controllerchange` event never fires (an uncontrolled page
  after a hard refresh, or a wedged worker). Two new scenarios in
  `service-worker-single-registration` pin both behaviours.
