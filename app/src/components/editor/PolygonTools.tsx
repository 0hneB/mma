import { useEffect, useRef, useState, useEffectEvent } from "react";
import { Icon, polygonOutline, rectangleOutline } from "@/components/primitives/Icon";
import { mdiPencil } from "@mdi/js";
import type { MapHost } from "@/lib/map/host";
import { addClickInterceptor } from "@/lib/map/mapState";
import { latLngToWorld } from "@/lib/geo/mercator";
import { densifyRing, unwrapLng } from "@/lib/geo/geo";
import { POLYGON_CLOSE_VERTEX_PX } from "@/lib/render/buildSceneLayers";

type DrawMode = "polygon" | "rectangle" | "freehand" | null;

function perpDist(p: number[], a: number[], b: number[]): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(pts: number[][], eps: number): number[][] {
	if (pts.length <= 2) return pts;
	let maxD = 0,
		maxI = 0;
	for (let i = 1; i < pts.length - 1; i++) {
		const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
		if (d > maxD) {
			maxD = d;
			maxI = i;
		}
	}
	if (maxD > eps) {
		const l = simplify(pts.slice(0, maxI + 1), eps);
		const r = simplify(pts.slice(maxI), eps);
		return [...l.slice(0, -1), ...r];
	}
	return [pts[0], pts[pts.length - 1]];
}

/** The two things every consumer of a drawn ring assumes: an explicit closing vertex,
 *  and no edge long enough for an `unwrapRing` pass to fold it the short way round. */
function finishRing(ring: number[][]): number[][] {
	if (ring.length === 0) return ring;
	const first = ring[0];
	const last = ring[ring.length - 1];
	const closed =
		first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
	return densifyRing(closed);
}

