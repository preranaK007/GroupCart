/**
 * Installable web app: the manifest, home-screen icons, service worker, and offline page that let a roommate
 * add GroupCart to an iPhone home screen (Safari > Share > Add to Home Screen) or install it from Chrome/Edge.
 *
 * PWA_HEAD goes in every page's <head> (renderPage in ./shell.ts and the sign-in page). The files are served
 * at the exact paths in PWA_PATHS, which src/remoteAccess.ts lists as public: phones fetch the manifest and
 * icons without cookies, and before anyone has signed in. None of them says anything about the household.
 *
 * The service worker keeps no live data. Pages and /api calls always go to the network; its cache holds only
 * the files here (fetched without cookies), and a page load that fails offline gets the offline page. It
 * handles GET requests only and leaves navigations to /api, /mcp, /oauth, and /.well-known to the browser,
 * so sign-in, the connector, and OAuth work exactly as they do without it. The cache name carries a hash of
 * these files: any change installs a fresh cache and deletes the old one.
 *
 * Icons: src/ui/assets/*.png, drawn from the app bar's cart mark by scripts/make-pwa-icons.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { registerRoute } from "../platform.js";
// shell.ts imports this module for PWA_HEAD, so its exports are read only at request time (see installFiles).
import { BASE_CSS, TOKENS_CSS, button, icon } from "./shell.js";

export const MANIFEST_PATH = "/manifest.webmanifest";
export const SERVICE_WORKER_PATH = "/sw.js";
export const OFFLINE_PATH = "/offline.html";

// Classic --gc-surface (the app bar) in light and dark.
const LIGHT_SURFACE = "#ffffff";
const DARK_SURFACE = "#1e1f20";

type IconFile = { path: string; url: string; version: string; body: Buffer };

function iconFile(name: string): IconFile {
  const body = readFileSync(new URL(`./assets/${name}`, import.meta.url));
  const version = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return { path: `/icons/${name}`, url: `/icons/${name}?v=${version}`, version, body };
}

const APPLE_TOUCH_ICON = iconFile("apple-touch-icon.png");
const ICON_192 = iconFile("icon-192.png");
const ICON_512 = iconFile("icon-512.png");
const ICON_MASKABLE = iconFile("icon-maskable-512.png");
const ICONS = [APPLE_TOUCH_ICON, ICON_192, ICON_512, ICON_MASKABLE];

/** Every path served here; each must be public in src/remoteAccess.ts (src/pwa.test.ts checks). */
export const PWA_PATHS: readonly string[] = [MANIFEST_PATH, SERVICE_WORKER_PATH, OFFLINE_PATH, ...ICONS.map((file) => file.path)];

