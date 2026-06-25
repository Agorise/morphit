/**
 * Morphit — recommended authenticator apps for the 2FA enrollment flow.
 *
 * **Strict open-source-only policy.**  This list is the canonical
 * source for what the 2FA enrollment UI surfaces to users.  Apps
 * recommended here MUST satisfy ALL of:
 *
 *   1. Open-source under an OSI-approved license (typically GPL/AGPL).
 *   2. Encrypted backups available (cloud or local) — so a lost device
 *      doesn't lock the user out of every account they've enrolled.
 *   3. Does NOT phone home with telemetry or analytics by default.
 *   4. Available on at least one of: F-Droid / iOS App Store /
 *      Android Play Store / direct platform-native distribution.
 *
 * **Explicitly NOT recommended** (and we say so out loud in the UI):
 *
 *   - **Google Authenticator** — closed source.  Until 2023 had no
 *     backup at all (lost phone = lost every 2FA); now offers
 *     opt-out (not opt-in) Google Cloud sync of unencrypted secrets
 *     to Google.  Morphit users are exactly the population that
 *     should NOT be syncing their 2FA secrets to Google.
 *   - **Microsoft Authenticator** — closed source; mandatory
 *     Microsoft-account telemetry.
 *   - **Authy** — closed source; cloud-only backups with
 *     dubious account-recovery flows (history of SIM-swap exploits);
 *     desktop app deprecated 2024.
 *   - **LastPass Authenticator** — closed source; LastPass's own
 *     2022 breach included master-vault leaks.
 *   - **Duo Mobile** — closed source; Cisco-owned; enterprise-focused.
 *
 * The point of TOTP-based 2FA for a privacy-respecting marketplace
 * is that the second factor's secret material is NOT being shared
 * with a third party.  Recommending an app that backs the secret up
 * to Google or Microsoft defeats that purpose.
 *
 * If the user already has an authenticator they trust that isn't on
 * this list (KeePassXC's TOTP support, Bitwarden Authenticator,
 * Yubico Authenticator with a YubiKey storing the secret, OpenOTP,
 * andOTP — frozen but still works, etc.), they're welcome to use it.
 * The list below is "what we recommend to a new user who's asking";
 * it's not a denylist for anything else.
 */

export interface AuthenticatorApp {
	/** Display name shown to the user. */
	readonly name: string;
	/** One-sentence description for the picker.  Plain text, kept
	 *  short.  i18n keys are stitched in by the route component;
	 *  this fallback English is for code that reads the registry
	 *  directly (smokes, programmatic access). */
	readonly tagline: string;
	/** License — surface this so users can verify the open-source
	 *  claim themselves. */
	readonly license: string;
	/** Platforms this app supports.  Empty string for "all". */
	readonly platforms: ReadonlyArray<'iOS' | 'Android' | 'Linux' | 'macOS' | 'Windows' | 'Web'>;
	/** Official project URL.  No tracker params, no affiliate codes. */
	readonly officialUrl: string;
	/** F-Droid URL if available (some users only install from
	 *  F-Droid).  Empty string when not listed. */
	readonly fdroidUrl: string;
	/** Source-code repo URL — verifiable open-source. */
	readonly sourceUrl: string;
	/** Stable i18n key suffix for this app's row in the picker.
	 *  The full key is `auth.totp.recommended_apps.<key>.tagline`. */
	readonly i18nKey: string;
}

/** Canonical recommended-apps list.  NOTE: the 2FA picker now renders
 *  these sorted ALPHABETICALLY by name (see recommendedAppsSorted in the
 *  route); this array's own order is kept stable for programmatic/smoke
 *  use. Aegis is listed first here because it's the gold standard among
 *  privacy-conscious Android users; 2FAS second for iOS reach;
 *  Ente Auth third for cross-platform sync (the unique value
 *  proposition for users with multiple devices).
 *
 *  When adding a new app: ensure it satisfies all four policy
 *  points above, then add it to this array AND update i18n strings
 *  for every locale (see locale JSON files under `apps/web/src/lib/i18n/locales/`). */
export const RECOMMENDED_AUTHENTICATOR_APPS: ReadonlyArray<AuthenticatorApp> = [
	{
		name: 'Aegis Authenticator',
		tagline:
			'Encrypted local backups, biometric lock, no cloud sync. Android-only. The privacy-conscious default.',
		license: 'GPL-3.0',
		platforms: ['Android'],
		officialUrl: 'https://getaegis.app/',
		fdroidUrl: 'https://f-droid.org/packages/com.beemdevelopment.aegis/',
		sourceUrl: 'https://github.com/beemdevelopment/Aegis',
		i18nKey: 'aegis'
	},
	{
		name: '2FAS Authenticator',
		tagline:
			'iOS + Android. Optional encrypted iCloud / Google Drive backup is opt-in (not the default). Browser extension for desktop sync.',
		license: 'GPL-3.0',
		platforms: ['iOS', 'Android'],
		officialUrl: 'https://2fas.com/',
		fdroidUrl: 'https://f-droid.org/packages/com.twofasapp/',
		sourceUrl: 'https://github.com/twofas/2fas-android'
	,
		i18nKey: '2fas'
	},
	{
		name: 'Ente Auth',
		tagline:
			'End-to-end-encrypted cross-device sync (iOS + Android + Linux + Mac + Windows + Web). The pick if you want one authenticator across every device.',
		license: 'AGPL-3.0',
		platforms: ['iOS', 'Android', 'Linux', 'macOS', 'Windows', 'Web'],
		officialUrl: 'https://ente.io/auth/',
		fdroidUrl: 'https://f-droid.org/packages/io.ente.auth/',
		sourceUrl: 'https://github.com/ente-io/ente',
		i18nKey: 'ente'
	}
];

/** Apps we explicitly DO NOT recommend, with the reason.  Shown
 *  to the user in the enrollment UI under an "Apps to avoid"
 *  expandable section so the policy is transparent.  Reasons are
 *  factual statements with citations available on request. */
export const NOT_RECOMMENDED_AUTHENTICATOR_APPS: ReadonlyArray<{
	name: string;
	reason: string;
	i18nKey: string;
}> = [
	{
		name: 'Google Authenticator',
		reason:
			'Closed source. Cloud backup syncs secrets to Google by default (opt-out, not opt-in) and these secrets are not end-to-end encrypted to your account password.',
		i18nKey: 'google_authenticator'
	},
	{
		name: 'Microsoft Authenticator',
		reason: 'Closed source. Mandatory Microsoft-account telemetry.',
		i18nKey: 'microsoft_authenticator'
	},
	{
		name: 'Authy',
		reason:
			'Closed source. Cloud-only backups with a history of account-recovery exploits (SIM-swap vectors). Desktop app deprecated 2024.',
		i18nKey: 'authy'
	}
];
