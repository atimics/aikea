import { round, worldBox } from "./geometry.js";
import type { Placement, Sheet } from "./nest.js";
import type { Design, Part, Vec3 } from "./types.js";

const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;
// Isometric view from the front-right, above. Visible faces: +X (right), +Y (front), +Z (top).
const proj = (p: Vec3): [number, number] => [(p[0] - p[1]) * C30, (p[0] + p[1]) * S30 - p[2]];

interface Box { part: Part; min: Vec3; max: Vec3 }

function drawOrder(boxes: Box[]): Box[] {
  const eps = 0.5;
  const behind = (a: Box, b: Box) => [0, 1, 2].some((k) => a.max[k] <= b.min[k] + eps);
  const n = boxes.length;
  const indeg = new Array(n).fill(0);
  const adj: number[][] = boxes.map(() => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j && behind(boxes[i], boxes[j]) && !behind(boxes[j], boxes[i])) { adj[i].push(j); indeg[j]++; }
  const out: Box[] = [];
  const done = new Array(n).fill(false);
  const depth = (b: Box) => b.min[0] + b.min[1] + b.min[2];
  while (out.length < n) {
    let pick = -1;
    for (let i = 0; i < n; i++) if (!done[i] && indeg[i] === 0 && (pick < 0 || depth(boxes[i]) < depth(boxes[pick]))) pick = i;
    if (pick < 0) for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || depth(boxes[i]) < depth(boxes[pick]))) pick = i; // cycle: break it
    done[pick] = true;
    out.push(boxes[pick]);
    for (const j of adj[pick]) indeg[j]--;
  }
  return out;
}

const PALETTE = {
  newTop: "#f3d9b1", newFront: "#e2b97f", newSide: "#cf9f5f", newStroke: "#5b3a12",
  oldTop: "#f1f1ef", oldFront: "#dcdcd8", oldSide: "#c8c8c3", oldStroke: "#77776f",
};

export interface IsoOptions {
  highlight?: Set<string>; // part ids drawn in wood colour; others grey
  hide?: Set<string>;
  labels?: boolean;
  dims?: boolean;
  width?: number; // px (maximum)
  maxHeight?: number; // px
  title?: string;
  explode?: number; // millimetres of space between panels, for inspection
  background?: string;
}

export function isoSvg(design: Design, parts: Part[], opts: IsoOptions = {}): string {
  const box = (p: Part) => {
    const b = worldBox(p);
    if (opts.explode) {
      const centre = [design.overall.width / 2, design.overall.depth / 2, design.overall.height / 2];
      for (const k of [0, 1, 2] as const) {
        const shift = (((b.min[k] + b.max[k]) / 2 - centre[k]) / Math.max(centre[k], 1)) * opts.explode;
        b.min[k] += shift;
        b.max[k] += shift;
      }
    }
    return b;
  };
  const boxes: Box[] = parts.filter((p) => !opts.hide?.has(p.id)).map((p) => ({ part: p, ...box(p) }));
  const all = (parts.length ? parts : design.parts).map(box);
  const pts: [number, number][] = [];
  for (const b of all)
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(proj([x, y, z]));
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  const pad = 70;
  const Wmax = opts.width ?? 560;
  const top0 = opts.title ? 30 : 0;
  let s = (Wmax - 2 * pad) / Math.max(maxX - minX, 1);
  if (opts.maxHeight) s = Math.min(s, (opts.maxHeight - 2 * pad - top0) / Math.max(maxY - minY, 1));
  const W = Math.ceil((maxX - minX) * s + 2 * pad);
  const H = Math.ceil((maxY - minY) * s + 2 * pad + top0);
  const top = opts.title ? 30 : 0;
  const P = (p: Vec3) => {
    const [x, y] = proj(p);
    return [round((x - minX) * s + pad, 1), round((y - minY) * s + pad + top, 1)] as [number, number];
  };
  const poly = (ps: Vec3[], fill: string, stroke: string) =>
    `<polygon points="${ps.map((p) => P(p).join(",")).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="1" stroke-linejoin="round"/>`;

  const body: string[] = [];
  const labelSpots: { x: number; y: number; label: string }[] = [];
  for (const b of drawOrder(boxes)) {
    const hl = !opts.highlight || opts.highlight.has(b.part.id);
    const c = hl ? { t: PALETTE.newTop, f: PALETTE.newFront, s: PALETTE.newSide, k: PALETTE.newStroke } : { t: PALETTE.oldTop, f: PALETTE.oldFront, s: PALETTE.oldSide, k: PALETTE.oldStroke };
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    body.push(poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], c.t, c.k)); // top
    body.push(poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], c.f, c.k)); // front
    body.push(poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], c.s, c.k)); // right
    if (hl && opts.labels !== false && opts.highlight) {
      const ex = [x1 - x0, y1 - y0, z1 - z0];
      // put the label on the visible face with the largest area
      const faces: [number, Vec3][] = [
        [ex[0] * ex[1], [(x0 + x1) / 2, (y0 + y1) / 2, z1]],
        [ex[0] * ex[2], [(x0 + x1) / 2, y1, (z0 + z1) / 2]],
        [ex[1] * ex[2], [x1, (y0 + y1) / 2, (z0 + z1) / 2]],
      ];
      const [, at] = faces.sort((a, b) => b[0] - a[0])[0];
      const [lx, ly] = P(at);
      labelSpots.push({ x: lx, y: ly, label: b.part.label ?? "" });
    }
  }
  // Leader-free labels: a circle with the part letter
  const labels = labelSpots.map((l) =>
    `<g><circle cx="${l.x}" cy="${l.y}" r="13" fill="#fff" stroke="#111" stroke-width="1.5"/><text x="${l.x}" y="${l.y + 5}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="14" font-weight="700" fill="#111">${l.label}</text></g>`,
  );
  const dims: string[] = [];
  if (opts.dims) {
    const { width: Wd, depth: D, height: Ht } = design.overall;
    const zb = Math.min(...all.map((b) => b.min[2]));
    const xb = Math.min(...all.map((b) => b.min[0]));
    const t = (a: Vec3, b: Vec3, label: string, dx: number, dy: number) => {
      const [ax, ay] = P(a), [bx, by] = P(b);
      dims.push(`<line x1="${ax + dx}" y1="${ay + dy}" x2="${bx + dx}" y2="${by + dy}" stroke="#2a6fdb" stroke-width="1" marker-start="url(#arr)" marker-end="url(#arr)"/>`);
      dims.push(`<text x="${(ax + bx) / 2 + dx * 1.9}" y="${(ay + by) / 2 + dy * 1.9 + 4}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#2a6fdb">${label}</text>`);
    };
    t([xb, D, zb], [xb + Wd, D, zb], `${Wd}`, 0, 22);
    t([xb, D, zb], [xb, D, zb + Ht], `${Ht}`, -22, 0);
    t([xb + Wd, 0, zb], [xb + Wd, D, zb], `${D}`, 18, 14);
  }
  const titleEl = opts.title ? `<text x="${W / 2}" y="22" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="16" font-weight="700" fill="#111">${esc(opts.title)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#2a6fdb"/></marker></defs><rect width="100%" height="100%" fill="${esc(opts.background ?? "#fff")}"/>${titleEl}${body.join("")}${labels.join("")}${dims.join("")}</svg>`;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Flat drawing of a part's face A with machining, used in the parts inventory. */
