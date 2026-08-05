import { isOfficialPano } from "@/lib/sv/panoId";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { PanoType } from "@/types";
import { useAsync } from "@/lib/hooks/useAsync";
import type { CameraType } from "@/bindings.gen";

/** Camera type plus "unofficial", a display-only state that is never stored. */
export type FullCameraType = CameraType | "unofficial";

export function useCameraType(panoId: string | null): FullCameraType | null {
	return useAsync<FullCameraType | null>(() => {
		if (!panoId) return null;
		// Immediate check: a non-official pano ID is unofficial regardless of metadata.
		if (!isOfficialPano(panoId)) return "unofficial";
		return fetchSvMetadata([panoId]).then(([data]) => {
			if (!data || !data.extra) return null;
			if (data.extra.panoType !== PanoType.Official) return "unofficial";
			return data.extra.cameraType;
		});
	}, [panoId]).data;
}
