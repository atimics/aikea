// Minimal DXF (AutoCAD R12 / AC1009) writer. R12 is the most widely accepted
// flavour for CAM tools (VCarve/Aspire, Fusion, RhinoCAM, SheetCam, Lightburn).
// Units are millimetres. Each machining operation lives on its own layer whose
// name encodes the operation, so shops can map layers to toolpaths directly:
//   CUT_OUTLINE              profile cut, full depth, cut on the outside
//   DRILL_D5_Z11             drill Ø5, 11mm deep (face up)
//   DRILL_D7_THRU            drill Ø7 through
//   POCKET_W3.7_Z8           groove/pocket, 8mm deep (closed boundary)
//   HBORE_INFO               horizontal (edge) bores — informational, see notes
//   LABEL                    part letter / name — do not machine
import { round } from "./geometry.js";
import type { Placement, Sheet } from "./nest.js";
import type { Face, Part } from "./types.js";

const n = (v: number) => String(round(v, 3));

class Dxf {
  private ents: string[] = [];
  private layers = new Map<string, number>();
  private colour(layer: string): number {
    if (!this.layers.has(layer)) {
      const c = layer.startsWith("CUT") ? 7 : layer.startsWith("DRILL") ? 1 : layer.startsWith("POCKET") ? 5 : layer.startsWith("HBORE") ? 3 : 8;
      this.layers.set(layer, c);
    }
    return this.layers.get(layer)!;
  }
  poly(layer: string, pts: [number, number][]) {
    this.colour(layer);
    this.ents.push("0", "POLYLINE", "8", layer, "66", "1", "10", "0", "20", "0", "30", "0", "70", "1");
    for (const [x, y] of pts) this.ents.push("0", "VERTEX", "8", layer, "10", n(x), "20", n(y), "30", "0");
    this.ents.push("0", "SEQEND", "8", layer);
  }
  rect(layer: string, x0: number, y0: number, x1: number, y1: number) {
    this.poly(layer, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  }
  circle(layer: string, x: number, y: number, r: number) {
    this.colour(layer);
    this.ents.push("0", "CIRCLE", "8", layer, "10", n(x), "20", n(y), "30", "0", "40", n(r));
  }
  line(layer: string, x0: number, y0: number, x1: number, y1: number) {
    this.colour(layer);
    this.ents.push("0", "LINE", "8", layer, "10", n(x0), "20", n(y0), "30", "0", "11", n(x1), "21", n(y1), "31", "0");
  }
  text(layer: string, x: number, y: number, h: number, s: string) {
    this.colour(layer);
    this.ents.push("0", "TEXT", "8", layer, "10", n(x), "20", n(y), "30", "0", "40", n(h), "1", s.replace(/[\r\n]/g, " "));
  }
  toString(): string {
    const out = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "4", "9", "$MEASUREMENT", "70", "1", "0", "ENDSEC"];
    out.push("0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", String(this.layers.size));
    for (const [name, c] of this.layers) out.push("0", "LAYER", "2", name, "70", "0", "62", String(c), "6", "CONTINUOUS");
    out.push("0", "ENDTAB", "0", "ENDSEC");
    out.push("0", "SECTION", "2", "ENTITIES", ...this.ents, "0", "ENDSEC", "0", "EOF");
    return out.join("\r\n") + "\r\n";
  }
}

type XY = (x: number, y: number) => [number, number];

export function drillLayer(dia: number, depth: number, thickness: number) {
  return depth >= thickness - 0.01 ? `DRILL_D${n(dia)}_THRU` : `DRILL_D${n(dia)}_Z${n(depth)}`;
}