export function partSvg(p: Part, maxW = 220, maxH = 120): string {
  const s = Math.min(maxW / p.length, maxH / p.width);
  const w = p.length * s, h = p.width * s;
  const Y = (y: number) => round(h - y * s + 4, 1); // y up
  const X = (x: number) => round(x * s + 4, 1);
  const els: string[] = [`<rect x="4" y="4" width="${round(w, 1)}" height="${round(h, 1)}" fill="#f3d9b1" stroke="#5b3a12"/>`];
  for (const g of p.grooves.filter((g) => g.face === "A")) {
    const horiz = Math.abs(g.y1 - g.y0) < 0.01;
    const x0 = horiz ? Math.min(g.x0, g.x1) : g.x0 - g.width / 2, x1 = horiz ? Math.max(g.x0, g.x1) : g.x0 + g.width / 2;
    const y0 = horiz ? g.y0 - g.width / 2 : Math.min(g.y0, g.y1), y1 = horiz ? g.y0 + g.width / 2 : Math.max(g.y0, g.y1);
    els.push(`<rect x="${X(x0)}" y="${Y(y1)}" width="${round(Math.max((x1 - x0) * s, 1), 1)}" height="${round(Math.max((y1 - y0) * s, 1), 1)}" fill="#b98a4e"/>`);
  }
  for (const hole of p.holes.filter((h) => h.face === "A" || h.depth >= p.thickness)) {
    els.push(`<circle cx="${X(hole.x)}" cy="${Y(hole.y)}" r="${round(Math.max((hole.dia / 2) * s, 1.2), 1)}" fill="#fff" stroke="#5b3a12" stroke-width="0.6"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w + 8)}" height="${round(h + 8)}" viewBox="0 0 ${round(w + 8)} ${round(h + 8)}">${els.join("")}</svg>`;
}

/** Sheet nesting diagram. */
export function sheetSvg(sheet: Sheet, parts: Map<string, Part>, width = 640): string {
  const s = width / sheet.length;
  const H = Math.round(sheet.width * s);
  const els = [`<rect x="0" y="0" width="${width}" height="${H}" fill="#fafaf7" stroke="#333"/>`];
  const Y = (y: number, h: number) => round(H - (y + h) * s, 1);
  for (const pl of sheet.placements) {
    const p = parts.get(pl.partId)!;
    els.push(`<rect x="${round(pl.x * s, 1)}" y="${Y(pl.y, pl.h)}" width="${round(pl.w * s, 1)}" height="${round(pl.h * s, 1)}" fill="#f3d9b1" stroke="#5b3a12"/>`);
    const fs = Math.max(9, Math.min(22, Math.min(pl.w, pl.h) * s * 0.4));
    els.push(`<text x="${round((pl.x + pl.w / 2) * s, 1)}" y="${round(Y(pl.y, pl.h) + (pl.h * s) / 2 + fs / 3, 1)}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="${round(fs, 1)}" fill="#3a2508">${p.label}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${els.join("")}</svg>`;
}

export function placementLabel(pl: Placement): string {
  return `${pl.label} @ (${pl.x}, ${pl.y})${pl.rotated ? " rotated 90°" : ""}`;
}
