// Draws the home-screen icons in src/ui/assets/ (served by src/ui/pwa.ts) from the app bar's cart mark.
// Run after changing the mark or its colors:  node --import=tsx scripts/make-pwa-icons.ts
// Renders each icon with a headless Chromium browser: Microsoft Edge at its default Windows path, or set
// ICON_BROWSER to the path of Edge or Chrome.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { icon } from "../src/ui/shell.js";

const BROWSER = process.env.ICON_BROWSER ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT_DIR = fileURLToPath(new URL("../src/ui/assets/", import.meta.url));
const ACCENT = "#0b57d0"; // Classic light --gc-accent: the app bar logo and the favicon
const RENDER_TIMEOUT_MS = 30_000;

type IconSpec = {
  file: string;
  size: number;
  /** Corner radius as a fraction of the size; 0 = full-bleed square. */
  corner: number;
  /** Width of the cart's 24-unit icon box as a fraction of the size. */
  glyph: number;
};

// The app bar logo is a 36px rounded square (10px corners) holding a 22px cart.
const APP_BAR_CORNER = 10 / 36;
const APP_BAR_GLYPH = 22 / 36;

const ICONS: readonly IconSpec[] = [
  // iOS rounds the corners itself and turns transparent pixels black, so this one is a full square.
  { file: "apple-touch-icon.png", size: 180, corner: 0, glyph: APP_BAR_GLYPH },
  { file: "icon-192.png", size: 192, corner: APP_BAR_CORNER, glyph: APP_BAR_GLYPH },
  { file: "icon-512.png", size: 512, corner: APP_BAR_CORNER, glyph: APP_BAR_GLYPH },
  // Maskable: launchers crop to any shape inside the central 80% circle, so the cart stays well within it.
  { file: "icon-maskable-512.png", size: 512, corner: 0, glyph: 0.5 },
];

function iconSvg(spec: IconSpec): string {
  const box = spec.size * spec.glyph;
  const unit = box / 24;
  // Optical centering: the cart's strokes span x 1.6–21.9 and y 2.6–22.3 of its 24-unit box.
  const x = (spec.size - box) / 2 + 0.25 * unit;
  const y = (spec.size - box) / 2 - 0.45 * unit;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.size}" height="${spec.size}" viewBox="0 0 ${spec.size} ${spec.size}">`
    + `<rect width="${spec.size}" height="${spec.size}" rx="${spec.size * spec.corner}" fill="${ACCENT}"/>`
    + `<g transform="translate(${x} ${y})" color="#ffffff">${icon("cart", { size: box })}</g></svg>`;
}

/** Width and height of a fully written PNG (signature through IEND), or null while it is missing or partial. */
function finishedPngSize(file: string): { width: number; height: number } | null {
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  const complete = bytes.length > 24 && bytes.toString("latin1", 1, 4) === "PNG" && bytes.toString("latin1", bytes.length - 8, bytes.length - 4) === "IEND";
  return complete ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

const work = mkdtempSync(join(tmpdir(), "gc-icons-"));
try {
  for (const spec of ICONS) {
    const page = join(work, `${spec.file}.html`);
    const out = join(OUT_DIR, spec.file);
    writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${iconSvg(spec)}</body></html>`);
    rmSync(out, { force: true });
    // On Windows msedge.exe hands the work to a child process and returns at once, so wait for the file.
    execFileSync(BROWSER, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
      "--default-background-color=00000000", `--window-size=${spec.size},${spec.size}`,
      `--user-data-dir=${join(work, `profile-${spec.size}-${spec.file}`)}`, `--screenshot=${out}`, pathToFileURL(page).href,
    ], { stdio: "ignore" });
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let size = finishedPngSize(out);
    while (!size && Date.now() < deadline) {
      await sleep(250);
      size = finishedPngSize(out);
    }
    if (!size) throw new Error(`${spec.file} was not rendered within ${RENDER_TIMEOUT_MS / 1000}s.`);
    if (size.width !== spec.size || size.height !== spec.size) throw new Error(`${spec.file} came out ${size.width}x${size.height}, expected ${spec.size}x${spec.size}.`);
    console.log(`${spec.file} ${size.width}x${size.height}`);
  }
} finally {
  // The browser may still be closing its profile; retry instead of failing on a locked file.
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
