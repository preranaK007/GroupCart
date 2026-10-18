// Run with: node --import=tsx --test src/pwa.test.ts
// Home-screen install (src/ui/pwa.ts): phones fetch the manifest, icons, service worker, and offline page without
// cookies before anyone signs in, so those exact paths must pass the remote-access guard while everything else stays
// behind it; and the service worker must never cache or replay live data, sign-in, or connector traffic.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runInNewContext } from "node:vm";
import { startDashboard } from "./dashboard.js";
import { isRemotePublicPath } from "./remoteAccess.js";
import { CartStore } from "./store.js";
import { PWA_HEAD, PWA_PATHS } from "./ui/pwa.js";
import { renderSignInPage } from "./ui/signinPage.js";

// A phone reaching GroupCart through a tunnel, with no session cookie.
const REMOTE = { host: "groupcart.example.ts.net", "x-forwarded-for": "198.51.100.7" };

let directory: string;
let store: CartStore;
let server: Server;
let base: string;

type RawResponse = { status: number; headers: IncomingMessage["headers"]; body: Buffer };

function get(path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function pngSize(bytes: Buffer): string {
  assert.equal(bytes.toString("latin1", 1, 4), "PNG");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "gc-pwa-test-"));
  store = new CartStore(join(directory, "test.sqlite"), "test-home", 5000);
  store.registerMembers([{ handle: "demo:alex", name: "Alex" }]);
  server = startDashboard(store, 0, true);
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("install files are public before sign-in, at their exact paths only", () => {
  for (const path of PWA_PATHS) assert.ok(isRemotePublicPath(path), path);
  for (const path of ["/icons/", "/icons/secret.png", "/icons/icon-192.png/x", "/sw.js/", "/sw.json", "/offline", "/offline.html/x", "/manifest.webmanifest.bak", "/apple-touch-icon.png"]) {
    assert.equal(isRemotePublicPath(path), false, path);
  }
});

test("a signed-out phone can fetch the manifest and every icon it names; pages and APIs stay guarded", async () => {
  const manifestResponse = await get("/manifest.webmanifest", REMOTE);
  assert.equal(manifestResponse.status, 200);
  assert.match(String(manifestResponse.headers["content-type"]), /^application\/manifest\+json/);
  const manifest = JSON.parse(manifestResponse.body.toString("utf8")) as { name: string; short_name: string; start_url: string; scope: string; display: string; icons: Array<{ src: string; sizes: string; type: string; purpose: string }> };
  assert.deepEqual([manifest.name, manifest.short_name, manifest.start_url, manifest.scope, manifest.display], ["GroupCart", "GroupCart", "/", "/", "standalone"]);
  assert.deepEqual(manifest.icons.map((entry) => `${entry.sizes} ${entry.purpose}`), ["192x192 any", "512x512 any", "512x512 maskable"]);
  for (const entry of manifest.icons) {
    const response = await get(entry.src, REMOTE);
    assert.equal(response.status, 200, entry.src);
    assert.equal(response.headers["content-type"], "image/png");
    assert.match(String(response.headers["cache-control"]), /max-age=31536000, immutable/);
    assert.equal(pngSize(response.body), entry.sizes, entry.src);
  }
  // An icon URL without its current version is revalidated rather than cached for a year.
  assert.equal((await get("/icons/icon-192.png?v=old", REMOTE)).headers["cache-control"], "no-cache");

  // Pages carry the install tags; their apple-touch-icon is the 180px home-screen icon.
  const page = (await get("/")).body.toString("utf8");
  assert.ok(page.includes(PWA_HEAD));
  assert.ok(renderSignInPage({ demoMode: true, canSendCodes: false, next: "/" }).includes(PWA_HEAD));
  const appleTouchIcon = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(page)?.[1];
  assert.ok(appleTouchIcon);
  assert.equal(pngSize((await get(appleTouchIcon, REMOTE)).body), "180x180");
  assert.match(page, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/);
  assert.match(page, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)" \/>/);

  for (const path of ["/sw.js", "/offline.html"]) assert.equal((await get(path, REMOTE)).status, 200, path);
  assert.match(String((await get("/sw.js", REMOTE)).headers["content-type"]), /^text\/javascript/);
  // The guard is otherwise unchanged.
  assert.equal((await get("/", { ...REMOTE, accept: "text/html" })).status, 302);
  assert.equal((await get("/api/cart", REMOTE)).status, 401);
  assert.equal((await get("/icons/secret.png", REMOTE)).status, 401);
});

type FakeRequest = { url: string; method?: string; mode?: string; credentials?: string };

