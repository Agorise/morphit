/**
 * Was this `input` event typed (or pasted) into the field by the person?
 *
 * A search-and-pick field (language, currency, payment method) opens its
 * menu — which paints a `fixed inset-0 backdrop-blur-sm` scrim over the whole
 * page — when text arrives. Text also arrives without the person: Firefox's
 * password manager wrote the saved login's user name ("morphit") into the
 * language field on /settings as the page loaded, the menu opened, and the
 * page stayed blurred until the next click (v1.21.14). Typing and pasting
 * need the field focused; autofill and scripts do not, so text that arrives
 * while the field is NOT focused was not typed by the person. (The reverse
 * does not hold: a browser can also write into a focused field. The
 * password-field forms — PasswordScope — keep the password manager away from
 * these fields; this is the second line.)
 */
export function typedByUser(input: HTMLInputElement | undefined): boolean {
	return input !== undefined && typeof document !== 'undefined' && document.activeElement === input;
}
