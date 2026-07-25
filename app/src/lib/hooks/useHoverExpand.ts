import { useEffect, useRef, useState, type RefObject } from "react";
import { useDomEvent } from "./useDomEvent";

/**
 * Hover-to-expand panel state. Dragging inside the panel captures the pointer, so leaving
 * it mid-drag never fires pointerleave and the panel stays open under a pointer that has
 * long since moved away; the release decides instead.
 */
export function useHoverExpand(ref: RefObject<HTMLElement | null>, closeDelay: number) {
	const [expanded, setExpanded] = useState(false);
	const closeTimer = useRef<number | null>(null);

	const open = () => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		setExpanded(true);
	};

	const scheduleClose = () => {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = window.setTimeout(() => {
			setExpanded(false);
			closeTimer.current = null;
		}, closeDelay);
	};

	useDomEvent("pointerup", (e) => {
		const el = ref.current;
		if (!expanded || !el) return;
		const { clientX, clientY } = e as PointerEvent;
		const r = el.getBoundingClientRect();
		const inside = clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
		if (!inside) scheduleClose();
	});

	useEffect(() => {
		return () => {
			if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		};
	}, []);

	return { expanded, hoverProps: { onPointerEnter: open, onPointerLeave: scheduleClose } };
}
