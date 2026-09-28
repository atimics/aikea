import { round } from "./geometry.js";
import { getMaterial } from "./materials.js";
import type { Design, Edge, HardwareKey, Part } from "./types.js";

export const HARDWARE: Record<HardwareKey, { name: string; spec: string; search: string; spares: boolean }> = {
  cam15: { name: "Cam lock housing", spec: "Ø15mm zinc cam for 16–19mm board (Minifix-style), 34mm drilling distance", search: "15mm cam lock connector minifix", spares: true },
  cam_bolt: { name: "Cam bolt", spec: "Connecting bolt for Ø15 cam, 34mm drilling distance, Ø5mm wood thread", search: "cam bolt 34mm 5mm thread connecting bolt", spares: true },
  dowel8x30: { name: "Wood dowel", spec: "Fluted beech dowel Ø8 × 30mm", search: "8x30 fluted beech dowel", spares: true },
  confirmat7x50: { name: "Confirmat screw", spec: "7 × 50mm confirmat screw, 4mm hex drive", search: "7x50 confirmat screw", spares: true },
  shelf_pin5: { name: "Shelf pin", spec: "Ø5mm shelf support pin, metal", search: "5mm shelf pin support", spares: true },
  anti_tip_kit: { name: "Anti-tip kit", spec: "Furniture anti-tip strap/bracket with wall + cabinet fasteners (wall plugs to suit your wall)", search: "furniture anti tip kit", spares: false },
  felt_pad: { name: "Felt pad", spec: "Self-adhesive felt pad, ~20mm", search: "felt furniture pads", spares: false },
  wood_glue: { name: "Wood glue", spec: "PVA wood glue (optional, for permanent dowels)", search: "PVA wood glue", spares: false },
};

export interface BomLine { key: HardwareKey; name: string; spec: string; qty: number; spares: number; order: number; search: string }

export function hardwareBom(d: Design): BomLine[] {
  const totals = new Map<HardwareKey, number>();
  for (const s of d.steps) for (const h of s.hardware) totals.set(h.key, (totals.get(h.key) ?? 0) + h.qty);
  return [...totals.entries()].map(([key, qty]) => {
    const hw = HARDWARE[key];
    const spares = hw.spares ? Math.max(2, Math.ceil(qty * 0.1)) : 0;
    return { key, name: hw.name, spec: hw.spec, qty, spares, order: qty + spares, search: hw.search };
  });
}

export interface CutListRow {
  label: string; name: string; qty: number; length: number; width: number; thickness: number;
  material: string; grain: string; edgeBand: string; faceOps: number; faceBOps: number; edgeBores: number; grooves: number; notes: string;
}

const edgeLen = (p: Part, e: Edge) => (e === "L0" || e === "L1" ? p.length : p.width);

export function cutList(d: Design): CutListRow[] {
  const groups = new Map<string, Part[]>();
  for (const p of d.parts) groups.set(p.label!, [...(groups.get(p.label!) ?? []), p]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, ps]) => {
    const p = ps[0];
    const bands = (Object.keys(p.edgeBand) as Edge[]).filter((e) => p.edgeBand[e]);
    const faceB = p.holes.filter((h) => h.face === "B" && h.depth < p.thickness).length + p.grooves.filter((g) => g.face === "B").length;
    const csk = p.holes.filter((h) => h.purpose.startsWith("confirmat")).length;
    const notes = [
      ...p.notes,
      ...(csk ? [`countersink ${csk} confirmat holes on face ${p.holes.find((h) => h.purpose.startsWith("confirmat"))!.face}`] : []),
      ...(p.edgeBores.length ? ["edge bores: see HBORE_INFO layer / SHOP_NOTES"] : []),
    ].join("; ");
    return {
      label, name: p.name, qty: ps.length, length: p.length, width: p.width, thickness: p.thickness,
      material: getMaterial(p.material).name, grain: p.grain ? "along length" : "any",
      edgeBand: bands.map((e) => `${e}(${edgeLen(p, e)})`).join(" ") || "-",
      faceOps: p.holes.length + p.grooves.length, faceBOps: faceB, edgeBores: p.edgeBores.length, grooves: p.grooves.length, notes,
    };
  });
}

export interface MachiningMetrics {
  parts: number; uniqueParts: number; profileCutM: number; holes: number; edgeBores: number; grooveM: number; edgeBandM: number; weightKg: number;
}

export function machiningMetrics(d: Design): MachiningMetrics {
  let cut = 0, holes = 0, bores = 0, groove = 0, band = 0, kg = 0;
  for (const p of d.parts) {
    cut += 2 * (p.length + p.width);
    holes += p.holes.length;
    bores += p.edgeBores.length;
    groove += p.grooves.reduce((s, g) => s + Math.hypot(g.x1 - g.x0, g.y1 - g.y0), 0);
    band += (Object.keys(p.edgeBand) as Edge[]).filter((e) => p.edgeBand[e]).reduce((s, e) => s + edgeLen(p, e), 0);
    kg += (p.length * p.width * p.thickness * 1e-9) * getMaterial(p.material).densityKgM3;
  }
  return {
    parts: d.parts.length,
    uniqueParts: new Set(d.parts.map((p) => p.label)).size,
    profileCutM: round(cut / 1000, 2), holes, edgeBores: bores, grooveM: round(groove / 1000, 2), edgeBandM: round(band / 1000, 2), weightKg: round(kg, 1),
  };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const q = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n") + "\n";
}
