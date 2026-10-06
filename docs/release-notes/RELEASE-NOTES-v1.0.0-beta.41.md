# Morphit v1.0.0-beta.41

This release is mostly a visual tidy-up. The app's accent colours are now consistent across
every screen, the source-code mirror list on the download page shows each host's real logo,
and an order's "expires in…" countdown reads the same wherever you see it. There's also a
small fix to how one rare order state is labelled.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched. This release
changes no third-party dependencies.

## A consistent coat of paint

- **One set of accent colours, everywhere.** A slightly off-brand brownish-amber had crept
  into a handful of spots over time — some status pills, a few warnings, the
  near-the-limit character counter, the order-expiry countdown. Those are gone. The app now
  uses one consistent palette: Morphit green for positive and active things, red kept
  strictly for warnings and destructive actions, teal for informational notes, and a
  neutral grey for plain status. Nothing about how anything *works* changed — it just looks
  tidier and more of-a-piece, in both light and dark mode.
- **Steadier link hovers.** A couple of navigation links could show an off-colour hover
  state; they now match the rest of the interface.

## Finding the source code

- **The mirror list shows real logos.** The download page lists the places Morphit's source
  is mirrored. GitFlic and Radicle used to share a generic Git mark; they now show their own
  logos — GitFlic's bear and Radicle's pixel mark — drawn in the same single-colour style as
  the GitHub, Codeberg, and GitLab icons, so they adapt cleanly to both light and dark mode.

## Watching an order's clock

- **One countdown style, everywhere.** An order's "Expires in 5d 3h" countdown now looks the
  same on the orderbook, in your own orders, on a profile, and on an order's own page — a
  calm Morphit-green chip that still ticks down to the second in the final minutes.
  Previously the orderbook version turned red and pulsed as the deadline neared, which didn't
  match the green countdown shown elsewhere. A normally-expiring order isn't an error, so it
  now stays green like the rest; the exact deadline is always in the tooltip.

## Smaller fixes

- **A rare order-status label is no longer alarming.** In one uncommon case — an order whose
  fee status hadn't been recorded yet — your orders list could show a red, "rejected"-looking
  label with a link about rejected fees, even though nothing was actually wrong. It now reads
  a plain "Not yet verified", matching how the order's own page has always described that
  state.

## For node operators

- No operator-facing changes in this release. Upgrading is the usual `morphit-ops upgrade`;
  no configuration or migration steps are required.
