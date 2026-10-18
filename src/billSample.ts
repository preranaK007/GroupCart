// Demo-only sample bills: renders small, legible PNG bill images with a 5×7 pixel font
// (no image libraries) so local demo mode can show the upload → read → split flow and
// a "needs reading" draft a member's Claude can actually read through the connector.
// The server knows the exact fields of each sample, so demo "reading" is deterministic.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { addDays, isoDate, type BillCategory } from "./billParse.js";
import type { BillExtraction } from "./billExtract.js";

// ---------------------------------------------------------------------------
// 5×7 font (rows top→bottom, 5 bits each, MSB = leftmost pixel)
// ---------------------------------------------------------------------------

const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0], $: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c], ",": [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "-": [0, 0, 0, 0x1f, 0, 0, 0], "&": [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  "#": [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a], "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08], "'": [0x04, 0x04, 0x08, 0, 0, 0, 0],
  "%": [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03], "+": [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  "*": [0, 0x04, 0x15, 0x0e, 0x15, 0x04, 0], "@": [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0e],
};

type Rgb = [number, number, number];

class Canvas {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number, background: Rgb) {
    this.pixels = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, background);
  }
  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row += 1) {
      for (let col = Math.max(0, x); col < Math.min(this.width, x + w); col += 1) {
        const offset = (row * this.width + col) * 3;
        this.pixels[offset] = color[0]; this.pixels[offset + 1] = color[1]; this.pixels[offset + 2] = color[2];
      }
    }
  }
  /** Draws text at a pixel scale; returns the width drawn. */
  text(x: number, y: number, value: string, scale: number, color: Rgb): number {
    let cursor = x;
    for (const character of value.toUpperCase()) {
      const glyph = FONT[character] ?? FONT[" "]!;
      glyph.forEach((bits, row) => {
        for (let col = 0; col < 5; col += 1) if (bits & (0x10 >> col)) this.rect(cursor + col * scale, y + row * scale, scale, scale, color);
      });
      cursor += 6 * scale;
    }
    return cursor - x;
  }
  textRight(right: number, y: number, value: string, scale: number, color: Rgb): void {
    this.text(right - value.length * 6 * scale + scale, y, value, scale, color);
  }
}

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(canvas: Canvas): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(canvas.width, 0);
  header.writeUInt32BE(canvas.height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const stride = canvas.width * 3;
  const raw = Buffer.alloc((stride + 1) * canvas.height);
  for (let row = 0; row < canvas.height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(canvas.pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Sample bills
// ---------------------------------------------------------------------------

export type SampleKind = "water" | "gas" | "cleaning";
export const SAMPLE_KINDS: readonly SampleKind[] = ["water", "gas", "cleaning"];

type SampleSpec = {
  vendor: string;
  category: BillCategory;
  accent: Rgb;
  lines: string[];
  items: Array<{ description: string; cents: number }>;
  dueInDays: number;
  periodDays: [number, number] | null;
  receipt?: boolean;
};

const SPECS: Record<SampleKind, SampleSpec> = {
  water: {
    vendor: "Cascade Water & Sewer", category: "utilities", accent: [0, 105, 148],
    lines: ["ACCOUNT 4417-0921-3", "SERVICE: 4B OAK ST"],
    items: [{ description: "Water", cents: 3820 }, { description: "Sewer", cents: 2975 }, { description: "Stormwater", cents: 610 }],
    dueInDays: 12, periodDays: [-36, -6],
  },
  gas: {
    vendor: "Northwest Natural Gas", category: "utilities", accent: [196, 62, 0],
    lines: ["ACCOUNT 88-201-7745", "METER 0042871"],
    items: [{ description: "Gas delivery", cents: 3164 }, { description: "Customer charge", cents: 1100 }, { description: "Taxes", cents: 418 }],
    dueInDays: 8, periodDays: [-33, -3],
  },
  cleaning: {
    vendor: "Sparkle House Cleaning", category: "household", accent: [94, 53, 177],
    lines: ["INVOICE #1182", "DEEP CLEAN - 3 BR"],
    items: [{ description: "Deep clean", cents: 14000 }, { description: "Oven add-on", cents: 2500 }],
    dueInDays: 5, periodDays: null,
  },
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  return `${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][month - 1]} ${day}, ${year}`;
}

export type SampleBill = { kind: SampleKind; fileName: string; png: Buffer; sha256: string; extraction: BillExtraction };

const cache = new Map<string, SampleBill>();

/** Renders a sample bill dated relative to `today` (same day → same bytes). */
export function renderSampleBill(kind: SampleKind, today: Date): SampleBill {
  const key = `${kind}:${isoDate(today)}`;
  const cached = cache.get(key);
  if (cached) return { ...cached, extraction: { ...cached.extraction, items: cached.extraction.items.map((item) => ({ ...item })) } };
  const sample = drawSampleBill(kind, today);
  if (cache.size > 24) cache.clear();
  cache.set(key, sample);
  return renderSampleBill(kind, today);
}

function drawSampleBill(kind: SampleKind, today: Date): SampleBill {
  const spec = SPECS[kind];
  const todayIso = isoDate(today);
  const dueDate = addDays(todayIso, spec.dueInDays);
  const periodStart = spec.periodDays ? addDays(todayIso, spec.periodDays[0]) : null;
  const periodEnd = spec.periodDays ? addDays(todayIso, spec.periodDays[1]) : null;
  const total = spec.items.reduce((sum, item) => sum + item.cents, 0);
  const ink: Rgb = [32, 33, 36];
  const muted: Rgb = [95, 99, 104];
  const canvas = new Canvas(560, 576, [255, 255, 255]);
  canvas.rect(0, 0, 560, 96, spec.accent);
  canvas.text(28, 26, spec.vendor, 3, [255, 255, 255]);
  canvas.text(28, 62, spec.periodDays ? "MONTHLY STATEMENT" : "INVOICE", 2, [255, 255, 255]);
  let y = 124;
  for (const line of spec.lines) { canvas.text(28, y, line, 2, muted); y += 24; }
  if (periodStart && periodEnd) { canvas.text(28, y, `SERVICE ${longDate(periodStart)} - ${longDate(periodEnd)}`, 2, muted); y += 24; }
  canvas.text(28, y, `STATEMENT DATE ${longDate(todayIso)}`, 2, muted);
  y += 40;
  canvas.rect(28, y, 504, 2, [218, 220, 224]);
  y += 20;
  for (const item of spec.items) {
    canvas.text(28, y, item.description, 2, ink);
    canvas.textRight(532, y, money(item.cents), 2, ink);
    y += 30;
  }
  canvas.rect(28, y, 504, 2, [218, 220, 224]);
  y += 28;
  canvas.text(28, y, "AMOUNT DUE", 3, ink);
  canvas.textRight(532, y, money(total), 3, ink);
  y += 48;
  canvas.text(28, y, "PAYMENT DUE BY", 2, muted);
  canvas.textRight(532, y, longDate(dueDate), 2, ink);
  y += 56;
  canvas.rect(28, y, 504, 64, [241, 243, 244]);
  canvas.text(44, y + 14, "PAY ONLINE OR BY PHONE.", 2, muted);
  canvas.text(44, y + 38, "THANK YOU FOR YOUR BUSINESS.", 2, muted);
  const png = encodePng(canvas);
  return {
    kind,
    fileName: `sample-${kind}-bill.png`,
    png,
    sha256: createHash("sha256").update(png).digest("hex"),
    extraction: {
      isBill: true,
      vendor: spec.vendor,
      category: spec.category,
      totalCents: total,
      currency: "USD",
      dueDate,
      periodStart,
      periodEnd,
      items: spec.items.map((item) => ({ ...item })),
      confidence: "high",
      notes: null,
      method: "demo",
    },
  };
}

/** Demo reading for a known sample image (matched by content hash), else null. */
export function demoExtractionFor(sha256: string, today: Date): BillExtraction | null {
  for (const kind of SAMPLE_KINDS) {
    for (const offset of [0, -1]) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12);
      const sample = renderSampleBill(kind, day);
      if (sample.sha256 === sha256) return sample.extraction;
    }
  }
  return null;
}
