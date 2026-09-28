import { EPS, round, toLocal } from "./geometry.js";
import { getMaterial } from "./materials.js";
import type { Edge, Face, HardwareUse, Joinery, Part, Vec3 } from "./types.js";

// Knock-down fitting geometry (mm). Values follow common 15mm cam / 8mm dowel /
// 7x50 confirmat conventions for 16–19mm board.
export const CAM = {
  holeDia: 15,
  inset: 34, // cam centre distance from the joining end of the panel
  boltHoleDia: 5,
  boltBoreDia: 8, // edge bore the bolt head passes through
};
export const DOWEL = { dia: 8, length: 30 };
export const CONFIRMAT = { clearanceDia: 7, length: 50 };
export const SHELF_PIN = { dia: 5, depth: 10 };

export type FastenerKind = "cam" | "dowel" | "confirmat";

/** Standard fastener spacing along a joint of the given length. Offsets are from one end. */
export function fastenerLayout(length: number, joinery: Joinery): { offset: number; kind: FastenerKind }[] {
  const out: { offset: number; kind: FastenerKind }[] = [];
  if (joinery === "confirmat") {
    if (length < 120) return [{ offset: length / 2, kind: "confirmat" }];
    const first = 50;
    const last = length - 50;
    const n = Math.max(1, Math.ceil((last - first) / 250));
    for (let i = 0; i <= n; i++) out.push({ offset: first + ((last - first) * i) / n, kind: "confirmat" });
    return out;
  }
  // cam + dowel
  if (length < 120) return [{ offset: length / 2, kind: "cam" }];
  out.push({ offset: 50, kind: "cam" }, { offset: length - 50, kind: "cam" });
  if (length >= 200) out.push({ offset: 82, kind: "dowel" }, { offset: length - 82, kind: "dowel" });
  if (length >= 600) out.push({ offset: length / 2, kind: "cam" }, { offset: length / 2 + 32, kind: "dowel" });
  else if (length >= 400) out.push({ offset: length / 2, kind: "dowel" });
  return out.sort((a, b) => a.offset - b.offset);
}

function contactFace(p: Part, local: Vec3): Face {
  if (Math.abs(local[2] - p.thickness) < EPS) return "A";
  if (Math.abs(local[2]) < EPS) return "B";
  throw new Error(`Joint point is not on a face of ${p.id} (local z=${local[2]})`);
}

function edgeAt(p: Part, local: Vec3): { edge: Edge; along: number } {
  if (Math.abs(local[2] - p.thickness / 2) > 0.5) {
    throw new Error(`Joint point is not at mid-thickness of ${p.id} (local z=${local[2]})`);
  }
  if (Math.abs(local[0]) < EPS) return { edge: "W0", along: local[1] };
  if (Math.abs(local[0] - p.length) < EPS) return { edge: "W1", along: local[1] };
  if (Math.abs(local[1]) < EPS) return { edge: "L0", along: local[0] };
  if (Math.abs(local[1] - p.width) < EPS) return { edge: "L1", along: local[0] };
  throw new Error(`Joint point is not on an edge of ${p.id} (local ${local.map((v) => round(v)).join(",")})`);
}

function insetPoint(p: Part, edge: Edge, along: number, inset: number): [number, number] {
  switch (edge) {
    case "W0": return [inset, along];
    case "W1": return [p.length - inset, along];
    case "L0": return [along, inset];
    case "L1": return [along, p.width - inset];
  }
}

const other = (f: Face): Face => (f === "A" ? "B" : "A");

/**
 * Butt joint: the end/edge of `edgePart` meets a face of `facePart`.
 * `points` are world coordinates on the contact plane, at the mid-thickness of
 * `edgePart`, one per fastener. Machining is added to both parts; the hardware
 * consumed is returned.
 */
