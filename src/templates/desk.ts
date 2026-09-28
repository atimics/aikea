import { z } from "zod";
import { edgeFacing, placePart } from "../geometry.js";
import { buttJoint, fastenerLayout, mergeHardware } from "../joinery.js";
import { getMaterial } from "../materials.js";
import type { AssemblyStep, HardwareUse, Issue, Part, Vec3 } from "../types.js";
import { LOADS, type TemplateResult } from "./common.js";

export const DeskParams = z.object({
  width: z.number().min(600).max(2000).describe("Overall width, mm"),
  depth: z.number().min(400).max(900).default(600).describe("Overall depth, mm"),
  height: z.number().min(600).max(1100).default(740).describe("Height to top surface, mm (standing desks ~1050)"),
  material: z.string().default("baltic_birch_18"),
  topOverhang: z.number().min(0).max(150).default(0).describe("How far the top overhangs each leg panel, mm"),
  modestyHeight: z.number().min(150).max(600).default(300).describe("Height of the rear modesty/stiffener panel, mm"),
  modestyInset: z.number().min(0).max(200).default(40).describe("Distance of the modesty panel from the back edge, mm"),
  joinery: z.enum(["cam_dowel", "confirmat"]).default("cam_dowel"),
  edgeBand: z.boolean().optional().describe("Band all visible edges (default: yes, except Baltic birch)"),
});
export type DeskParams = z.infer<typeof DeskParams>;

export function buildDesk(input: DeskParams): TemplateResult {
  const p = DeskParams.parse(input);
  const mat = getMaterial(p.material);
  const t = mat.thickness;
  const W = p.width, D = p.depth, H = p.height, ov = p.topOverhang;
  const band = p.edgeBand ?? !mat.key.startsWith("baltic");
  const issues: Issue[] = [];
  const parts: Part[] = [];
  const common = { material: mat.key, grain: mat.grain };
  const legH = H - t;
  const mh = Math.min(p.modestyHeight, legH - 100);
  const my = p.modestyInset;

  const add = (o: Parameters<typeof placePart>[0], bandDirs: Vec3[] = []) => {
    const part = placePart(o);
    if (band) for (const d of bandDirs) { const e = edgeFacing(part, d); if (e) part.edgeBand[e] = true; }
    parts.push(part);
    return part;
  };

  const top = add({ ...common, id: "top", name: "Desk top", min: [0, 0, legH], size: [W, D, t], xAxis: "+X", yAxis: "-Y" },
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]);
  const legL = add({ ...common, id: "leg_left", name: "Leg panel (left)", min: [ov, 0, 0], size: [t, D, legH], xAxis: "+Z", yAxis: "-Y" }, [[0, 1, 0]]);
  const legR = add({ ...common, id: "leg_right", name: "Leg panel (right)", min: [W - ov - t, 0, 0], size: [t, D, legH], xAxis: "+Z", yAxis: "+Y" }, [[0, 1, 0]]);
  const modesty = add({ ...common, id: "modesty", name: "Modesty panel", min: [ov + t, my, legH - mh], size: [W - 2 * ov - 2 * t, t, mh], xAxis: "+X", yAxis: "+Z" }, [[0, 0, -1]]);

  // Legs <- modesty panel (cams on the back face, facing the wall)
  const lm = fastenerLayout(mh, p.joinery);
  const zm = legH - mh;
  const hwModL = buttJoint({ facePart: legL, edgePart: modesty, points: lm.map((f) => ({ at: [ov + t, my + t / 2, zm + f.offset] as Vec3, kind: f.kind })) });
  const hwModR = buttJoint({ facePart: legR, edgePart: modesty, points: lm.map((f) => ({ at: [W - ov - t, my + t / 2, zm + f.offset] as Vec3, kind: f.kind })) });
  // Top <- legs (cams on the leg inside faces near the top)
  const ll = fastenerLayout(D, p.joinery);
  const hwTopL = buttJoint({ facePart: top, edgePart: legL, points: ll.map((f) => ({ at: [ov + t / 2, f.offset, legH] as Vec3, kind: f.kind })) });
  const hwTopR = buttJoint({ facePart: top, edgePart: legR, points: ll.map((f) => ({ at: [W - ov - t / 2, f.offset, legH] as Vec3, kind: f.kind })) });
  // Top <- modesty panel
  const lt = fastenerLayout(modesty.length, p.joinery);
  const hwTopM = buttJoint({ facePart: top, edgePart: modesty, points: lt.map((f) => ({ at: [ov + t + f.offset, my + t / 2, legH] as Vec3, kind: f.kind })) });

  const pick = (hw: HardwareUse[], keys: string[]) => hw.filter((h) => keys.includes(h.key));
  const all = mergeHardware(hwModL, hwModR, hwTopL, hwTopR, hwTopM);
  const steps: AssemblyStep[] = [];
  if (p.joinery === "cam_dowel") {
    steps.push({
      title: "Prepare the legs and top",
      text: "Screw cam bolts into the 5mm holes on the inside of both leg panels and on the underside of the desk top. Tap dowels into all 8mm face holes.",
      parts: [legL.id],
      hardware: pick(all, ["cam_bolt", "dowel8x30"]),
      hint: "lay_flat",
    });
    steps.push({
      title: "Join the legs with the modesty panel",
      text: "Fit the modesty panel between the leg panels, cam holes facing the back. Insert cams and tighten them clockwise.",
      parts: [modesty.id, legR.id],
      hardware: pick(mergeHardware(hwModL, hwModR), ["cam15"]),
      hint: "tighten_cams",
    });
    steps.push({
      title: "Fit the top",
      text: "Lay the top face-down on a blanket. Turn the leg frame upside down onto it so the bolts enter the cam holes. Insert the cams and tighten them.",
      parts: [top.id],
      hardware: pick(mergeHardware(hwTopL, hwTopR, hwTopM), ["cam15"]),
      hint: "two_people",
    });
  } else {
    steps.push({ title: "Join the legs with the modesty panel", text: "Screw the modesty panel between the leg panels with confirmat screws through the legs.", parts: [legL.id, modesty.id, legR.id], hardware: mergeHardware(hwModL, hwModR), hint: "two_people" });
    steps.push({ title: "Fit the top", text: "Lay the top face-down on a blanket, set the leg frame on it upside down and screw through the top into the legs and modesty panel. Countersinks face down, so use the plugs or cap the heads.", parts: [top.id], hardware: mergeHardware(hwTopL, hwTopR, hwTopM), hint: "two_people" });
  }
  steps.push({ title: "Turn it over", text: "With a helper, turn the desk upright and stick felt pads under the leg panels.", parts: [], hardware: [{ key: "felt_pad", qty: 4 }], hint: "two_people" });

  if (H > 900) issues.push({ level: "warn", code: "standing_racking", message: "Standing-height fixed desks rack side to side; consider a taller modesty panel (≥ 400mm) and wall fixing." });
  if (D < 500) issues.push({ level: "info", code: "shallow_desk", message: "Depth under 500mm is tight for a monitor plus keyboard." });

  return {
    overall: { width: W, depth: D, height: H },
    parts,
    steps,
    issues,
    sagChecks: [{ partId: top.id, span: W - 2 * ov - 2 * t, depth: D, thickness: t, material: mat.key, loadKPa: LOADS.light.kPa, advice: "Use 25mm+ board, reduce the width, or add a steel stiffener under the front edge.", note: "(Conservative: ignores the stiffening from the modesty panel along the back.)" }],
    tipOverRisk: false,
  };
}