export function PolygonTools({
	host,
	onDraw,
	freehandPathRef,
	polygonVerticesRef,
	requestOverlayUpdate,
}: {
	host: MapHost | null;
	onDraw: (rings: number[][][]) => void;
	freehandPathRef: React.RefObject<number[][] | null>;
	polygonVerticesRef: React.RefObject<number[][] | null>;
	requestOverlayUpdate: () => void;
}) {
	const [mode, setMode] = useState<DrawMode>(null);
	const isDrawingRef = useRef(false);
	const emitDraw = useEffectEvent((rings: number[][][]) => onDraw(rings));
	const emitUpdate = useEffectEvent(() => requestOverlayUpdate());

	// Freehand via host events.
	useEffect(() => {
		if (!host || mode !== "freehand") return;

		host.setDraggable(false);
		const points: number[][] = [];

		const offDown = host.on("mousedown", (ll) => {
			isDrawingRef.current = true;
			points.length = 0;
			points.push([ll.lng, ll.lat]);
			freehandPathRef.current = points;
			emitUpdate();
		});

		const offMove = host.on("mousemove", (ll) => {
			if (!isDrawingRef.current) return;
			// Continue the stroke in the previous point's frame: the host reports longitude
			// normalized to [-180, 180], so crossing the seam would otherwise read as a jump
			// back across the whole map.
			points.push([unwrapLng(ll.lng, points[points.length - 1][0]), ll.lat]);
			emitUpdate();
		});

		const offUp = host.on("mouseup", () => {
			if (!isDrawingRef.current) return;
			isDrawingRef.current = false;
			freehandPathRef.current = null;
			emitUpdate();

			if (points.length < 3) return;

			const simplified = simplify(points, 0.0001);
			setMode(null);
			emitDraw([finishRing(simplified)]);
		});

		return () => {
			offDown();
			offMove();
			offUp();
			host.setDraggable(true);
			isDrawingRef.current = false;
			freehandPathRef.current = null;
		};
	}, [host, mode, freehandPathRef]);

	// Click-vertex polygon (click the first vertex or double-click to close, Escape cancels).
	useEffect(() => {
		if (!host || mode !== "polygon") return;

		const points: number[][] = [];
		let cursor: number[] | null = null;

		const preview = () => {
			freehandPathRef.current =
				points.length > 0 ? (cursor ? [...points, cursor] : [...points]) : null;
			polygonVerticesRef.current = points.length > 0 ? [...points] : null;
			emitUpdate();
		};
		const finish = (commit: boolean) => {
			const ring = [...points];
			points.length = 0;
			cursor = null;
			freehandPathRef.current = null;
			polygonVerticesRef.current = null;
			emitUpdate();
			setMode(null);
			if (commit && ring.length >= 3) emitDraw([finishRing(ring)]);
		};

		// Vertices land in the previous one's frame: with no path between two clicks, the
		// shortest edge is the only reading of what was drawn.
		const nextVertex = (lat: number, lng: number): number[] => {
			const prev = points[points.length - 1];
			return [prev ? unwrapLng(lng, prev[0]) : lng, lat];
		};

		const offClick = addClickInterceptor((lat, lng) => {
			const v = nextVertex(lat, lng);
			if (points.length >= 3) {
				const start = points[0];
				const scale = 2 ** host.getZoom();
				const a = latLngToWorld({ lat, lng: unwrapLng(lng, start[0]) });
				const b = latLngToWorld({ lat: start[1], lng: start[0] });
				if (Math.hypot((a.x - b.x) * scale, (a.y - b.y) * scale) <= POLYGON_CLOSE_VERTEX_PX) {
					finish(true);
					return true;
				}
			}
			const prev = points[points.length - 1];
			if (!prev || prev[0] !== v[0] || prev[1] !== v[1]) points.push(v);
			preview();
			return true;
		});
		const offMove = host.on("mousemove", (ll) => {
			cursor = nextVertex(ll.lat, ll.lng);
			if (points.length > 0) preview();
		});
		const onDblClick = (e: MouseEvent) => {
			e.preventDefault();
			finish(true);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") finish(false);
		};
		host.setDoubleClickZoom(false);
		host.container.addEventListener("dblclick", onDblClick, true);
		document.addEventListener("keydown", onKey, true);

		return () => {
			offClick();
			offMove();
			host.container.removeEventListener("dblclick", onDblClick, true);
			document.removeEventListener("keydown", onKey, true);
			host.setDoubleClickZoom(true);
			freehandPathRef.current = null;
			polygonVerticesRef.current = null;
			emitUpdate();
		};
	}, [host, mode, freehandPathRef, polygonVerticesRef]);

	// Drag rectangle.
	useEffect(() => {
		if (!host || mode !== "rectangle") return;

		host.setDraggable(false);
		let anchor: number[] | null = null;
		// The box is two corners, but how wide it is, and which way round the globe,
		// only exists in the drag between them. Accumulated here across mousemove, which
		// fires far more often than every 180°, so each step reads unambiguously.
		let cursorLng = 0;

		const rectRing = (a: number[], b: number[]) =>
			finishRing([
				[a[0], a[1]],
				[b[0], a[1]],
				[b[0], b[1]],
				[a[0], b[1]],
			]);

		const offDown = host.on("mousedown", (ll) => {
			anchor = [ll.lng, ll.lat];
			cursorLng = ll.lng;
		});
		const offMove = host.on("mousemove", (ll) => {
			if (!anchor) return;
			cursorLng = unwrapLng(ll.lng, cursorLng);
			freehandPathRef.current = rectRing(anchor, [cursorLng, ll.lat]);
			emitUpdate();
		});
		const offUp = host.on("mouseup", (ll) => {
			if (!anchor) return;
			cursorLng = unwrapLng(ll.lng, cursorLng);
			const ring = rectRing(anchor, [cursorLng, ll.lat]);
			const degenerate = cursorLng === anchor[0] || ll.lat === anchor[1];
			anchor = null;
			freehandPathRef.current = null;
			emitUpdate();
			setMode(null);
			if (!degenerate) emitDraw([ring]);
		});
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				anchor = null;
				freehandPathRef.current = null;
				emitUpdate();
				setMode(null);
			}
		};
		document.addEventListener("keydown", onKey, true);

		return () => {
			offDown();
			offMove();
			offUp();
			document.removeEventListener("keydown", onKey, true);
			host.setDraggable(true);
			freehandPathRef.current = null;
		};
	}, [host, mode, freehandPathRef]);

	return (
		<div className="map-control map-control--button white">
			<button
				type="button"
				onClick={() => setMode((m) => (m === "polygon" ? null : "polygon"))}
				className={mode === "polygon" ? "is-active" : undefined}
				aria-label="Draw a polygon selection"
			>
				<Icon path={polygonOutline} />
			</button>
			<button
				type="button"
				onClick={() => setMode((m) => (m === "rectangle" ? null : "rectangle"))}
				className={mode === "rectangle" ? "is-active" : undefined}
				aria-label="Draw a rectangle selection"
			>
				<Icon path={rectangleOutline} />
			</button>
			<button
				type="button"
				onClick={() => setMode((m) => (m === "freehand" ? null : "freehand"))}
				className={mode === "freehand" ? "is-active" : undefined}
				aria-label="Freehand polygon selection"
			>
				<Icon path={mdiPencil} />
			</button>
		</div>
	);
}