/** Operations visible from `face`, through holes included on both faces. */
function drawOps(d: Dxf, p: Part, face: Face, tf: XY) {
  for (const h of p.holes) {
    const through = h.depth >= p.thickness - 0.01;
    // Through holes are drilled once, from face A; blind holes only on their own face.
    if (through ? face !== "A" : h.face !== face) continue;
    const [x, y] = tf(h.x, h.y);
    d.circle(drillLayer(h.dia, h.depth, p.thickness), x, y, h.dia / 2);
  }
  for (const g of p.grooves) {
    if (g.face !== face) continue;
    const horiz = Math.abs(g.y1 - g.y0) < 0.01;
    const hw = g.width / 2;
    const [ax, ay] = tf(horiz ? Math.min(g.x0, g.x1) : g.x0 - hw, horiz ? g.y0 - hw : Math.min(g.y0, g.y1));
    const [bx, by] = tf(horiz ? Math.max(g.x0, g.x1) : g.x0 + hw, horiz ? g.y0 + hw : Math.max(g.y0, g.y1));
    d.rect(`POCKET_W${n(g.width)}_Z${n(g.depth)}`, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
  }
}

function drawEdgeBores(d: Dxf, p: Part, tf: XY) {
  for (const b of p.edgeBores) {
    let s: [number, number], e: [number, number];
    switch (b.edge) {
      case "W0": s = [0, b.along]; e = [b.depth, b.along]; break;
      case "W1": s = [p.length, b.along]; e = [p.length - b.depth, b.along]; break;
      case "L0": s = [b.along, 0]; e = [b.along, b.depth]; break;
      case "L1": s = [b.along, p.width]; e = [b.along, p.width - b.depth]; break;
    }
    const [x0, y0] = tf(...s), [x1, y1] = tf(...e);
    d.line("HBORE_INFO", x0, y0, x1, y1);
  }
}

export function faceHasOps(p: Part, face: Face): boolean {
  return p.holes.some((h) => h.face === face && h.depth < p.thickness - 0.01) || p.grooves.some((g) => g.face === face);
}

/** Single-part DXF viewed from the given face (face B is mirrored across the part's long axis). */
export function partDxf(p: Part, face: Face = "A"): string {
  const d = new Dxf();
  const tf: XY = face === "A" ? (x, y) => [x, y] : (x, y) => [x, p.width - y];
  d.rect("CUT_OUTLINE", 0, 0, p.length, p.width);
  drawOps(d, p, face, tf);
  if (face === "A") drawEdgeBores(d, p, tf);
  const th = Math.min(40, p.width / 4);
  d.text("LABEL", p.length / 2 - th, p.width / 2 - th / 2, th, `${p.label ?? ""}${face === "B" ? " (B)" : ""}`);
  d.text("LABEL", 5, 5, 8, `${p.name} ${p.length}x${p.width}x${p.thickness} face ${face} up${p.grain ? " | grain along X" : ""}`);
  return d.toString();
}

/** Nested sheet DXF: outlines + face-A machining for every part, in sheet coordinates. */
export function sheetDxf(sheet: Sheet, parts: Map<string, Part>): string {
  const d = new Dxf();
  d.rect("SHEET_BOUNDARY", 0, 0, sheet.length, sheet.width);
  for (const pl of sheet.placements) {
    const p = parts.get(pl.partId)!;
    const tf = placementTransform(pl, p);
    const corners = [tf(0, 0), tf(p.length, 0), tf(p.length, p.width), tf(0, p.width)];
    d.poly("CUT_OUTLINE", corners);
    drawOps(d, p, "A", tf);
    drawEdgeBores(d, p, tf);
    const cx = pl.x + pl.w / 2, cy = pl.y + pl.h / 2;
    const th = Math.min(40, Math.min(pl.w, pl.h) / 4);
    d.text("LABEL", cx - th / 2, cy - th / 2, th, p.label ?? "?");
  }
  return d.toString();
}

export function placementTransform(pl: Placement, p: Part): XY {
  return pl.rotated ? (x, y) => [pl.x + (p.width - y), pl.y + x] : (x, y) => [pl.x + x, pl.y + y];
}
