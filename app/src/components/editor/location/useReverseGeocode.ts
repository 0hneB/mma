import { cmd } from "@/lib/commands";
import { getSettings } from "@/store/settings";
import { log } from "@/lib/util/log";
import { useAsync } from "@/lib/hooks/useAsync";

export interface GeoDisplay {
	address: string;
	countryCode: string | null;
	place?: string;
	region?: string;
}

async function geocodeLocal(lat: number, lng: number): Promise<GeoDisplay | null> {
	const result = await cmd.reverseGeocode(lat, lng);
	if (!result) return null;
	const parts = [result.city, result.admin].filter(Boolean);
	return {
		address: parts.join(", "),
		countryCode: result.country_code?.toUpperCase() ?? null,
		place: result.city || undefined,
		region: result.admin || undefined,
	};
}

async function geocodeNominatim(lat: number, lng: number): Promise<GeoDisplay | null> {
	const apiKey = getSettings().nominatimApiKey;
	const url = new URL("https://nominatim.openstreetmap.org/reverse");
	url.searchParams.set("lat", String(lat));
	url.searchParams.set("lon", String(lng));
	url.searchParams.set("format", "json");
	url.searchParams.set("zoom", "14");
	if (apiKey) url.searchParams.set("key", apiKey);
	const res = await fetch(url.toString(), { headers: { "Accept-Language": "en" } });
	if (!res.ok) return null;
	const data = await res.json();
	if (!data?.address) return null;
	const a = data.address;
	const place = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb;
	const region = a.state || a.county;
	const parts = [...new Set([a.road, a.suburb, place, region].filter(Boolean))];
	return {
		address: parts.join(", "),
		countryCode: (a.country_code as string)?.toUpperCase() ?? null,
		place,
		region,
	};
}

export function useReverseGeocode(
	lat: number,
	lng: number,
	panoGeo?: GeoDisplay | null,
): GeoDisplay | null {
	const provider = getSettings().geocodeProvider;
	const key = `${provider}:${lat}:${lng}`;

	const asyncResult = useAsync(async () => {
		if (provider === "google") return null;
		const fn = provider === "nominatim" ? geocodeNominatim : geocodeLocal;
		try {
			return { key, geo: await fn(lat, lng) };
		} catch (e) {
			log.warn("[geocode] reverse geocode failed:", e);
			return { key, geo: null };
		}
	}, [lat, lng, provider]).data;

	if (provider === "google") return panoGeo ?? null;
	return asyncResult?.key === key ? asyncResult.geo : null;
}
