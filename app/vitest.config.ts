import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
			"measuretool-googlemaps-v3": path.resolve(
				__dirname,
				"node_modules/measuretool-googlemaps-v3/dist/gmaps-measuretool.esm.js",
			),
		},
	},
	test: {
		globals: true,
		exclude: ["test/e2e/**", "test/integration/**", "node_modules/**"],
		// Pinned to a positive half-hour offset: local-vs-UTC frame bugs are invisible when
		// tests run in UTC, and a whole-hour zone hides sub-hour arithmetic.
		env: { TZ: "Asia/Kolkata" },
	},
});
