import { z } from "zod";
import { edgeFacing, placePart, round } from "../geometry.js";
import { buttJoint, fastenerLayout, grooveWorld, holeWorld, mergeHardware, SHELF_PIN } from "../joinery.js";
import { getMaterial } from "../materials.js";
import type { AssemblyStep, HardwareUse, Issue, Part, Vec3 } from "../types.js";
import { LOADS, type SagCheck, type TemplateResult } from "./common.js";

export const CarcassParams = z.object({
  width: z.number().min(250).max(2400).describe("Overall width, mm"),
  height: z.number().min(250).max(2400).describe("Overall height, mm"),
  depth: z.number().min(150).max(800).describe("Overall depth, mm"),
  material: z.string().default("baltic_birch_18").describe("Carcass board (see aikea_list_options)"),
  backMaterial: z.string().nullable().default("hardboard_3").describe("Back panel board, or null for an open back"),
  fixedShelves: z.number().int().min(0).max(12).default(0).describe("Fixed (structural) shelves, evenly spaced"),
  fixedShelfHeights: z.array(z.number()).optional().describe("Optional explicit heights (mm from floor to top of shelf) for fixed shelves; overrides fixedShelves"),
  adjustableShelves: z.number().int().min(0).max(20).default(0).describe("Adjustable shelves on 5mm shelf pins"),
  plinthHeight: z.number().min(0).max(200).default(0).describe("Toe-kick/plinth height; 0 = bottom panel on the floor"),
  joinery: z.enum(["cam_dowel", "confirmat"]).default("cam_dowel"),
  load: z.enum(["light", "books", "heavy"]).default("books"),
  edgeBandFronts: z.boolean().optional().describe("Band front edges (default: yes, except Baltic birch)"),
});
export type CarcassParams = z.infer<typeof CarcassParams>;

const BACK_INSET = 10; // groove distance from the back edge
const FRONT = [0, 1, 0] as Vec3;

