// Remote-access policy for the local web server.
//
// GroupCart binds to 127.0.0.1. A request counts as "remote" when it did not come straight from this
// computer: it came through a tunnel or reverse proxy (cloudflared and similar add forwarding headers and
// keep the public Host), from another device (non-loopback socket), or names a Host other than
// 127.0.0.1 / localhost / [::1]. The Host check also blocks DNS-rebinding pages in a local browser.
//
// Remote requests may reach only:
//   /mcp, /mcp/t/<token>          the Claude connector (own per-member token auth, src/connector.ts)
//   /signin…, /api/auth/…         sign-in routes of a profiles module (they do their own checks)
//   anything isRemoteAuthorized() accepts (src/platform.ts; false until a profiles module installs one)
// Everything else answers 404, so the dashboard, /api/*, demo endpoints and OAuth starts stay local-only.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isRemoteAuthorized } from "./platform.js";

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

/** Paths a remote request may reach without isRemoteAuthorized(): the connector and sign-in routes. */
export function isRemotePublicPath(pathname: string): boolean {
  return isConnectorPath(pathname) || pathname.startsWith("/signin") || pathname.startsWith("/api/auth/");
}

/**
 * Early guard for the dashboard server. Returns true (after sending 404) when a remote request asks for
 * anything other than the connector, sign-in routes, or a route the remote authorizer accepts.
 */
export function blockRemoteRequest(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  if (!isRemoteRequest(request)) return false;
  if (isRemotePublicPath(url.pathname)) return false;
  let authorized = false;
  try {
    authorized = isRemoteAuthorized(request, url);
  } catch {
    authorized = false;
  }
  if (authorized) return false;
  response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: "Not found." }));
  return true;
}
