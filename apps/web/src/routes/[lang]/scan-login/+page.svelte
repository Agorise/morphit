<script lang="ts">
	/**
	 * /scan-login — phone-side QR scanner route (ADR-0022).
	 *
	 * Mounted on the user's phone (or any device with a
	 * camera).  The user's account must already be unlocked
	 * for the signing step to succeed; we don't gate the
	 * camera permission flow on that, so the user can see the
	 * confirmation card even if they're locked, then they hit
	 * the unlock flow on confirm.
	 */
	import Head from '$components/Head.svelte';
	import ScanLoginQr from '$components/ScanLoginQr.svelte';
</script>

<Head routeKey="scan_login" />

<section class="min-h-[calc(100vh-8rem)] py-8">
	<ScanLoginQr />
</section>