export function buttJoint(opts: {
  facePart: Part;
  edgePart: Part;
  points: { at: Vec3; kind: FastenerKind }[];
  camFace?: Face; // which face of edgePart receives the cam housing
}): HardwareUse[] {
  const { facePart: fp, edgePart: ep } = opts;
  const camFace = opts.camFace ?? "A";
  const hw: Record<string, number> = {};
  const bump = (k: string, n = 1) => (hw[k] = (hw[k] ?? 0) + n);

  for (const { at, kind } of opts.points) {
    const lf = toLocal(fp, at);
    const face = contactFace(fp, lf);
    const le = toLocal(ep, at);
    const { edge, along } = edgeAt(ep, le);
    const [fx, fy] = [round(lf[0]), round(lf[1])];

    if (kind === "cam") {
      if (ep.thickness < 15) throw new Error(`${ep.id}: cam fittings need board ≥ 15mm`);
      fp.holes.push({ x: fx, y: fy, dia: CAM.boltHoleDia, depth: round(Math.min(11, fp.thickness - 4)), face, purpose: "cam bolt" });
      const [cx, cy] = insetPoint(ep, edge, along, CAM.inset);
      ep.holes.push({ x: round(cx), y: round(cy), dia: CAM.holeDia, depth: round(Math.min(13.5, ep.thickness * 0.75)), face: camFace, purpose: "cam housing" });
      ep.edgeBores.push({ edge, along: round(along), dia: CAM.boltBoreDia, depth: CAM.inset, purpose: "cam bolt" });
      bump("cam15");
      bump("cam_bolt");
    } else if (kind === "dowel") {
      const faceDepth = round(Math.min(12, fp.thickness - 5));
      fp.holes.push({ x: fx, y: fy, dia: DOWEL.dia, depth: faceDepth, face, purpose: "dowel" });
      ep.edgeBores.push({ edge, along: round(along), dia: DOWEL.dia, depth: round(DOWEL.length - faceDepth + 2), purpose: "dowel" });
      bump("dowel8x30");
    } else {
      const pilot = getMaterial(ep.material).pilotDia || 5;
      // Through hole, countersunk on the outside (the face opposite the contact face).
      fp.holes.push({ x: fx, y: fy, dia: CONFIRMAT.clearanceDia, depth: fp.thickness, face: other(face), purpose: "confirmat clearance + countersink" });
      ep.edgeBores.push({ edge, along: round(along), dia: pilot, depth: round(CONFIRMAT.length - fp.thickness + 5), purpose: "confirmat pilot" });
      bump("confirmat7x50");
    }
  }
  return Object.entries(hw).map(([key, qty]) => ({ key: key as HardwareUse["key"], qty }));
}

/** Add a groove to a part given a world-space centre line lying on one of its faces. */
export function grooveWorld(p: Part, a: Vec3, b: Vec3, width: number, depth: number, purpose: string) {
  const la = toLocal(p, a);
  const lb = toLocal(p, b);
  const face = contactFace(p, la);
  if (contactFace(p, lb) !== face) throw new Error(`Groove on ${p.id} changes face`);
  const clamp = (v: number, max: number) => round(Math.min(Math.max(v, 0), max));
  p.grooves.push({
    face,
    x0: clamp(la[0], p.length),
    y0: clamp(la[1], p.width),
    x1: clamp(lb[0], p.length),
    y1: clamp(lb[1], p.width),
    width: round(width),
    depth: round(depth),
    purpose,
  });
}

/** Add a blind face hole at a world point lying on a face of the part. */
export function holeWorld(p: Part, at: Vec3, dia: number, depth: number, purpose: string) {
  const l = toLocal(p, at);
  const face = contactFace(p, l);
  p.holes.push({ x: round(l[0]), y: round(l[1]), dia, depth, face, purpose });
}

export function mergeHardware(...lists: HardwareUse[][]): HardwareUse[] {
  const m = new Map<string, number>();
  for (const l of lists) for (const h of l) m.set(h.key, (m.get(h.key) ?? 0) + h.qty);
  return [...m.entries()].map(([key, qty]) => ({ key: key as HardwareUse["key"], qty }));
}
