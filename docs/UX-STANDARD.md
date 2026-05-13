# Grandma-UX standard

**Status:** binding for all frontend code
**Applies to:** every `.svelte` page, every form, every button, every
interactive control in `apps/web/`

## The principle

> Morphit is used by people who may be 80 years old, on their first
> day with a cryptocurrency, on a tablet with their reading glasses
> on. Every screen must leave no doubt about what just happened and
> what to do next. Feedback is instant, visible, and friendly — not
> childish, not cluttered, not subtle.

This isn't an accessibility doc. Accessibility (keyboard, screen
reader, high-contrast) is separately required. This doc is about
**cognitive affordance**: grandma should never have to think "did
that click register?" or "what am I supposed to do now?"

## Rules

### 1. Every button click shows feedback within 100ms

When grandma taps a button, she sees something change **before** the
action completes. That something can be:

- The button briefly depresses (`active:scale-[0.97]` CSS)
- A spinner appears in the button, replacing or joining the label
- The button becomes disabled with its "busy" state active

None of: "the button doesn't move, wait 2 seconds, then the page
changes." That looks broken.

**Enforcement:** every `<button onclick={...}>` that triggers an
async action must either (a) use the `<BusyButton>` component, which
handles depress + spinner + disable internally, or (b) justify in a
comment why it doesn't need to.

### 2. The next actionable element is visually heaviest

On any page where grandma needs to act, **one** element is the
"obvious next thing." That element is visually heavier than
everything around it via:

- **Bolder border** (`border-2 border-morphit-emerald` on the
  current step; `border border-ink-200` on context)
- **Stronger label weight** (next field's label is `font-bold`;
  surrounding copy is regular weight)
- **Gentle pulse** if it's a call-to-action (`animate-pulse-soft`)
- **Colored background** reserved for the primary action
  (`btn-primary` uses the emerald; secondary is ghost)

Only **one** primary action per screen. If there are genuinely two
equal choices, both are secondary and the primary is absent — don't
dilute the signal.

### 3. Every async state has a visible indicator

While the app is doing something grandma can't see, she sees that
something is happening. Three states, three indicators:

- **Idle**: no indicator.
- **Busy**: spinner + "Doing X…" text, in the region where the
  answer will appear. Never somewhere else on the page.
- **Done (success)**: a checkmark or filled state, persisting for
  at least 800ms before any redirect.

Never go from idle → done with no busy state visible. Even if the
operation is fast (under 200ms), show the busy state for at least
200ms so grandma sees the transition.

### 4. Errors are placed near the source, in color, with a fix

When something fails, the message:

- Appears adjacent to the input or button that caused it, not at
  the top/bottom of the page
- Uses a warm color (amber or red) distinct from normal text
- Includes **what to do next** — "Pick a different name" not just
  "That name is taken"
- Does not remove prior valid input — grandma's typed content stays
  in the field

### 5. Destructive actions need confirmation, but only once

"Sign out," "Forget addresses," "Delete keystore" — all need a
confirmation step. But:

- One confirmation, not two. No modal-in-a-modal.
- The confirming action is the heavy one; the cancel is the ghost.
- Confirmation text says what will happen in plain language:
  "Remove your saved BTC address from this device. You can re-add
  it anytime." — not "Are you sure?"

### 6. Waiting = progress, not silence

If grandma waits for more than 500ms, she sees something animating.
A spinner, a pulse, a progress bar. Not "grey page, nothing
happening."

If grandma waits for more than 5 seconds, add a plain-text note:
"This is taking a bit longer than usual…" so she knows the app
didn't crash.

### 7. Navigation tells her she's going somewhere

When grandma completes a step and the app routes her elsewhere:

- The current page shows a success state for at least 1.5 seconds
  before navigating
- If there's a "Taking you to the orderbook…" message, it appears
  AT LEAST 800ms before the navigation actually happens

No instant page swaps. Grandma needs to see the closure of one step
before the next one opens.

### 8. Irreversible actions get a human-paced pause

Broadcasting to the chain, signing out, wiping a keystore — these
are one-way. The submit button's busy state persists the whole
time. The user cannot navigate away while it's pending (via
`beforeNavigate` cancel).

### 9. Tooltips earn their place; they don't overflow

`<Tooltip>` is for the non-obvious. If you have to explain what a
button does via a tooltip, the button label is wrong. Fix the
label first.

### 10. Scale: inputs are ≥44px tall, fonts ≥16px

