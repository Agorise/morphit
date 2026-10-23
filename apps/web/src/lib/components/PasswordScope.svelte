<!--
	Morphit — <PasswordScope>

	Wrap every field that takes the Morphit password (current or new) in one of
	these. It is a <form> of its own whose first field is the account name
	(<LoginNameField>; the signed-in account unless `account` is given), so a
	browser's password manager keeps its autofill inside it.

	Outside a form, Firefox's password manager treats every field on the page
	as one login form and writes the saved user name into the nearest text field
	before the password: on /settings that opened the language field's menu and
	left the page blurred (v1.21.14); in the BLURT transfer it was the memo.

	It never submits: Enter in a field does nothing here, the caller's own
	buttons (type="button") act. `class` defaults to "contents", so the form
	adds no box of its own; pass "block" when the parent spaces its children
	with `space-y-*` (margins do not apply to a "contents" box).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import LoginNameField from './LoginNameField.svelte';

	let {
		account = undefined,
		class: className = 'contents',
		children
	}: { account?: string | null; class?: string; children: Snippet } = $props();
</script>

<form class={className} novalidate onsubmit={(e) => e.preventDefault()}>
	<LoginNameField {account} />
	{@render children()}
</form>