const MANIFEST = JSON.stringify({
  id: "/",
  name: "GroupCart",
  short_name: "GroupCart",
  description: "Groceries, chores, bills, and plans for your household.",
  lang: "en",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: LIGHT_SURFACE,
  theme_color: LIGHT_SURFACE,
  icons: [
    { src: ICON_192.url, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: ICON_512.url, sizes: "512x512", type: "image/png", purpose: "any" },
    { src: ICON_MASKABLE.url, sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

/**
 * <head> tags for installing to a home screen, plus the service worker registration. The status bar stays
 * "default" (opaque, matching the app bar) because black-translucent would draw white text over a white app bar.
 * Service workers need https or localhost, so on a plain-http LAN address the page simply skips it.
 */
export const PWA_HEAD = `<link rel="manifest" href="${MANIFEST_PATH}" />
<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON.url}" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="GroupCart" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="theme-color" content="${LIGHT_SURFACE}" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="${DARK_SURFACE}" media="(prefers-color-scheme: dark)" />
<script>if ("serviceWorker" in navigator) addEventListener("load", function () { navigator.serviceWorker.register("${SERVICE_WORKER_PATH}", { scope: "/", updateViaCache: "none" }).catch(function (error) { console.warn("GroupCart offline page unavailable:", error); }); });</script>`;

function renderOfflinePage(): string {
  const styles = `
.off { min-height:100dvh; display:grid; place-items:center; align-content:center; gap:var(--gc-space-3); padding:var(--gc-space-5) var(--gc-space-4); text-align:center; }
.off-logo { width:44px; height:44px; display:grid; place-items:center; border-radius:12px; background:var(--gc-accent); color:var(--gc-on-accent); }
.off-title { font-size:var(--gc-fs-xl); font-weight:400; }
.off-text { max-width:340px; color:var(--gc-text-2); margin-bottom:var(--gc-space-2); }`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<meta name="robots" content="noindex" />
<title>Offline · GroupCart</title>
<style>${TOKENS_CSS}${BASE_CSS}${styles}</style>
</head>
<body>
<main class="off">
  <div class="off-logo">${icon("cart", { size: 24 })}</div>
  <h1 class="off-title">You're offline</h1>
  <p class="off-text">GroupCart shows your household's live lists, so it needs a connection. It will reload when you're back online.</p>
  ${button({ label: "Try again", id: "retry" })}
</main>
<script>
document.getElementById("retry").addEventListener("click", function () { location.reload(); });
addEventListener("online", function () { location.reload(); });
</script>
</body>
</html>`;
}

function renderServiceWorker(cacheName: string): string {
  const precache = [OFFLINE_PATH, MANIFEST_PATH, ...ICONS.map((file) => file.url)];
  return `// GroupCart service worker, generated by src/ui/pwa.ts. Live data always comes from the network.
const CACHE = ${JSON.stringify(cacheName)};
const OFFLINE_URL = ${JSON.stringify(OFFLINE_PATH)};
const PRECACHE = ${JSON.stringify(precache)};
// Navigations here go straight to the browser: JSON and OAuth callbacks, the connector, and its metadata.
const PASSTHROUGH = /^\\/(?:api\\/|mcp(?:\\/|$)|oauth\\/|\\.well-known\\/)/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { credentials: "omit", cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith("groupcart-") && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    if (PASSTHROUGH.test(url.pathname)) return;
    // Always the live page; the offline page only when the network is unreachable.
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL).then((offline) => offline || Response.error())));
    return;
  }
  if (PRECACHE.includes(url.pathname + url.search)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
`;
}

type InstallFiles = { offlineHtml: string; serviceWorker: string };
let installFiles: InstallFiles | null = null;

/** Built on first use: the offline page needs ./shell.ts, which is still loading while this module loads. */
function getInstallFiles(): InstallFiles {
  if (!installFiles) {
    const offlineHtml = renderOfflinePage();
    const version = createHash("sha256").update(MANIFEST).update(offlineHtml).update(ICONS.map((file) => file.url).join("\n")).digest("hex").slice(0, 12);
    installFiles = { offlineHtml, serviceWorker: renderServiceWorker(`groupcart-${version}`) };
  }
  return installFiles;
}

function send(response: ServerResponse, contentType: string, body: string | Buffer, cacheControl: string): true {
  response.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
  response.end(body);
  return true;
}

registerRoute((request, response, url) => {
  if (request.method !== "GET") return false;
  // The manifest, worker, and offline page are small and must update promptly: revalidate on every use.
  if (url.pathname === MANIFEST_PATH) return send(response, "application/manifest+json; charset=utf-8", MANIFEST, "no-cache");
  if (url.pathname === SERVICE_WORKER_PATH) return send(response, "text/javascript; charset=utf-8", getInstallFiles().serviceWorker, "no-cache");
  if (url.pathname === OFFLINE_PATH) return send(response, "text/html; charset=utf-8", getInstallFiles().offlineHtml, "no-cache");
  const file = ICONS.find((candidate) => candidate.path === url.pathname);
  if (!file) return false;
  // Pages link icons as ?v=<content hash>, so that exact URL never changes; other versions revalidate.
  return send(response, "image/png", file.body, url.searchParams.get("v") === file.version ? "public, max-age=31536000, immutable" : "no-cache");
});
