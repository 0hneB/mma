import { google } from "@/lib/sv/opensv";

const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const CAPTURE_TIMEOUT_MS = 15_000;
const CANVAS_SETTLE_TIMEOUT_MS = 3_000;
const CANVAS_QUIET_MS = 400;
const CANVAS_SAMPLE_INTERVAL_MS = 100;

export interface PanoScreenshotView {
	panoId: string;
	pov: { heading: number; pitch: number };
	zoom: number;
}

export interface PanoScreenshotResult {
	blob: Blob;
	panoId: string;
}

export function panoScreenshotFileName(
	address: string,
	countryCode: string | null,
	panoId: string,
	capturedAt = new Date(),
): string {
	const place = address.split(",", 1)[0]?.trim();
	const label = [place, countryCode?.toUpperCase()].filter(Boolean).join("-") || panoId;
	const safeLabel = label.replace(/[<>:"/\\|?*\s]+/g, "-").replace(/^-+|-+$/g, "");
	const localTime = new Date(capturedAt.getTime() - capturedAt.getTimezoneOffset() * 60_000);
	const stamp = localTime.toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "-");
	return `${safeLabel || "street-view"}_${stamp}.png`;
}

interface CaptureViewer {
	container: HTMLDivElement;
	host: HTMLDivElement;
	panorama: google.maps.StreetViewPanorama;
}

let captureViewer: CaptureViewer | null = null;

/** CSS dimensions that ask OpenSV for the requested backing-buffer size at a given DPR. */
export function screenshotHostSize(dpr: number, scale = 1): { width: number; height: number } {
	const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
	return {
		width: (OUTPUT_WIDTH * safeScale) / safeDpr,
		height: (OUTPUT_HEIGHT * safeScale) / safeDpr,
	};
}

/** Freeze the live viewer state before screenshot rendering starts. */
export function snapshotPanoScreenshotView(
	panorama: google.maps.StreetViewPanorama,
): PanoScreenshotView {
	const panoId = panorama.getPano();
	const pov = panorama.getPov();
	const zoom = panorama.getZoom();
	if (
		!panoId ||
		!pov ||
		!Number.isFinite(pov.heading) ||
		!Number.isFinite(pov.pitch) ||
		!Number.isFinite(zoom)
	) {
		throw new Error("Street View is not ready");
	}
	return {
		panoId,
		pov: { heading: pov.heading, pitch: pov.pitch },
		zoom,
	};
}

function setHostSize(host: HTMLDivElement, dpr: number, scale: number) {
	const size = screenshotHostSize(dpr, scale);
	host.style.width = `${size.width}px`;
	host.style.height = `${size.height}px`;
}

function createCaptureViewer(): CaptureViewer {
	if (!google?.maps) throw new Error("OpenSV is not loaded");

	const container = document.createElement("div");
	container.dataset.mmaPanoScreenshotRenderer = "";
	container.setAttribute("aria-hidden", "true");
	Object.assign(container.style, {
		position: "fixed",
		top: "0",
		left: "0",
		width: "1px",
		height: "1px",
		pointerEvents: "none",
		overflow: "hidden",
		zIndex: "-1",
	});

	const host = document.createElement("div");
	Object.assign(host.style, {
		position: "absolute",
		top: "0",
		left: "0",
	});
	setHostSize(host, window.devicePixelRatio, 1);
	container.appendChild(host);
	document.body.appendChild(container);

	try {
		const panorama = new google.maps.StreetViewPanorama(host, {
			disableDefaultUI: true,
			linksControl: false,
			clickToGo: false,
			showRoadLabels: false,
			scrollwheel: false,
			motionTracking: false,
			visible: false,
		});
		return { container, host, panorama };
	} catch (error) {
		container.remove();
		throw error;
	}
}

function getCaptureViewer(): CaptureViewer {
	return (captureViewer ??= createCaptureViewer());
}

function discardCaptureViewer(viewer: CaptureViewer) {
	try {
		viewer.panorama.setVisible(false);
	} catch {
		// ignored
	}
	viewer.container.remove();
	if (captureViewer === viewer) captureViewer = null;
}

function waitForPanoReady(
	panorama: google.maps.StreetViewPanorama,
	panoId: string,
	deadline: number,
): Promise<void> {
	const timeout = deadline - Date.now();
	if (timeout <= 0) {
		return Promise.reject(new Error("Street View screenshot timed out waiting for status_changed"));
	}

	return new Promise((resolve, reject) => {
		const finish = () => {
			if (panorama.getPano() !== panoId || panorama.getStatus() !== "OK") return;
			window.clearTimeout(timer);
			listener.remove();
			resolve();
		};
		const listener = panorama.addListener("status_changed", finish);
		const timer = window.setTimeout(() => {
			listener.remove();
			reject(new Error("Street View screenshot timed out waiting for status_changed"));
		}, timeout);
		finish();
	});
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function screenshotFrameFingerprint(pixels: Uint8ClampedArray): number | null {
	let hash = 2166136261;
	let min = 255;
	let max = 0;
	let visible = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		const r = pixels[i];
		const g = pixels[i + 1];
		const b = pixels[i + 2];
		if (pixels[i + 3] > 0) visible++;
		min = Math.min(min, r, g, b);
		max = Math.max(max, r, g, b);
		hash = Math.imul(hash ^ r, 16777619);
		hash = Math.imul(hash ^ g, 16777619);
		hash = Math.imul(hash ^ b, 16777619);
	}
	return visible > pixels.length / 8 && max - min > 4 ? hash >>> 0 : null;
}

function frameFingerprint(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): number | null {
	ctx.drawImage(canvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
	return screenshotFrameFingerprint(
		ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data,
	);
}

async function waitForStableCanvas(
	host: HTMLElement,
	deadline: number,
): Promise<HTMLCanvasElement> {
	const sample = document.createElement("canvas");
	sample.width = 64;
	sample.height = 36;
	const ctx = sample.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Could not inspect the OpenSV canvas");

	const settleDeadline = Math.min(deadline, Date.now() + CANVAS_SETTLE_TIMEOUT_MS);
	let latest: HTMLCanvasElement | null = null;
	let previous: number | null = null;
	let unchangedSince = 0;
	while (Date.now() < settleDeadline) {
		await nextFrame();
		let canvas: HTMLCanvasElement;
		try {
			canvas = sceneCanvas(host);
		} catch {
			await delay(CANVAS_SAMPLE_INTERVAL_MS);
			continue;
		}

		const fingerprint = frameFingerprint(canvas, ctx);
		if (fingerprint !== null) {
			latest = canvas;
			const now = Date.now();
			if (fingerprint !== previous) {
				previous = fingerprint;
				unchangedSince = now;
			} else if (now - unchangedSince >= CANVAS_QUIET_MS) {
				return canvas;
			}
		}
		await delay(CANVAS_SAMPLE_INTERVAL_MS);
	}

	if (latest) return latest;
	throw new Error("OpenSV did not render screenshot imagery");
}

async function settleCaptureViewer(
	viewer: CaptureViewer,
	view: PanoScreenshotView,
	deadline: number,
): Promise<HTMLCanvasElement> {
	viewer.panorama.setPov({ ...view.pov });
	viewer.panorama.setZoom(view.zoom);
	google.maps.event.trigger(viewer.panorama, "resize");
	return waitForStableCanvas(viewer.host, deadline);
}

function sceneCanvas(host: HTMLElement): HTMLCanvasElement {
	const canvas = host.querySelector<HTMLCanvasElement>("canvas.widget-scene-canvas");
	if (!canvas || canvas.width === 0 || canvas.height === 0) {
		throw new Error("OpenSV did not create a screenshot canvas");
	}
	return canvas;
}

function headingDelta(a: number, b: number): number {
	return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

function hasExpectedView(
	panorama: google.maps.StreetViewPanorama,
	view: PanoScreenshotView,
): boolean {
	const pov = panorama.getPov();
	return (
		panorama.getPano() === view.panoId &&
		headingDelta(pov.heading, view.pov.heading) < 0.01 &&
		Math.abs(pov.pitch - view.pov.pitch) < 0.01 &&
		Math.abs(panorama.getZoom() - view.zoom) < 0.001
	);
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		try {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error("PNG encoding failed"));
			}, "image/png");
		} catch (error) {
			reject(error);
		}
	});
}