export function buildCarcass(input: CarcassParams): TemplateResult {
  const p = CarcassParams.parse(input);
  const mat = getMaterial(p.material);
  const t = mat.thickness;
  const W = p.width, H = p.height, D = p.depth, K = p.plinthHeight;
  const issues: Issue[] = [];
  const parts: Part[] = [];
  const band = p.edgeBandFronts ?? !mat.key.startsWith("baltic");

  if (W < 2 * t + 150) throw new Error(`Width must be at least ${2 * t + 150}mm for ${t}mm board`);
  if (K > 0 && K < 50) throw new Error("plinthHeight must be 0 or at least 50mm");
  if (H < K + 2 * t + 100) throw new Error("Height too small for top, bottom and plinth");

  const back = p.backMaterial ? getMaterial(p.backMaterial) : null;
  const bt = back?.thickness ?? 0;
  const grooveW = back ? round(bt + 0.5, 1) : 0;
  const grooveD = back ? Math.min(8, Math.floor(t / 2) - 1) : 0;
  const backClear = back ? BACK_INSET + grooveW : 0; // depth lost behind shelves
  const shelfDepth = D - backClear;

  const mk = (o: Parameters<typeof placePart>[0]) => {
    const part = placePart(o);
    if (band) {
      const e = edgeFacing(part, FRONT);
      if (e) part.edgeBand[e] = true;
    }
    parts.push(part);
    return part;
  };
  const common = { material: mat.key, grain: mat.grain };

  const left = mk({ ...common, id: "side_left", name: "Side panel (left)", min: [0, 0, 0], size: [t, D, H], xAxis: "+Z", yAxis: "-Y" });
  const right = mk({ ...common, id: "side_right", name: "Side panel (right)", min: [W - t, 0, 0], size: [t, D, H], xAxis: "+Z", yAxis: "+Y" });
  const bottom = mk({ ...common, id: "bottom", name: "Bottom panel", min: [t, 0, K], size: [W - 2 * t, D, t], xAxis: "+X", yAxis: "+Y" });
  const top = mk({ ...common, id: "top", name: "Top panel", min: [t, 0, H - t], size: [W - 2 * t, D, t], xAxis: "+X", yAxis: "-Y" });
  const plinth = K > 0
    ? mk({ ...common, id: "plinth", name: "Plinth (toe kick)", min: [t, D - t, 0], size: [W - 2 * t, t, K], xAxis: "+X", yAxis: "+Z" })
    : null;

  // Fixed shelves: z = bottom face of each shelf
  const zFloor = K + t; // top of bottom panel
  const zCeil = H - t; // underside of top panel
  let fixedZ: number[];
  if (p.fixedShelfHeights?.length) {
    fixedZ = [...p.fixedShelfHeights].sort((a, b) => a - b).map((h) => h - t);
    for (const z of fixedZ) {
      if (z < zFloor + 80 || z + t > zCeil - 80) throw new Error(`Fixed shelf at ${z + t}mm is too close to the top or bottom`);
    }
  } else {
    const f = p.fixedShelves;
    const bay = (zCeil - zFloor - f * t) / (f + 1);
    fixedZ = Array.from({ length: f }, (_, i) => zFloor + (i + 1) * bay + i * t);
  }
  fixedZ = fixedZ.map((z) => round(z));
  const fixed = fixedZ.map((z, i) =>
    mk({ ...common, id: `shelf_fixed_${i + 1}`, name: "Fixed shelf", min: [t, backClear, z], size: [W - 2 * t, shelfDepth, t], xAxis: "+X", yAxis: "-Y" }),
  );

  // Joints: horizontal panels to both sides
  const hwLeft: HardwareUse[][] = [];
  const hwRight: HardwareUse[][] = [];
  const horizontal: { part: Part; y0: number; depth: number; z: number; camFace: "A" }[] = [
    { part: bottom, y0: 0, depth: D, z: K + t / 2, camFace: "A" },
    { part: top, y0: 0, depth: D, z: H - t / 2, camFace: "A" },
    ...fixed.map((f, i) => ({ part: f, y0: backClear, depth: shelfDepth, z: fixedZ[i] + t / 2, camFace: "A" as const })),
  ];
  for (const h of horizontal) {
    const layout = fastenerLayout(h.depth, p.joinery);
    hwLeft.push(buttJoint({ facePart: left, edgePart: h.part, camFace: h.camFace, points: layout.map((f) => ({ at: [t, h.y0 + f.offset, h.z] as Vec3, kind: f.kind })) }));
    hwRight.push(buttJoint({ facePart: right, edgePart: h.part, camFace: h.camFace, points: layout.map((f) => ({ at: [W - t, h.y0 + f.offset, h.z] as Vec3, kind: f.kind })) }));
  }
  if (plinth) {
    const layout = fastenerLayout(K, p.joinery);
    const y = D - t / 2;
    hwLeft.push(buttJoint({ facePart: left, edgePart: plinth, points: layout.map((f) => ({ at: [t, y, f.offset] as Vec3, kind: f.kind })) }));
    hwRight.push(buttJoint({ facePart: right, edgePart: plinth, points: layout.map((f) => ({ at: [W - t, y, f.offset] as Vec3, kind: f.kind })) }));
  }

  // Back panel in a stopped groove on the sides and a through groove in top/bottom
  let backPart: Part | null = null;
  if (back) {
    const yc = BACK_INSET + grooveW / 2;
    const zLo = K + t - grooveD, zHi = H - t + grooveD;
    grooveWorld(left, [t, yc, zLo], [t, yc, zHi], grooveW, grooveD, "back panel groove (stopped)");
    grooveWorld(right, [W - t, yc, zLo], [W - t, yc, zHi], grooveW, grooveD, "back panel groove (stopped)");
    grooveWorld(bottom, [t, yc, K + t], [W - t, yc, K + t], grooveW, grooveD, "back panel groove");
    grooveWorld(top, [t, yc, H - t], [W - t, yc, H - t], grooveW, grooveD, "back panel groove");
    const clearance = 1;
    backPart = placePart({
      id: "back", name: "Back panel", material: back.key, grain: back.grain,
      min: [t - grooveD + clearance, BACK_INSET + 0.25, zLo + clearance],
      size: [W - 2 * t + 2 * (grooveD - clearance), bt, zHi - zLo - 2 * clearance],
      xAxis: "+Z", yAxis: "+X",
    });
    parts.push(backPart);
  } else if (H > 900) {
    issues.push({ level: "warn", code: "no_back_racking", message: "Open-back carcass over 900mm tall has little racking resistance; add a back panel or fixed shelves and anchor it to the wall." });
  }

  // Shelf pin holes and adjustable shelves
  const adjustable: Part[] = [];
  if (p.adjustableShelves > 0) {
    const cols = [D - 37, backClear + 37];
    const fixedCentres = fixedZ.map((z) => z + t / 2);
    const rows: number[] = [];
    for (let z = zFloor + 64; z <= zCeil - 64; z += 32) {
      if (fixedCentres.every((c) => Math.abs(z - c) > t / 2 + 40)) rows.push(z);
    }
    if (rows.length === 0) {
      issues.push({ level: "error", code: "no_pin_rows", message: "No room for shelf-pin rows; remove adjustable shelves or increase height." });
    }
    for (const z of rows)
      for (const y of cols) {
        holeWorld(left, [t, y, z], SHELF_PIN.dia, SHELF_PIN.depth, "shelf pin");
        holeWorld(right, [W - t, y, z], SHELF_PIN.dia, SHELF_PIN.depth, "shelf pin");
      }
    // Distribute adjustable shelves into bays, resting on the nearest pin row
    const bounds = [zFloor, ...fixedZ.flatMap((z) => [z, z + t]), zCeil];
    const bays: [number, number][] = [];
    for (let i = 0; i < bounds.length; i += 2) bays.push([bounds[i], bounds[i + 1]]);
    const perBay = bays.map(() => 0);
    for (let i = 0; i < p.adjustableShelves; i++) perBay[i % bays.length]++;
    let n = 0;
    bays.forEach(([lo, hi], bi) => {
      const k = perBay[bi];
      for (let j = 1; j <= k; j++) {
        const target = lo + ((hi - lo) * j) / (k + 1);
        const bayRows = rows.filter((r) => r > lo && r < hi - t - 30);
        if (!bayRows.length) return;
        const r = bayRows.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
        const zRest = r + SHELF_PIN.dia / 2 + 1; // pin top
        adjustable.push(
          mk({ ...common, id: `shelf_adj_${++n}`, name: "Adjustable shelf", min: [t + 1, backClear + 1, round(zRest)], size: [W - 2 * t - 2, shelfDepth - 3, t], xAxis: "+X", yAxis: "+Y" }),
        );
      }
    });
    if (n < p.adjustableShelves) {
      issues.push({ level: "warn", code: "shelves_dropped", message: `Only ${n} of ${p.adjustableShelves} adjustable shelves fit between the fixed shelves.` });
    }
  }

  // Sag checks: span between sides for every shelf that carries load
  const span = W - 2 * t;
  const load = LOADS[p.load].kPa;
  const sagChecks: SagCheck[] = [bottom, ...fixed, ...adjustable].map((s) => ({
    partId: s.id, span: s.id.startsWith("shelf_adj") ? span - 2 : span, depth: s.width, thickness: t, material: mat.key, loadKPa: load,
  }));

  // Assembly steps
  const hwL = mergeHardware(...hwLeft);
  const hwR = mergeHardware(...hwRight);
  const pick = (hw: HardwareUse[], keys: string[]) => hw.filter((h) => keys.includes(h.key));
  const steps: AssemblyStep[] = [];
  const panelIds = [bottom.id, ...(plinth ? [plinth.id] : []), ...fixed.map((f) => f.id), top.id];
  if (p.joinery === "cam_dowel") {
    steps.push({
      title: "Prepare the side panels",
      text: "Screw a cam bolt into every 5mm hole on the inside faces of both side panels. Tap a dowel into every 8mm hole (a drop of glue makes it permanent). Lay the left side panel flat, inside face up.",
      parts: [left.id],
      hardware: mergeHardware(pick(hwL, ["cam_bolt", "dowel8x30"]), pick(hwR, ["cam_bolt", "dowel8x30"])),
      hint: "lay_flat",
    });
    steps.push({
      title: "Fit panels to the left side",
      text: "Push the bottom, top" + (plinth ? ", plinth" : "") + (fixed.length ? " and fixed shelves" : "") + " onto the dowels and bolts. Drop a cam into each 15mm hole with the arrow pointing at the bolt and turn it clockwise until snug.",
      parts: panelIds,
      hardware: pick(hwL, ["cam15"]),
    });
  } else {
    steps.push({
      title: "Lay out the left side",
      text: "Lay the left side panel flat, inside face up (countersinks facing the floor).",
      parts: [left.id],
      hardware: [],
      hint: "lay_flat",
    });
    steps.push({
      title: "Screw panels to the left side",
      text: "Stand the bottom, top" + (plinth ? ", plinth" : "") + (fixed.length ? " and fixed shelves" : "") + " on edge against the side. Roll the assembly so you can drive a confirmat screw through each countersunk hole into the panel edges.",
      parts: panelIds,
      hardware: hwL,
      hint: "two_people",
    });
  }
  if (backPart) {
    steps.push({
      title: "Slide in the back panel",
      text: "Slide the back panel into the grooves in the top, bottom and left side, finished side facing forward.",
      parts: [backPart.id],
      hardware: [],
    });
  }
  steps.push({
    title: "Close with the right side",
    text: p.joinery === "cam_dowel"
      ? "Lower the right side panel onto the dowels and bolts. Insert the remaining cams and tighten all cams a half turn clockwise."
      : "Lower the right side onto the panel edges (and back panel) and drive the remaining confirmat screws.",
    parts: [right.id],
    hardware: p.joinery === "cam_dowel" ? pick(hwR, ["cam15"]) : hwR,
    hint: p.joinery === "cam_dowel" ? "tighten_cams" : undefined,
  });
  if (adjustable.length) {
    steps.push({
      title: "Stand it up and add shelves",
      text: "With a helper, stand the unit upright. Push four shelf pins in at the height you want and rest each adjustable shelf on them.",
      parts: adjustable.map((a) => a.id),
      hardware: [{ key: "shelf_pin5", qty: adjustable.length * 4 }],
      hint: "two_people",
    });
  }
  const tipOverRisk = H >= 760 || H / D > 3;
  steps.push({
    title: tipOverRisk ? "Anchor it to the wall" : "Finish",
    text: tipOverRisk
      ? "Tip-over hazard. Fix the anti-tip strap to the underside of the top panel and to a wall stud with fasteners suited to your wall."
      : "Stick felt pads under the side panels to protect the floor.",
    parts: [],
    hardware: tipOverRisk ? [{ key: "anti_tip_kit", qty: 1 }, { key: "felt_pad", qty: 4 }] : [{ key: "felt_pad", qty: 4 }],
    hint: tipOverRisk ? "wall_anchor" : undefined,
  });

  if (tipOverRisk) {
    issues.push({ level: "warn", code: "tip_over", message: `Height ${H}mm on a ${D}mm base can tip; an anti-tip kit is included and must be anchored to the wall.` });
  }
  if (p.joinery === "cam_dowel" && D < 150) {
    issues.push({ level: "warn", code: "shallow", message: "Very shallow carcass leaves little room for cam fittings." });
  }

  return { overall: { width: W, depth: D, height: H }, parts, steps, issues, sagChecks, tipOverRisk };
}