Touch targets at least 44×44px. Body text at least 16px. Hint text
at least 14px, never below. Grandma's reading glasses don't zoom.

## Components that enforce the standard

The following components handle the above rules automatically.
**Always prefer them over raw HTML buttons/inputs in interactive
flows.**

### `<BusyButton>`

```svelte
<BusyButton
    variant="primary"
    busy={submit.kind === 'submitting'}
    disabled={!canSubmit}
    onclick={submitRegistration}
    busyLabel={$_('onboarding.register_name.submit_pending')}
>
    {$_('onboarding.register_name.submit')}
</BusyButton>
```

Guarantees: press-depress animation, inline spinner when `busy`,
`aria-busy` attribute, disabled-while-busy, depress-scale on active.

### `<StatusLine>`

```svelte
<StatusLine kind={availability.kind}>
    {#if availability.kind === 'checking'}
        {$_('onboarding.register_name.availability.checking')}
    {:else if availability.kind === 'available'}
        {$_('onboarding.register_name.availability.available', { values: { name } })}
    {/if}
</StatusLine>
```

Guarantees: correct icon (spinner/checkmark/warning) for each kind,
`aria-live="polite"` region, minimum 1.25rem reserved height so
layout doesn't jump as messages appear/disappear.

### `<FocusedField>`

Wraps an `<input>` with:
- thicker border when it's the current-expected-action field
- subtle pulse on the border when the page first loads
- fade to normal border once the user has typed valid input

```svelte
<FocusedField
    focused={name.length === 0}
    valid={availability.kind === 'available'}
>
    <input type="text" bind:value={name} ... />
</FocusedField>
```

## Enforcement

- PR reviewers verify each new page follows all 10 rules before
  merge
- New interactive components are built on top of `<BusyButton>` /
  `<StatusLine>` / `<FocusedField>` unless there's a documented
  reason
- The register-name page (the first flow grandma hits after
  onboarding) is the reference implementation; deviations there
  require ADR or design-doc update

## Known gaps we're going to fix

> **2026-05-11 forward note (Part 120 audit):** This section
> originally listed gaps from the Phase 3a/3b era.  All have
> been closed: the register-name page, onboarding flow, and
> Settings all use `<BusyButton>` + `<StatusLine>` +
> `<FocusedField>` per the standard.  The list below is
> preserved for historical traceability; for the current
> state, the components themselves are the contract.

### ~~In the current register-name page (Phase 3a):~~ ✅ all closed

- ~~`btn-primary` submit has no depress animation or inline spinner.~~
  ✅ Replaced with `<BusyButton>`.
- ~~Availability line changes text but has no spinner/check icon.~~
  ✅ Replaced with `<StatusLine>`.
- ~~Name input is plain.~~ ✅ Replaced with `<FocusedField>`.
- ~~Success state is 2.5s; bump to 3s + explicit "Taking you to the
  orderbook…" countdown-free plain text.~~ ✅ Done.
- ~~Error card appears but doesn't cross-reference the input. Add a
  border accent on the input when the error specifically relates
  to the name.~~ ✅ Done.

### ~~In the onboarding flow (Phase 2):~~ ✅ all closed

- ~~Path choice buttons use hover but not active depress. Add it.~~
  ✅ Done.
- ~~Generating spinner is good; keep.~~ ✅ Kept; Part 89 added the
  600ms minimum visibility per GRANDMA-FRIENDLY-INVESTIGATION
  Tier 4.3.
- ~~Confirm-quiz submit button disabled until quiz complete — good.
  Add inline spinner for the brief async window between quiz pass
  and session boot.~~ ✅ Done.
- ~~The "Download backup file" button has no "Downloaded ✓" state
  after the download initiates. Add one.~~ ✅ Done; plus Part 92's
  printable backup card path now offers a third option.

### ~~In Settings (Phase 2):~~ ✅ all closed

- ~~"Save & broadcast to chain" has a `broadcasting` boolean but no
  inline spinner on the button. Fix.~~ ✅ Done.
- ~~Post-broadcast toast/status message exists but isn't `aria-live`.
  Fix.~~ ✅ Done.

### ~~All Phase 3b work (indexer UI on frontend):~~ ✅ all closed

- ~~Every loading state on every page built in 3b must use
  `<StatusLine>` with `kind="loading"`~~ ✅ Done.
- ~~Orderbook filter interactions get pulse feedback when results
  reload~~ ✅ Done.
- ~~Empty state has a specific, friendly illustration, not blank
  space~~ ✅ Done.
