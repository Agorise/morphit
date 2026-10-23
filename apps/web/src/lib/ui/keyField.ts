/**
 * For a password-type field that takes a KEY (an Active-key WIF, a secret),
 * not the Morphit password. Put `readonly` on the field in the markup AND
 * `use:keyField`: the field starts read-only and becomes writable the moment
 * the person touches it (or its label) or focuses it.
 *
 * Why: browsers fill a saved site password into the first password field they
 * see as it appears, and Firefox does so even with autocomplete="off". In the
 * "unlock with your Active key" box that wrote the Morphit password where the
 * WIF goes (v1.21.14). Firefox skips a read-only password field.
 *
 * It unlocks on pointerdown — on the field or on one of its labels — which
 * comes before the focus moves, so the field is already writable when it gets
 * the focus; keyboard focus unlocks it too. Every new copy of the field (an
 * {#if} that shows it again) starts locked.
 */
export function keyField(node: HTMLInputElement): { destroy: () => void } {
	node.readOnly = true;
	const unlock = (): void => {
		node.readOnly = false;
	};
	const labels = [...(node.labels ?? [])];
	node.addEventListener('pointerdown', unlock);
	node.addEventListener('focus', unlock);
	for (const label of labels) label.addEventListener('pointerdown', unlock);
	return {
		destroy() {
			node.removeEventListener('pointerdown', unlock);
			node.removeEventListener('focus', unlock);
			for (const label of labels) label.removeEventListener('pointerdown', unlock);
		}
	};
}
