import { round } from "./geometry.js";
import { getMaterial } from "./materials.js";
import type { Part } from "./types.js";

export interface NestOptions {
  toolDia: number; // router bit diameter; parts are spaced by this plus a little
  spacing: number; // extra gap beyond the tool path
  trim: number; // unusable border on each sheet edge
}

export const DEFAULT_NEST: NestOptions = { toolDia: 6.35, spacing: 4, trim: 12 };

export interface Placement {
  partId: string;
  label: string;
  x: number; // lower-left corner of the part on the sheet (mm, sheet coords)
  y: number;
  rotated: boolean; // true = part length runs along the sheet's short (Y) axis
  w: number; // footprint on sheet
  h: number;
}

export interface Sheet {
  index: number;
  material: string;
  length: number; // sheet X (grain direction)
  width: number; // sheet Y
  placements: Placement[];
  utilisation: number; // 0..1 of full sheet area
}

interface Rect { x: number; y: number; w: number; h: number }

class MaxRects {
  free: Rect[];
  constructor(public W: number, public H: number) {
    this.free = [{ x: 0, y: 0, w: W, h: H }];
  }
  find(w: number, h: number, allowRotate: boolean): { r: Rect; rotated: boolean; score: [number, number] } | null {
    let best: { r: Rect; rotated: boolean; score: [number, number] } | null = null;
    const tryFit = (fw: number, fh: number, rotated: boolean) => {
      for (const f of this.free) {
        if (fw <= f.w + 1e-6 && fh <= f.h + 1e-6) {
          const a = Math.min(f.w - fw, f.h - fh), b = Math.max(f.w - fw, f.h - fh);
          if (!best || a < best.score[0] || (a === best.score[0] && b < best.score[1])) {
            best = { r: { x: f.x, y: f.y, w: fw, h: fh }, rotated, score: [a, b] };
          }
        }
      }
    };
    tryFit(w, h, false);
    if (allowRotate) tryFit(h, w, true);
    return best;
  }
  place(r: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) { next.push(f); continue; }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
    }
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y)));
  }
}

/** Nest parts onto the fewest sheets per material (MaxRects, best-short-side-fit). */
export function nestParts(parts: Part[], opts: NestOptions = DEFAULT_NEST): Sheet[] {
  const gap = opts.toolDia + opts.spacing;
  const byMat = new Map<string, Part[]>();
  for (const p of parts) byMat.set(p.material, [...(byMat.get(p.material) ?? []), p]);
  const sheets: Sheet[] = [];
  for (const [matKey, ps] of byMat) {
    const m = getMaterial(matKey);
    const W = m.sheet.length - 2 * opts.trim + gap;
    const H = m.sheet.width - 2 * opts.trim + gap;
    const orders: ((a: Part, b: Part) => number)[] = [
      (a, b) => Math.max(b.length, b.width) - Math.max(a.length, a.width) || b.length * b.width - a.length * a.width,
      (a, b) => b.length * b.width - a.length * a.width,
      (a, b) => b.length - a.length || b.width - a.width,
      (a, b) => b.width - a.width || b.length - a.length,
    ];
    let bins: { mr: MaxRects; placements: Placement[] }[] = [];
    let bestScore = Infinity;
    for (const order of orders) {
      const attempt = packOnce([...ps].sort(order), W, H, gap, opts.trim, m.sheet);
      // fewest sheets, then emptiest last sheet (more reusable offcut)
      const lastUsed = attempt[attempt.length - 1].placements.reduce((s, pl) => s + pl.w * pl.h, 0);
      const score = attempt.length * 1e12 + lastUsed;
      if (score < bestScore) { bestScore = score; bins = attempt; }
    }
    for (const b of bins) {
      const used = b.placements.reduce((s, pl) => s + pl.w * pl.h, 0);
      sheets.push({ index: sheets.length + 1, material: matKey, length: m.sheet.length, width: m.sheet.width, placements: b.placements, utilisation: round(used / (m.sheet.length * m.sheet.width), 3) });
    }
  }
  return sheets;
}

function packOnce(sorted: Part[], W: number, H: number, gap: number, trim: number, sheet: { length: number; width: number }) {
  const bins: { mr: MaxRects; placements: Placement[] }[] = [];
  for (const p of sorted) {
    const w = p.length + gap, h = p.width + gap;
    let placed = false;
    for (const bin of [...bins, null]) {
      const target = bin ?? { mr: new MaxRects(W, H), placements: [] as Placement[] };
      const fit = target.mr.find(w, h, !p.grain);
      if (!fit) {
        if (!bin) throw new Error(`${p.name} (${p.length}×${p.width}) does not fit on a ${sheet.length}×${sheet.width} sheet`);
        continue;
      }
      target.mr.place(fit.r);
      target.placements.push({
        partId: p.id, label: p.label ?? "?",
        x: round(fit.r.x + trim), y: round(fit.r.y + trim),
        rotated: fit.rotated, w: fit.rotated ? p.width : p.length, h: fit.rotated ? p.length : p.width,
      });
      if (!bin) bins.push(target);
      placed = true;
      break;
    }
    if (!placed) throw new Error("nesting failed");
  }
  return bins;
}