/** Runs sw.js against an in-memory Cache Storage and a scripted network, recording every cache write. */
async function loadServiceWorker(origin: string) {
  const source = (await get("/sw.js")).body.toString("utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const keyOf = (url: string) => { const parsed = new URL(url, origin); return parsed.pathname + parsed.search; };
  const cached = new Map<string, { cachedUrl: string }>();
  const precached: FakeRequest[] = [];
  const deleted: string[] = [];
  const opened: string[] = [];
  const state = { online: true };
  const cache = {
    addAll: async (requests: FakeRequest[]) => {
      for (const request of requests) {
        precached.push(request);
        cached.set(keyOf(request.url), { cachedUrl: request.url });
      }
    },
    put: () => assert.fail("the service worker must not cache responses at runtime"),
  };
  runInNewContext(source, {
    self: { location: { origin }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: {
      open: async (name: string) => { opened.push(name); return cache; },
      keys: async () => ["groupcart-0ld", "another-app", ...opened],
      delete: async (name: string) => { deleted.push(name); return true; },
      match: async (request: string | FakeRequest) => cached.get(keyOf(typeof request === "string" ? request : request.url)),
    },
    fetch: async (request: FakeRequest) => {
      if (!state.online) throw new TypeError("Failed to fetch");
      return { network: request.url };
    },
    Request: function Request(this: FakeRequest, url: string, init: { credentials?: string }) { this.url = url; this.credentials = init.credentials; },
    Response: { error: () => ({ error: true }) },
    URL,
  });
  async function lifecycle(type: "install" | "activate"): Promise<void> {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  /** The service worker's answer, or "browser" when it lets the request through untouched. */
  async function fetchEvent(path: string, init: { method?: string; mode?: string } = {}): Promise<unknown> {
    let answer: Promise<unknown> | undefined;
    const request: FakeRequest = { url: new URL(path, origin).href, method: init.method ?? "GET", mode: init.mode ?? "cors" };
    listeners.get("fetch")!({ request, respondWith: (value: unknown) => { answer = Promise.resolve(value); } });
    return answer ? await answer : "browser";
  }
  return { lifecycle, fetchEvent, precached, deleted, opened, state };
}

test("the service worker caches only the install files and never answers with stale live data", async () => {
  const origin = "https://groupcart.example.ts.net";
  const sw = await loadServiceWorker(origin);
  await sw.lifecycle("install");
  // Precached without cookies: the offline page, the manifest, and the versioned icons.
  assert.ok(sw.precached.every((request) => request.credentials === "omit"));
  assert.deepEqual(sw.precached.map((request) => request.url.split("?")[0]).sort(), [...PWA_PATHS].filter((path) => path !== "/sw.js").sort());
  await sw.lifecycle("activate");
  assert.deepEqual(sw.deleted, ["groupcart-0ld"], "only older GroupCart caches are removed");

  // Pages come from the network while online.
  assert.deepEqual(await sw.fetchEvent("/chores", { mode: "navigate" }), { network: `${origin}/chores` });
  // Live data, writes, sign-in, and connector traffic are never touched.
  for (const path of ["/api/cart", "/api/auth/verify", "/api/feed"]) assert.equal(await sw.fetchEvent(path), "browser", path);
  for (const path of ["/api/auth/verify", "/api/chat/messages", "/mcp", "/oauth/token"]) assert.equal(await sw.fetchEvent(path, { method: "POST" }), "browser", `POST ${path}`);
  for (const path of ["/oauth/authorize?client_id=x", "/mcp", "/.well-known/oauth-authorization-server", "/api/google/oauth/callback?code=x", "/api/kroger/oauth/callback?code=x"]) {
    assert.equal(await sw.fetchEvent(path, { mode: "navigate" }), "browser", path);
  }
  assert.equal(await sw.fetchEvent("/signin", { mode: "navigate", method: "POST" }), "browser");

  // Offline: page loads get the offline page; API calls still go to the network and fail there.
  sw.state.online = false;
  assert.deepEqual(await sw.fetchEvent("/chores", { mode: "navigate" }), { cachedUrl: "/offline.html" });
  assert.deepEqual(await sw.fetchEvent("/signin?next=%2F", { mode: "navigate" }), { cachedUrl: "/offline.html" });
  assert.equal(await sw.fetchEvent("/api/cart"), "browser");
  const icon = sw.precached.find((request) => request.url.startsWith("/icons/icon-192.png?v="));
  assert.ok(icon);
  assert.deepEqual(await sw.fetchEvent(icon.url), { cachedUrl: icon.url });
});
