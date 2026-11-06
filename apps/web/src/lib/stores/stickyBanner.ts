/**
 * The bottom edge (px from the top of the window) of the notification
 * permission banner while it sticks under the main menu, 0 when it is not
 * shown (v1.23.1). PermissionBanner.svelte writes it; a sticky element further
 * down, like the /witnesses table's heading row, sticks below it instead of
 * under it.
 */
import { writable } from 'svelte/store';

export const stickyBannerBottom = writable(0);
