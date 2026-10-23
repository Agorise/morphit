<!--
	Morphit — <LoginNameField>

	The account name, as the user name a browser's password manager pairs with
	the Morphit password field after it. Hidden (`hidden`: no box, so it never
	shifts the layout or the spacing of its siblings) and read-only.

	Why it exists (v1.21.14): Firefox's password manager looks backwards from a
	password field for the nearest text field it can call a user name, and writes
	the saved login's user name into it. With no such field of our own it took
	whatever text field came before: the language field on /settings (its menu
	opened and blurred the page), the memo of a BLURT transfer, the amount to
	power up. This field is the one it finds. Read-only, so it is never written:
	Firefox then fills only the password saved for THIS account (and nothing when
	there is none).

	Always the first thing in the same <form> as the password field(s); use
	<PasswordScope>, which provides both. Without an `account`, the signed-in
	account's name; `null` means none is known yet (the field stays empty).
-->
<script lang="ts">
	import { blurtAccountName } from '$blurt/ops/profile';

	let { account = undefined }: { account?: string | null } = $props();
	const name = $derived(account === undefined ? $blurtAccountName : account);
</script>

<input
	type="text"
	name="username"
	autocomplete="username"
	value={name ?? ''}
	maxlength="16"
	readonly
	hidden
/>
