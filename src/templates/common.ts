import type { AssemblyStep, Issue, Part } from "../types.js";

export interface SagCheck {
  partId: string;
  span: number; // unsupported span, mm
  depth: number; // shelf depth, mm
  thickness: number;
  material: string;
  loadKPa: number;
  note?: string;
  advice?: string;
}

export interface TemplateResult {
  overall: { width: number; depth: number; height: number };
  parts: Part[];
  steps: AssemblyStep[];
  issues: Issue[];
  sagChecks: SagCheck[];
  tipOverRisk: boolean;
}

export const LOADS: Record<string, { kPa: number; description: string }> = {
  light: { kPa: 0.5, description: "Decor, clothes, light storage (~50 kg/m²)" },
  books: { kPa: 1.2, description: "Mixed books (~120 kg/m²)" },
  heavy: { kPa: 2.0, description: "Hardcovers, records, tools (~200 kg/m²)" },
};
