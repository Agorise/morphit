<script lang="ts">
	/**
	 * /login/qr-pair — desktop QR-pairing route (ADR-0022).
	 *
	 * Renders the LoginQrInitiator component.  This route is
	 * deliberately separate from /login because the pairing UX
	 * benefits from a dedicated screen — a QR plus countdown
	 * plus instructions deserves its own surface, not a tab on
	 * the unlock form.
	 */
	import Head from '$components/Head.svelte';
	import LoginQrInitiator from '$components/LoginQrInitiator.svelte';
</script>

<Head routeKey="login_qr" />

<section class="min-h-[calc(100vh-8rem)] py-8">
	<LoginQrInitiator />
</section>
