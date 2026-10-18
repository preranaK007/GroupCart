// Remote-access policy for the local web server.
//
// GroupCart binds to 127.0.0.1. A request counts as "remote" when it did not come straight from this
// computer: it came through a tunnel or reverse proxy (cloudflared and similar add forwarding headers and
// keep the public Host), from another device (non-loopback socket), or names a Host other than
// 127.0.0.1 / localhost / [::1]. The Host check also blocks DNS-rebinding pages in a local browser.
//
// Without a signed-in session (isRemoteAuthorized, installed by src/profilesAndChat.ts), remote requests may
// reach only these public paths; remoteAccessGuard in src/auth.ts enforces it as the first step of every request:
//   /mcp, /mcp/t/<token>          the AI assistant connector (own token auth, src/connector.ts)
//   /oauth/…, /.well-known/…      its OAuth sign-in and metadata (src/connectorOAuth.ts; pairing code + consent)
//   /signin…, /api/auth/…         web sign-in (src/auth.ts; does its own checks)
//   INSTALL_FILE_PATHS            the home-screen app's manifest, icons, service worker, and offline page
//                                 (src/ui/pwa.ts; static files with no household data, exact paths only)
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FORWARDING_HEADERS = [
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded",
  "x-real-ip", "cf-connecting-ip", "cf-ray", "true-client-ip",
];

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** Lowercased hostname from a Host header ("[::1]" keeps its brackets), or null when missing/invalid. */
export function hostNameOf(hostHeader: string | undefined): string | null {
  // Plain host[:port] or [ipv6][:port] only; anything else (userinfo, paths, spaces) is treated as invalid.
  if (!hostHeader || !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(hostHeader)) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True unless the request came directly from this computer to a loopback host with no proxy in between. */
export function isRemoteRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return true;
  if (FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined)) return true;
  const host = hostNameOf(request.headers.host);
  return host === null || !LOOPBACK_HOSTS.has(host);
}

/** Connector endpoint paths: /mcp and /mcp/t/<token> (optional trailing slash). */
export function isConnectorPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/mcp/" || /^\/mcp\/t\/[^/]+\/?$/.test(pathname);
}

/**
 * Files a phone fetches without cookies, before anyone signs in, to install GroupCart to its home screen
 * (served by src/ui/pwa.ts). Exact paths: no prefixes, so nothing else under /icons/ becomes public.
 */
const INSTALL_FILE_PATHS: ReadonlySet<string> = new Set([
  "/manifest.webmanifest",
  "/sw.js",
  "/offline.html",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
]);

/** Paths a remote request may reach without isRemoteAuthorized(): the connector, its OAuth, sign-in, and install files. */
export function isRemotePublicPath(pathname: string): boolean {
  return isConnectorPath(pathname)
    || pathname.startsWith("/oauth/")
    || pathname.startsWith("/.well-known/")
    || pathname.startsWith("/signin")
    || pathname.startsWith("/api/auth/")
    || INSTALL_FILE_PATHS.has(pathname);
}
