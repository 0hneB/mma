import { forwardRef } from "react";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import {
	useIsMeasuring,
	startMeasure,
	endMeasure,
	getLatLngAnchor,
	setLatLngAnchor,
} from "@/lib/sv/measure";
import { useEventValue } from "@/lib/events";
import { getContextMenuTarget } from "@/lib/map/contextMenu";

export const MapContextMenuContent = forwardRef<HTMLDivElement>((_props, ref) => {
	const isMeasuring = useIsMeasuring();
	const anchor = useEventValue("anchor:changed", getLatLngAnchor);

	return (
		<ContextMenu.Positioner>
			<ContextMenu.Popup className="context-menu" ref={ref}>
				{isMeasuring ? (
					<ContextMenu.Item className="context-menu__item" onClick={endMeasure}>
						End measurement
					</ContextMenu.Item>
				) : (
					<ContextMenu.Item
						className="context-menu__item"
						onClick={() => startMeasure(getContextMenuTarget().latLng)}
					>
						Start measurement
					</ContextMenu.Item>
				)}
				<ContextMenu.Item
					className="context-menu__item"
					onClick={() => {
						const { lat, lng } = getContextMenuTarget().latLng;
						navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
					}}
				>
					Copy coordinates
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					onClick={() => setLatLngAnchor(getContextMenuTarget().latLng)}
				>
					Set latitude/longitude anchors
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					disabled={!anchor}
					onClick={() => setLatLngAnchor(null)}
				>
					Clear latitude/longitude anchors
				</ContextMenu.Item>
			</ContextMenu.Popup>
		</ContextMenu.Positioner>
	);
});
