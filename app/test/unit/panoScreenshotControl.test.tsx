// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	capture: vi.fn(),
	fileName: vi.fn(),
	download: vi.fn(),
	toast: vi.fn(),
	settings: {
		showScreenshotButton: true,
		showFullscreenButton: false,
		showJumpButtons: false,
		showCompass: false,
		showCompassTape: false,
		showZoom: false,
		showReturnToSpawn: false,
		showMapLinks: false,
		showCoordinateDisplay: false,
		showPanoMetadata: false,
		defaultMovementMode: "moving",
	},
}));

vi.mock("@/lib/sv/panoScreenshot", () => ({
	capturePanoScreenshot: mocks.capture,
	panoScreenshotFileName: mocks.fileName,
}));
vi.mock("@/lib/util/util", () => ({ downloadBlob: mocks.download, schemeBase: () => "" }));
vi.mock("@/lib/util/toast", () => ({ toast: mocks.toast }));
vi.mock("@/lib/util/log", () => ({ log: { warn: vi.fn() } }));
vi.mock("@/store/settings", () => ({ useSettings: () => mocks.settings }));
vi.mock("@/lib/util/hotkeys", () => ({ useBinding: () => "f" }));
vi.mock("@/lib/hooks/useHotkey", () => ({ useHotkeyRef: () => ({ current: null }) }));
vi.mock("@/lib/hooks/usePanoEvent", () => ({ usePanoEvent: vi.fn() }));
vi.mock("@/lib/sv/opensv", () => ({ google: { maps: {} } }));
vi.mock("@/components/primitives/Tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import { PanoControls } from "@/components/editor/location/PanoControls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const panorama = {} as google.maps.StreetViewPanorama;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderControls() {
	act(() =>
		root.render(
			<PanoControls
				panorama={panorama}
				geo={{ address: "Berlin, Berlin", countryCode: "DE" }}
				isFullscreen={false}
				onFullscreen={vi.fn()}
				onReturnToSpawn={vi.fn()}
			/>,
		),
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.capture.mockReset();
	mocks.fileName.mockReset().mockReturnValue("Berlin-DE_2026-08-01_21-31-04.png");
	mocks.download.mockReset();
	mocks.toast.mockReset();
	mocks.settings.showScreenshotButton = true;
	mocks.settings.showFullscreenButton = false;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("PanoControls screenshot button", () => {
	it("has an independent visibility setting", () => {
		renderControls();
		const screenshot = container.querySelector("[data-qa='pano-screenshot']")!;
		expect(screenshot).not.toBeNull();
		expect(screenshot.closest(".map-control")?.querySelectorAll("button")).toHaveLength(1);

		mocks.settings.showScreenshotButton = false;
		renderControls();
		expect(container.querySelector("[data-qa='pano-screenshot']")).toBeNull();
	});

	it("disables during capture and downloads the completed PNG once", async () => {
		let finish!: (result: { blob: Blob; panoId: string }) => void;
		mocks.capture.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		renderControls();
		const button = container.querySelector<HTMLButtonElement>("[data-qa='pano-screenshot']")!;

		act(() => button.click());
		expect(button.disabled).toBe(true);
		expect(mocks.capture).toHaveBeenCalledOnce();

		const blob = new Blob(["png"], { type: "image/png" });
		await act(async () => finish({ blob, panoId: "pano-id" }));
		expect(mocks.download).toHaveBeenCalledWith(blob, "Berlin-DE_2026-08-01_21-31-04.png");
		expect(mocks.download).toHaveBeenCalledOnce();

		act(() => vi.advanceTimersByTime(500));
		expect(button.disabled).toBe(false);
	});
});
