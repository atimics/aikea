import { z } from "zod";
import { round } from "../geometry.js";
import { buildCarcass, CarcassParams } from "./carcass.js";
import type { TemplateResult } from "./common.js";

export const TidelineParams = z.object({
  width: z.number().min(1600).max(2400).default(1664).describe("Full width across all five towers, mm"),
  height: z.number().min(1100).max(2200).default(1480).describe("Height of the centre tower, mm"),
  depth: z.number().min(280).max(500).default(360).describe("Depth of the centre tower, mm"),
  material: z.string().default("baltic_birch_18"),
  gap: z.number().min(24).max(48).default(32).describe("Clear shadow gap between towers, mm"),
  accent: z.enum(["clay", "ink", "ochre"]).default("clay").describe("Paint finish for the second and fourth back panels"),
  joinery: z.enum(["cam_dowel", "confirmat"]).default("cam_dowel"),
  load: z.enum(["light", "books", "heavy"]).default("books"),
});

export const TIDELINE_FINISHES = {
  clay: { name: "Clay red", color: "#A8513D" },
  ink: { name: "Deep ink", color: "#294B50" },
  ochre: { name: "Ochre", color: "#B88732" },
};

// Widths, heights and shelf rhythms form one continuous rise and fall.
const TOWERS = [
  { width: 35, height: 672, depth: 0.8, shelves: [0.46] },
  { width: 38, height: 1040, depth: 0.9, shelves: [0.31, 0.68] },
  { width: 35, height: 1480, depth: 1, shelves: [0.24, 0.49, 0.76] },
  { width: 46, height: 1216, depth: 0.94, shelves: [0.29, 0.64] },
  { width: 38, height: 832, depth: 0.84, shelves: [0.53] },
];

export function buildTideline(input: z.infer<typeof TidelineParams>): TemplateResult {
  const p = TidelineParams.parse(input);
  const finish = TIDELINE_FINISHES[p.accent];
  const result: TemplateResult = {
    overall: { width: p.width, height: p.height, depth: p.depth },
    parts: [], sagChecks: [], issues: [], tipOverRisk: true,
    steps: [{
      title: "Finish the panels",
      text: `Sand the visible edges. Apply a clear matte finish to the frame and the backs of towers 1, 3 and 5. Paint both faces of the backs of towers 2 and 4 ${finish.name.toLowerCase()} (${finish.color}); keep the outer 8mm bare for the grooves. Let the finish cure before assembly. Towers are numbered left to right.`,
      parts: [], hardware: [],
    }],
  };
  const usableWidth = p.width - 4 * p.gap;
  let weight = 0;
  TOWERS.forEach((tower, index) => {
    const start = round(usableWidth * weight / 192 + index * p.gap);
    weight += tower.width;
    const end = round(usableWidth * weight / 192 + index * p.gap);
    const height = round(p.height * tower.height / 1480);
    const number = index + 1;
    const id = (local: string) => `tower_${number}_${local}`;
    const module = buildCarcass(CarcassParams.parse({
      width: round(end - start), height, depth: round(p.depth * tower.depth),
      material: p.material, backMaterial: "plywood_6", joinery: p.joinery, load: p.load,
      fixedShelfHeights: tower.shelves.map((ratio) => round(height * ratio)),
    }));
    for (const part of module.parts) {
      const back = part.role === "back";
      part.id = id(part.id);
      part.name = `Tower ${number} / ${part.name}`;
      part.origin[0] = round(part.origin[0] + start);
      if (back && (index === 1 || index === 3)) {
        part.finish = { ...finish };
        part.notes.push(`Paint both faces ${finish.name.toLowerCase()} (${finish.color}); keep an 8mm bare border for the grooves.`);
      } else {
        part.notes.push("Clear matte finish; sand visible edges smooth.");
      }
      result.parts.push(part);
    }
    result.sagChecks.push(...module.sagChecks.map((check) => ({ ...check, partId: id(check.partId) })));
    result.issues.push(...module.issues.filter((issue) => issue.code !== "tip_over").map((issue) => ({ ...issue, message: `Tower ${number}: ${issue.message}` })));
    // Place and anchor all towers together in the final step.
    result.steps.push(...module.steps.slice(0, -1).map((step) => ({
      ...step, title: `Tower ${number} / ${step.title}`, parts: step.parts.map(id),
    })));
  });
  result.steps.push({
    title: "Set the rhythm and anchor each tower",
    text: `With a helper, stand the five towers in order from left to right. Fit four felt pads below each tower. Align the backs against the wall and use a ${p.gap}mm spacer between towers. Keep the front edges stepped. Anchor each tower to a wall stud or suitable wall fixing with its own anti-tip kit. Choose cabinet screws to suit the panel thickness. Remove the spacers after fixing.`,
    parts: [], hardware: [{ key: "anti_tip_kit", qty: 5 }, { key: "felt_pad", qty: 20 }], hint: "wall_anchor",
  });
  result.issues.push({ level: "warn", code: "tip_over", message: "Anchor all five towers before use. Five anti-tip kits are included in the hardware list." });
  return result;
}
