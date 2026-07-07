# Morphit v1.0.0-beta.32

This release fixes a bug where your avatar could vanish after a profile edit, makes
your avatar and display name show up everywhere they should, lets you skip typing
your account name when you import from a seed phrase, makes that lookup private,
hardens every text field against pathological input, and adds the usual round of
polish to the profile and sign-in screens.

Nothing here changes how trading works or what anything costs, and Morphit still
keeps no data about you. If you're already signed in, your account, keys, and
balances carry over untouched.

## Your profile and avatar

- **Fixed: your avatar no longer disappears when you change only your bio.** Updating
  one part of your profile (say, just your short bio) used to overwrite the rest,
  which could orphan an avatar you'd already set even though it was still on chain.
  Profile updates now merge field-by-field — an omitted field is left alone, and only
  an explicit clear removes one — so a partial edit keeps everything else intact.

- **Your avatar shows up everywhere now.** Once you've set an avatar, it appears in
  the top-right menu and anywhere your identity is shown, not just on your public
  profile page.

- **A display name is now optional.** You can set an avatar and links without being
  forced to choose a display name first, and leaving the name blank no longer wipes a
  name you set earlier.

- **A bit more room for your avatar.** The inline avatar size limit was raised so more
  designs fit comfortably.

- **Clearer broadcast status and a new avatar card in Settings.** Publishing now says
  "Broadcasted" when it lands, and Settings gained a dedicated avatar card with a
  thumbnail preview and a confirmation step before you replace one.

## Signing in

- **Importing from a seed phrase now finds your account name for you.** A seed phrase
  contains your keys but not your account name, so you used to have to type it in by
  hand. Morphit now looks the name up for you, and if it matches exactly one account
  it signs you straight in. If it's ambiguous or unavailable, you simply enter the
  name as before.

- **That lookup is private.** The name lookup goes through your operator's own node,
  so the request — and your connection — never reaches a third-party node directly. If
  the lookup can't be made for any reason, Morphit quietly falls back to asking you
  for the name rather than reaching out to anyone else.

- **Import-screen polish.** The remember-me option is gated correctly, and a mismatch
  is flagged with a clear red border. The "sign in with your keys" button shows a lock
  icon on the welcome-back screen.

## Privacy and hardening

- **Every text field has a length cap.** A site-wide review added a length backstop to
  every free-text input and text area, on top of the existing validation, so an
  oversized or pathological paste can't slip through. The caps are set above every
  legitimate limit, so normal input is never cut off.

- **Clearer errors when your key doesn't match.** Before publishing, Morphit now checks
  that your key actually has authority for the action and tells you up front if it
  doesn't, instead of failing further along.

## Small fixes and polish

- The block-explorer card was removed from the home page (with a subtle hover lift on
  the cards that remain), the slide-in arrow links were unified into one consistent
  style across the app (correct in right-to-left languages too), the FAQ article hover
  border was toned down, and the profile page now shows your identity glyphs without
  repeating the `@handle`, with friendlier titles like "Message @username" on other
  people's profiles.

## For operators

- **The welcome dust for new accounts was nudged up slightly** so a brand-new account
  has a touch more headroom out of the gate. Funding requirements are otherwise
  unchanged.

- As with recent betas, **this release changes no third-party dependencies.**

## Under the hood

- **Two fresh, independent code reviews** re-ran the full test, type-check, and
  security-smoke suites from a clean slate. The first audited every text input across
  the site for injection and overflow risks and confirmed there's no stored-cross-site
  scripting hole. The second re-checked the new profile, avatar, and seed-import work
  and caught one privacy issue before release: the seed-import name lookup had been
  reaching a third-party node directly. It now routes through your operator's node like
  the rest of Morphit, with a regression check added so a future change can't quietly
  reintroduce a direct lookup.
