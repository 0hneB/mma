// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/sv/opensv", () => {
	class Size {
		constructor(
			public w: number,
			public h: number,
		) {}
	}
	class ImageMapType {
		opacity = 1;
		constructor(public opts: unknown) {}
		setOpacity(o: number) {
			this.opacity = o;
		}
	}
	class MapMock {
		stack: { layers: { opacity: number }[] } | null = null;
		mapTypes = {
			set: (_id: string, stack: { layers: { opacity: number }[] }) => {
				this.stack = stack;
			},
		};
		private div = document.createElement("div");
		constructor(
			public container: HTMLElement,
			public opts: unknown,
		) {}
		setOptions() {}
		setMapTypeId() {}
		getDiv() {
			return this.div;
		}
		addListener() {
			return {};
		}
	}
	return {
		google: {
			maps: {
				Size,
				ImageMapType,
				Map: MapMock,
				event: { trigger: () => {}, clearInstanceListeners: () => {} },
			},
		},
	};
});

vi.mock("@/lib/geo/stackedMapType", () => ({
	createCompositeMapType: (layers: unknown[]) => ({ layers }),
}));

import { createGoogleMapHost } from "@/lib/map/googleHost";
import { DEFAULT_PREFS } from "@/store/mapEmbedPrefs";

type Host = ReturnType<typeof createGoogleMapHost>;

const makeHost = (): Host =>
	createGoogleMapHost(document.createElement("div"), DEFAULT_PREFS, {
		useBlobby: false,
		customStyles: [],
	});

// The roadmap stack is [basemap, SV coverage, labels].
const svOpacity = (host: Host) =>
	(host.getHostInstance() as unknown as { stack: { layers: { opacity: number }[] } }).stack
		.layers[1].opacity;

describe("GoogleMapHost.applyPrefs", () => {
	it("installs a stack carrying the passed svOpacity", () => {
		const host = makeHost();
		expect(svOpacity(host)).toBeCloseTo(DEFAULT_PREFS.svOpacity);
		host.applyPrefs({ ...DEFAULT_PREFS, svOpacity: 0.9 }, { useBlobby: false, customStyles: [] });
		expect(svOpacity(host)).toBeCloseTo(0.9);
	});

	// The minimap toggles blue lines through applyPrefs alone: no other opacity path exists.
	it("hides the SV layer at zero opacity, and brings it back", () => {
		const host = makeHost();
		host.applyPrefs({ ...DEFAULT_PREFS, svOpacity: 0 }, { useBlobby: false, customStyles: [] });
		expect(svOpacity(host)).toBe(0);
		host.applyPrefs({ ...DEFAULT_PREFS, svOpacity: 0.5 }, { useBlobby: false, customStyles: [] });
		expect(svOpacity(host)).toBeCloseTo(0.5);
	});

	it("dims single-coverage blobby tiles", () => {
		const host = makeHost();
		host.applyPrefs(
			{ ...DEFAULT_PREFS, svCoverageType: "official", svOpacity: 0.5 },
			{ useBlobby: true, customStyles: [] },
		);
		expect(svOpacity(host)).toBeCloseTo(0.3);
	});
});
