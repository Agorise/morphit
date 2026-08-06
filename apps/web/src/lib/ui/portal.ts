/**
 * Morphit — `use:portal`: move a node to `<body>` for the life of the component.
 *
 * Why this exists (tt.txt #1): the avatar menu's full-page scrim was
 * `fixed inset-0`, which everyone — including the comment above it — assumed
 * covered the viewport. It didn't. The sticky header carries `backdrop-blur-md`,
 * and **an ancestor with `backdrop-filter` (or `filter`, `transform`,
 * `perspective`, `contain`, `will-change`) becomes the containing block for its
 * `position: fixed` descendants.** So the scrim was clipped to the header bar,
 * and clicking the avatar blurred only the header — exactly what Ken saw.
 *
 * `FaqSearch`'s identical scrim works because it lives in page content, with no
 * filtered ancestor. That's the whole difference, and it's invisible in review.
 *
 * Portaling to `<body>` escapes any such containing block. Note the consequence
 * for stacking: a portaled node is a child of `<body>`, so it no longer sits
 * inside the header's stacking context — pick a `z-index` accordingly.
 */
export function portal(node: HTMLElement): { destroy(): void } {
	if (typeof document === 'undefined') return { destroy() {} };
	document.body.appendChild(node);
	return {
		destroy(): void {
			if (node.parentNode) node.parentNode.removeChild(node);
		}
	};
}
