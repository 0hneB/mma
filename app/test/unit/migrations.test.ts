import { describe, it, expect } from "vitest";
import {
	MIGRATIONS,
	SUPPORTED_FROM,
	compareVersions,
	migrationsFor,
} from "@/store/migrations";

describe("compareVersions", () => {
	it("orders by numeric component", () => {
		expect(compareVersions("0.9.2", "0.10.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
		expect(compareVersions("0.9", "0.9.0")).toBe(0);
	});
});

describe("migration registry", () => {
	// Bumping SUPPORTED_FROM is how migrations get pruned: this names whatever aged out.
	it("holds no migration older than SUPPORTED_FROM", () => {
		const stale = MIGRATIONS.filter((m) => compareVersions(m.since, SUPPORTED_FROM) < 0);
		expect(stale.map((m) => `${m.since} ${m.key}: ${m.describe}`)).toEqual([]);
	});

	it("is ordered oldest first", () => {
		const versions = MIGRATIONS.map((m) => m.since);
		expect([...versions].sort(compareVersions)).toEqual(versions);
	});

	it("describes every entry", () => {
		for (const m of MIGRATIONS) {
			expect(m.describe.length, `${m.since} ${m.key}`).toBeGreaterThan(0);
			expect(m.key.length, `${m.since}`).toBeGreaterThan(0);
		}
	});

	it("selects by store key", () => {
		expect(migrationsFor("appSettings").length).toBe(
			MIGRATIONS.filter((m) => m.key === "appSettings").length,
		);
		expect(migrationsFor("no-such-blob")).toEqual([]);
	});
});