async function encodeScreenshot(source: HTMLCanvasElement): Promise<Blob> {
	if (source.width < OUTPUT_WIDTH || source.height < OUTPUT_HEIGHT) {
		throw new Error(`OpenSV canvas is only ${source.width}x${source.height}`);
	}
	if (source.width === OUTPUT_WIDTH && source.height === OUTPUT_HEIGHT) {
		return canvasToPng(source);
	}

	const output = document.createElement("canvas");
	output.width = OUTPUT_WIDTH;
	output.height = OUTPUT_HEIGHT;
	const ctx = output.getContext("2d");
	if (!ctx) throw new Error("Could not create screenshot canvas");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
	return canvasToPng(output);
}

/** Capture one imagery-only 1920x1080 PNG. */
export async function capturePanoScreenshot(
	source: google.maps.StreetViewPanorama,
): Promise<PanoScreenshotResult> {
	const view = snapshotPanoScreenshotView(source);
	const viewer = getCaptureViewer();
	const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
	const dpr =
		Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
			? window.devicePixelRatio
			: 1;

	try {
		setHostSize(viewer.host, dpr, 1);
		const ready = waitForPanoReady(viewer.panorama, view.panoId, deadline);
		viewer.panorama.setVisible(true);
		viewer.panorama.setPano(view.panoId);
		viewer.panorama.setPov({ ...view.pov });
		viewer.panorama.setZoom(view.zoom);
		google.maps.event.trigger(viewer.panorama, "resize");
		await ready;

		let canvas = await waitForStableCanvas(viewer.host, deadline);
		if (canvas.width < OUTPUT_WIDTH || canvas.height < OUTPUT_HEIGHT) {
			const increase = Math.max(OUTPUT_WIDTH / canvas.width, OUTPUT_HEIGHT / canvas.height);
			setHostSize(viewer.host, dpr, increase * 1.01);
			canvas = await settleCaptureViewer(viewer, view, deadline);
		}

		if (canvas.width < OUTPUT_WIDTH || canvas.height < OUTPUT_HEIGHT) {
			throw new Error("WebGL could not provide a 1920x1080 drawing buffer");
		}
		if (!hasExpectedView(viewer.panorama, view)) {
			canvas = await settleCaptureViewer(viewer, view, deadline);
			if (!hasExpectedView(viewer.panorama, view)) {
				throw new Error("OpenSV did not preserve the requested camera");
			}
		}

		return { blob: await encodeScreenshot(canvas), panoId: view.panoId };
	} catch (error) {
		discardCaptureViewer(viewer);
		throw error;
	} finally {
		try {
			viewer.panorama.setVisible(false);
		} catch {
			// ignored
		}
	}
}
