import type { MaterialSpec } from "./types.js";

// Nominal values. Modulus figures are conservative bending moduli used only for
// shelf-sag estimates; real boards vary by mill and moisture content.
export const MATERIALS: Record<string, MaterialSpec> = {
  baltic_birch_18: {
    key: "baltic_birch_18",
    name: "Baltic birch plywood 18mm (B/BB)",
    thickness: 18,
    sheet: { length: 1525, width: 1525 },
    grain: true,
    modulusMPa: 8000,
    densityKgM3: 680,
    pilotDia: 4.5,
    notes: "Void-free, strong screw holding, attractive exposed edges. 5x5 ft sheets.",
  },
  baltic_birch_12: {
    key: "baltic_birch_12",
    name: "Baltic birch plywood 12mm",
    thickness: 12,
    sheet: { length: 1525, width: 1525 },
    grain: true,
    modulusMPa: 8000,
    densityKgM3: 680,
    pilotDia: 4.5,
    notes: "For small boxes and drawers. Too thin for cam fittings — use confirmat.",
  },
  plywood_18: {
    key: "plywood_18",
    name: "Hardwood-veneer plywood 18mm (4x8)",
    thickness: 18,
    sheet: { length: 2440, width: 1220 },
    grain: true,
    modulusMPa: 7000,
    densityKgM3: 600,
    pilotDia: 4.5,
    notes: "Common 4x8 sheet. Band the front edges.",
  },
  mdf_18: {
    key: "mdf_18",
    name: "MDF 18mm (4x8)",
    thickness: 18,
    sheet: { length: 2440, width: 1220 },
    grain: false,
    modulusMPa: 3500,
    densityKgM3: 750,
    pilotDia: 5,
    notes: "Paint-grade, very flat, poor screw holding in edges. Sags under load.",
  },
  melamine_16: {
    key: "melamine_16",
    name: "Melamine-faced particleboard 16mm (4x8)",
    thickness: 16,
    sheet: { length: 2440, width: 1220 },
    grain: false,
    modulusMPa: 2800,
    densityKgM3: 650,
    pilotDia: 5,
    notes: "IKEA-style carcass board. Needs edge banding on visible edges.",
  },
  melamine_19: {
    key: "melamine_19",
    name: "Melamine-faced particleboard 19mm (4x8)",
    thickness: 19,
    sheet: { length: 2440, width: 1220 },
    grain: false,
    modulusMPa: 2800,
    densityKgM3: 650,
    pilotDia: 5,
    notes: "Heavier-duty melamine carcass board.",
  },
  hardboard_3: {
    key: "hardboard_3",
    name: "Hardboard 3mm (back panel)",
    thickness: 3.2,
    sheet: { length: 2440, width: 1220 },
    grain: false,
    modulusMPa: 4000,
    densityKgM3: 900,
    pilotDia: 0,
    notes: "Cheap back panel that slides into a groove.",
  },
  plywood_6: {
    key: "plywood_6",
    name: "Plywood 6mm (back panel)",
    thickness: 6,
    sheet: { length: 2440, width: 1220 },
    grain: true,
    modulusMPa: 7000,
    densityKgM3: 600,
    pilotDia: 0,
    notes: "Stiffer back panel; adds racking resistance.",
  },
};

export function getMaterial(key: string): MaterialSpec {
  const m = MATERIALS[key];
  if (!m) {
    throw new Error(
      `Unknown material "${key}". Options: ${Object.keys(MATERIALS).join(", ")}`,
    );
  }
  return m;
}
