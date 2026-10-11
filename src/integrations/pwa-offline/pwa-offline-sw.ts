/// <reference lib="webworker" />
import { offlineFilename, publicAssets, pwaConfig } from "./config";
import {
	cacheableResponse,
	cachePrefix,
	eligibleNavigation,
	type PublicAsset,
} from "./policy";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PublicAsset[] };
declare const __PWA_OFFLINE_VERSION__: string;
const manifest = self.__WB_MANIFEST;
const scope = new URL(self.registration.scope);
const prefix = cachePrefix(scope.href);
const cacheName = `${prefix}${__PWA_OFFLINE_VERSION__}`;
const assetURL = (url: string) => new URL(url, scope).href;
const expected = new Map(manifest.map((entry) => [assetURL(entry.url), entry]));
if (
	scope.pathname !== pwaConfig.base ||
	manifest.length !== publicAssets.length ||
	expected.size !== publicAssets.length ||
	manifest.some(
		(entry) =>
			!publicAssets.some((url) => url === entry.url) ||
			!/^sha256-[A-Za-z0-9+/]{43}=$/.test(entry.integrity),
	)
)
	throw new Error("Invalid worker public manifest");

self.addEventListener("install", (event) => {
	if (pwaConfig.retired) return;
	event.waitUntil(
		(async () => {
			const existed = await caches.has(cacheName);
			const cache = await caches.open(cacheName);
			if (existed) {
				// A changed emitted script may retain the same content version. Never mutate
				// or delete the active worker's cache on a failed replacement install.
				const keys = await cache.keys();
				if (keys.length !== manifest.length)
					throw new Error("Existing owned cache is incomplete");
				for (const entry of manifest) {
					const response = await cache.match(assetURL(entry.url));
					if (
						!response ||
						!cacheableResponse(
							response,
							assetURL(entry.url),
							entry.url === offlineFilename,
						)
					)
						throw new Error("Invalid existing public cache");
					const digest = await crypto.subtle.digest(
						"SHA-256",
						await response.arrayBuffer(),
					);
					const actual = btoa(String.fromCharCode(...new Uint8Array(digest)));
					if (`sha256-${actual}` !== entry.integrity)
						throw new Error("Existing cache integrity mismatch");
				}
				return;
			}
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), 15000);
			try {
				for (const entry of manifest) {
					const url = assetURL(entry.url);
					const response = await fetch(
						new Request(url, {
							credentials: "omit",
							redirect: "error",
							cache: "no-store",
							integrity: entry.integrity,
							signal: abort.signal,
						}),
					);
					if (!cacheableResponse(response, url, entry.url === offlineFilename))
						throw new Error("Unsafe public asset response");
					// Browser SRI verifies exact build-reviewed bytes before any cache write.
					await cache.put(url, response);
				}
			} catch (error) {
				await caches.delete(cacheName);
				throw error;
			} finally {
				clearTimeout(timer);
			}
		})(),
	);
});
self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys())
				if (key.startsWith(prefix) && (pwaConfig.retired || key !== cacheName))
					await caches.delete(key);
			if (pwaConfig.retired) await self.registration.unregister();
		})(),
	);
});
// No skipWaiting, clientsClaim, client navigation or mutation/background queue.
self.addEventListener("fetch", (event) => {
	if (pwaConfig.retired || event.request.method !== "GET") return;
	const entry = expected.get(event.request.url);
	if (entry && !event.request.headers.has("range")) {
		event.respondWith(
			(async () =>
				(await caches.open(cacheName))
					.match(event.request.url)
					.then((response) => response ?? fetch(event.request)))(),
		);
	} else if (
		eligibleNavigation(event.request, scope, pwaConfig.publicOfflinePaths)
	) {
		event.respondWith(
			fetch(event.request).catch(async () => {
				const response = await (await caches.open(cacheName)).match(
					assetURL(offlineFilename),
				);
				return response ?? Response.error();
			}),
		);
	}
});
