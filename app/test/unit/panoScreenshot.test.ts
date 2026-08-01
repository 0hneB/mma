// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	screenshotFrameFingerprint,
	screenshotHostSize,
	snapshotPanoScreenshotView,
} from "@/lib/sv/panoScreenshot";
import { getSettings } from "@/store/settings";

describe("pano screenshot", () => {
	it.each([
		[1, 1920, 1080],
		[1.25, 1536, 864],
		[1.5, 1280, 720],
		[2, 960, 540],
	])("requests a 1920x1080 backing buffer at DPR %s", (dpr, width, height) => {
		expect(screenshotHostSize(dpr)).toEqual({ width, height });
	});

	it("keeps a 16:9 host at fractional DPR and can request a larger fallback", () => {
		const exact = screenshotHostSize(1.75);
		const larger = screenshotHostSize(1.75, 1.01);
		expect(exact.width / exact.height).toBeCloseTo(16 / 9);
		expect(larger.width).toBeGreaterThan(exact.width);
		expect(larger.height).toBeGreaterThan(exact.height);
	});

	it("copies click-time camera state instead of retaining the live POV object", () => {
		const pov = { heading: 123.5, pitch: -7.25 };
		const panorama = {
			getPano: () => "pano-id",
			getPov: () => pov,
			getZoom: () => 2.5,
		} as unknown as google.maps.StreetViewPanorama;

		const snapshot = snapshotPanoScreenshotView(panorama);
		pov.heading = 250;

		expect(snapshot).toEqual({
			panoId: "pano-id",
			pov: { heading: 123.5, pitch: -7.25 },
			zoom: 2.5,
		});
	});

	it("rejects a viewer without a ready pano or finite camera", () => {
		const panorama = {
			getPano: () => "",
			getPov: () => ({ heading: 0, pitch: 0 }),
			getZoom: () => Number.NaN,
		} as unknown as google.maps.StreetViewPanorama;
		expect(() => snapshotPanoScreenshotView(panorama)).toThrow("Street View is not ready");
	});

	it("shows the screenshot button by default", () => {
		expect(getSettings().showScreenshotButton).toBe(true);
	});

	it("distinguishes blank frames from stable rendered imagery", () => {
		const blank = new Uint8ClampedArray(16);
		const rendered = new Uint8ClampedArray([
			10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
		]);
		expect(screenshotFrameFingerprint(blank)).toBeNull();
		expect(screenshotFrameFingerprint(rendered)).toBe(screenshotFrameFingerprint(rendered.slice()));
	});
});
