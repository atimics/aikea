import type { Axis, Edge, Part, Vec3 } from "./types.js";

export const EPS = 0.01;

export function axisVec(a: Axis): Vec3 {
  switch (a) {
    case "+X": return [1, 0, 0];
    case "-X": return [-1, 0, 0];
    case "+Y": return [0, 1, 0];
    case "-Y": return [0, -1, 0];
    case "+Z": return [0, 0, 1];
    case "-Z": return [0, 0, -1];
  }
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3; // face-A normal
}

export function frameOf(p: Part): Frame {
  const x = axisVec(p.xAxis);
  const y = axisVec(p.yAxis);
  return { origin: p.origin, x, y, z: cross(x, y) };
}

export function toLocal(p: Part, w: Vec3): Vec3 {
  const f = frameOf(p);
  const d = sub(w, f.origin);
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
}

export function toWorld(p: Part, l: Vec3): Vec3 {
  const f = frameOf(p);
  return add(add(add(f.origin, scale(f.x, l[0])), scale(f.y, l[1])), scale(f.z, l[2]));
}

/** Axis-aligned world bounding box of a part. */
export function worldBox(p: Part): { min: Vec3; max: Vec3 } {
  const corners: Vec3[] = [];
  for (const lx of [0, p.length])
    for (const ly of [0, p.width])
      for (const lz of [0, p.thickness]) corners.push(toWorld(p, [lx, ly, lz]));
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], c[i]);
      max[i] = Math.max(max[i], c[i]);
    }
  return { min, max };
}

/**
 * Create a part occupying the world box [min, min+size], with the given local
 * axis directions. Length/width/thickness are derived from the box, so the
 * caller cannot get them out of sync with placement.
 */
export function placePart(opts: {
  id: string;
  name: string;
  material: string;
  grain: boolean;
  min: Vec3;
  size: Vec3;
  xAxis: Axis;
  yAxis: Axis;
  edgeBand?: Partial<Record<Edge, boolean>>;
}): Part {
  const x = axisVec(opts.xAxis);
  const y = axisVec(opts.yAxis);
  const z = cross(x, y);
  const extent = (v: Vec3) => Math.abs(dot(v, opts.size));
  const length = extent(x);
  const width = extent(y);
  const thickness = extent(z);
  const origin: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const sign = x[i] + y[i] + z[i]; // exactly one axis is non-zero on each world axis
    origin[i] = sign >= 0 ? opts.min[i] : opts.min[i] + opts.size[i];
  }
  return {
    id: opts.id,
    name: opts.name,
    material: opts.material,
    grain: opts.grain,
    length: round(length),
    width: round(width),
    thickness: round(thickness),
    origin,
    xAxis: opts.xAxis,
    yAxis: opts.yAxis,
    edgeBand: { W0: false, W1: false, L0: false, L1: false, ...opts.edgeBand },
    holes: [],
    edgeBores: [],
    grooves: [],
    notes: [],
  };
}

/** Which local edge of the part a world direction points at. */
export function edgeFacing(p: Part, worldDir: Vec3): Edge | null {
  const f = frameOf(p);
  if (dot(f.x, worldDir) < -0.5) return "W0";
  if (dot(f.x, worldDir) > 0.5) return "W1";
  if (dot(f.y, worldDir) < -0.5) return "L0";
  if (dot(f.y, worldDir) > 0.5) return "L1";
  return null;
}
