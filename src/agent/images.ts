// Fetching an image the household coordinator found on the web (a GIF, a meme, a photo) so it can be posted in
// the group. The URL comes from the model, so treat it as untrusted: https only, public addresses only (no
// localhost or private networks, checked after DNS and on every redirect), a size cap, and real image bytes.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sniffImage } from "../profiles.js";

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export type FetchedImage = { data: Buffer; mimeType: string };

/** True for loopback, private, link-local, carrier-grade NAT, and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(lower);
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function checkPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("That isn't a valid link."); }
  if (url.protocol !== "https:") throw new Error("Only https image links are allowed.");
  if (url.port && url.port !== "443") throw new Error("Only standard https links are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("That link points somewhere private.");
  return url;
}

/** Downloads an image from a public https URL (following a few checked redirects). */
export async function fetchPublicImage(raw: string): Promise<FetchedImage> {
  let url = await checkPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "image/*" } });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) throw new Error("The image link redirected nowhere.");
      url = await checkPublicUrl(new URL(next, url).toString());
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`The image didn't load (${response.status}).`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("That image is too big.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("That image is too big.");
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    const type = sniffImage(data);
    if (!type) throw new Error("That link isn't a PNG, JPEG, GIF, or WebP image.");
    return { data, mimeType: type.mimeType };
  }
  throw new Error("The image link redirected too many times.");
}
