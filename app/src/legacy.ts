// Legacy API shims for plugins

import { getMapHost, waitForMapHost } from "@/lib/map/mapState";
import { hostInstance } from "@/lib/map/host";

export function getGoogleMap(): google.maps.Map | null {
	return hostInstance(getMapHost(), "google");
}

export function waitForGoogleMap(): Promise<google.maps.Map | null> {
	return waitForMapHost().then((host) => hostInstance(host, "google"));
}
