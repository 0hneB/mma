// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { normalizeRing } from "@/lib/render/buildSceneLayers";

describe("normalizeRing (antimeridian)", () => {
	it("returns the ring unchanged (same reference) when it doesn't cross", () => {
		const ring = [
			[10, 0],
			[20, 0],
			[20, 10],
		];
		expect(normalizeRing(ring)).toBe(ring);
	});

	it("wraps negative longitudes by +360 when adjacent points jump >180°", () => {
		const ring = [
			[170, 0],
			[-170, 0],
			[-175, 10],
		];
		expect(normalizeRing(ring)).toEqual([
			[170, 0],
			[190, 0],
			[185, 10],
		]);
	});

	it("wraps when a point is outside [-180, 180]", () => {
		const ring = [
			[200, 0],
			[-10, 0],
		];
		expect(normalizeRing(ring)).toEqual([
			[200, 0],
			[350, 0],
		]);
	});
});
