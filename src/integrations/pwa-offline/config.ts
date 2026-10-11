// Keep this base equal to Vite's base. Paths are relative to that base.
export const pwaConfig = {
	base: "/",
	publicOfflinePaths: [] as string[],
	retired: false,
} as const;
export const workerFilename = "pwa-offline-sw.js";
export const publicAssets = [
	"pwa-offline/offline.html",
	"pwa-offline/icon-192-c37f42e5e1e76c61.png",
	"pwa-offline/icon-512-497feff41eb4e6db.png",
] as const;
export const offlineFilename = publicAssets[0];
