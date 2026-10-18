// Deterministic sample schedules for the calendar page when Google OAuth is not
// configured. The same member + week always produces the same busy blocks.
import { addDays, dayOfWeek, zonedTimeToEpoch, type Interval } from "./availability.js";

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type Block = [startMinutes: number, endMinutes: number];
type Persona = (weekday: number, random: () => number) => Block[];

const h = (hours: number) => Math.round(hours * 60);
/** Random offset in 15-minute steps between -steps and +steps. */
const jitter = (random: () => number, steps: number) => (Math.floor(random() * (steps * 2 + 1)) - steps) * 15;

// weekday: 0 = Sunday ... 6 = Saturday
const personas: Persona[] = [
  // Office hours with a lunch gap, an occasional evening plan, light weekends.
  (weekday, random) => {
    if (weekday === 0) return random() < 0.5 ? [[h(14) + jitter(random, 2), h(16)]] : [];
    if (weekday === 6) return random() < 0.6 ? [[h(10), h(11.5) + jitter(random, 2)]] : [];
    const blocks: Block[] = [[h(9) + jitter(random, 2), h(12)], [h(13), h(17.5) + jitter(random, 2)]];
    if (random() < 0.4) blocks.push([h(18.5), h(20) + jitter(random, 2)]);
    if (random() < 0.3) blocks.push([h(7.5), h(8.25)]);
    return blocks;
  },
  // Student: scattered classes, evening study group, weekend brunch.
  (weekday, random) => {
    if (weekday === 0) return random() < 0.5 ? [[h(11), h(12.5)]] : [];
    if (weekday === 6) return random() < 0.5 ? [[h(13) + jitter(random, 2), h(15)]] : [];
    const blocks: Block[] = [];
    const starts = weekday % 2 === 1 ? [8.5, 11, 14] : [10, 13.5];
    for (const start of starts) {
      if (random() < 0.85) blocks.push([h(start) + jitter(random, 1), h(start + 1.25 + Math.floor(random() * 3) * 0.25)]);
    }
    if (random() < 0.45) blocks.push([h(19), h(21)]);
    return blocks;
  },
  // Shift worker: alternating early/late shifts, two days off with the gym.
  (weekday, random) => {
    if (weekday === 3 || weekday === 0) return random() < 0.7 ? [[h(9), h(10.5)]] : [];
    if (weekday === 1 || weekday === 4) return [[h(7), h(15) + jitter(random, 1)]];
    if (weekday === 6) return [[h(11), h(19)]];
    return [[h(14) + jitter(random, 1), h(22)]];
  },
  // Hybrid worker: meetings in blocks, errands mid-day.
  (weekday, random) => {
    if (weekday === 0 || weekday === 6) return random() < 0.4 ? [[h(16), h(18)]] : [];
    const blocks: Block[] = [[h(8.5), h(10) + jitter(random, 1)], [h(10.5) + jitter(random, 1), h(12)]];
    if (random() < 0.7) blocks.push([h(14), h(16) + jitter(random, 2)]);
    if (random() < 0.3) blocks.push([h(17.5), h(19)]);
    return blocks;
  },
];

export function demoBusyBlocks(memberKey: string, memberIndex: number, weekStart: string, timeZone: string): Interval[] {
  const persona = personas[memberIndex % personas.length]!;
  const random = seededRandom(hashSeed(`${weekStart}|${memberKey}|${memberIndex}`));
  const blocks: Interval[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    for (const [start, end] of persona(dayOfWeek(date), random)) {
      if (end <= start) continue;
      blocks.push({ start: zonedTimeToEpoch(date, start, timeZone), end: zonedTimeToEpoch(date, end, timeZone) });
    }
  }
  return blocks.sort((a, b) => a.start - b.start);
}
