import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { cutList, hardwareBom, machiningMetrics, toCsv, type MachiningMetrics } from "./bom.js";
import { assertBuildable } from "./design.js";
import { faceHasOps, partDxf, sheetDxf } from "./dxf.js";
import { instructionsHtml } from "./instructions.js";
import { getMaterial } from "./materials.js";
import { DEFAULT_NEST, nestParts, type NestOptions, type Sheet } from "./nest.js";
import { isoSvg, sheetSvg } from "./render.js";
import { designDir } from "./store.js";
import type { Design, Part } from "./types.js";

export interface BuildResult {
  dir: string;
  zip: string;
  files: string[];
  sheets: { index: number; material: string; size: string; parts: string[]; utilisation: number }[];
  metrics: MachiningMetrics;
  previewPng?: string;
}

/** Render SVG to PNG if the optional @resvg/resvg-js dependency is installed. */
export async function svgToPng(svg: string, width = 900): Promise<Buffer | null> {
  try {
    const mod: any = await import("@resvg/resvg-js");
    const r = new mod.Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true } });
    return Buffer.from(r.render().asPng());
  } catch {
    return null;
  }
}

function shopNotes(d: Design, sheets: Sheet[], opts: NestOptions, m: MachiningMetrics): string {
  const faceB = d.parts.filter((p) => faceHasOps(p, "B"));
  const labels = [...new Set(d.parts.map((p) => p.label))].sort();
  const withBores = [...new Set(d.parts.filter((p) => p.edgeBores.length).map((p) => p.label))].sort();
  const csk = [...new Set(d.parts.filter((p) => p.holes.some((h) => h.purpose.startsWith("confirmat"))).map((p) => p.label))].sort();
  return `# Shop notes — ${d.name}

Design id: \`${d.id}\` · Overall ${d.overall.width} × ${d.overall.depth} × ${d.overall.height} mm · ${m.parts} parts (${m.uniqueParts} unique: ${labels.join(", ")})

## Materials
${[...new Set(sheets.map((s) => s.material))].map((k) => {
    const mat = getMaterial(k);
    const n = sheets.filter((s) => s.material === k).length;
    return `- **${mat.name}** — ${n} sheet(s) of ${mat.sheet.length} × ${mat.sheet.width} mm, nominal ${mat.thickness} mm. ${mat.grain ? "Grain runs along the sheet's long (X) axis; parts marked grain must keep it." : ""}`;
  }).join("\n")}

Nesting assumes a ${opts.toolDia} mm tool, ${opts.spacing} mm extra spacing and ${opts.trim} mm edge trim. **Measure the actual board thickness** — grooves are sized for the nominal back-panel thickness + 0.5 mm.

## Files
- \`dxf/sheets/*.dxf\` — nested sheets, sheet coordinates, origin at the lower-left sheet corner, face A up.
- \`dxf/parts/<letter>.dxf\` — one file per unique part, face A up. \`<letter>_B.dxf\` exists only where face B has blind machining (mirrored across the part's long axis).
- \`cutlist.csv\`, \`hardware.csv\` — quantities per unique part and per fitting.

## DXF layers (mm, AutoCAD R12)
| Layer | Operation |
|---|---|
| \`CUT_OUTLINE\` | Profile cut, full depth, outside the line. Use tabs or onion-skin on small parts. |
| \`DRILL_D{Ø}_Z{depth}\` | Vertical drill (or peck/helix) Ø × depth from face A. |
| \`DRILL_D{Ø}_THRU\` | Through hole. |
| \`POCKET_W{w}_Z{depth}\` | Groove / pocket, clear the closed boundary to depth. |
| \`HBORE_INFO\` | Horizontal edge bores — **informational**. Line starts at the edge and runs to the bore depth. |
| \`LABEL\`, \`SHEET_BOUNDARY\` | Do not machine. |

## Operations that need attention
- **Horizontal edge bores:** ${m.edgeBores} bores on parts ${withBores.join(", ") || "—"} (Ø and depth listed below). Machine them on a horizontal boring unit / boring machine, or supply the parts undrilled with a doweling jig — tell the customer which.
${d.parts.filter((p) => p.edgeBores.length).filter((p, i, a) => a.findIndex((q) => q.label === p.label) === i).map((p) => `  - ${p.label}: ${summariseBores(p)}`).join("\n")}
${faceB.length ? `- **Face B machining** on parts ${[...new Set(faceB.map((p) => p.label))].join(", ")} — flip and re-register, see \`<letter>_B.dxf\`.` : "- No blind machining on face B."}
${csk.length ? `- **Countersink** confirmat clearance holes on parts ${csk.join(", ")} (face B side, 90°, Ø10).` : ""}
- **Edge banding:** ${m.edgeBandM} m total; see the \`edgeBand\` column in cutlist.csv (edge ids: L0/L1 = long edges at y=0 / y=width, W0/W1 = ends at x=0 / x=length).
- Label every part with its letter on face B (hidden side) after cutting.

## Machining summary
Profile cut ${m.profileCutM} m · ${m.holes} face holes · ${m.edgeBores} edge bores · ${m.grooveM} m of groove · ${m.edgeBandM} m edge band · approx. ${m.weightKg} kg shipped weight (panels only).
`;
}

function summariseBores(p: Part): string {
  const g = new Map<string, number>();
  for (const b of p.edgeBores) {
    const k = `Ø${b.dia}×${b.depth} (${b.purpose}) on ${b.edge}`;
    g.set(k, (g.get(k) ?? 0) + 1);
  }
  return [...g.entries()].map(([k, n]) => `${n}× ${k}`).join(", ");
}

const building = new Set<string>();

export async function buildPackage(d: Design, opts: Partial<NestOptions> = {}): Promise<BuildResult> {
  assertBuildable(d);
  const root = designDir(d.id);
  if (building.has(root)) throw new Error("This design is being built. Try again when the build finishes.");
  const nest = { ...DEFAULT_NEST, ...opts };
  for (const [key, min, max] of [["toolDia", 1, 20], ["spacing", 0, 30], ["trim", 0, 50]] as const) {
    if (!Number.isFinite(nest[key]) || nest[key] < min || nest[key] > max) throw new Error(`${key} must be between ${min} and ${max} mm.`);
  }
  mkdirSync(root, { recursive: true });
  const modelPath = join(root, "design.json");
  const snapshot = () => existsSync(modelPath) ? readFileSync(modelPath, "utf8") : null;
  const before = snapshot();
  if (before && JSON.stringify(JSON.parse(before)) !== JSON.stringify(d)) throw new Error("The design changed. Load the latest version and build again.");
  const stage = mkdtempSync(join(root, ".build-"));
  building.add(root);
  try {
    const result = await writePackage(d, nest, stage);
    if (snapshot() !== before) throw new Error("The design changed during the build. Build the latest version again.");
    const dir = join(root, "build");
    const zip = join(root, `${d.id}.zip`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(result.dir, dir);
    renameSync(result.zip, zip);
    return { ...result, dir, zip, previewPng: result.previewPng ? join(dir, "preview.png") : undefined };
  } finally {
    building.delete(root);
    rmSync(stage, { recursive: true, force: true });
  }
}

async function writePackage(d: Design, opts: Partial<NestOptions>, stage: string): Promise<BuildResult> {
  const nest = { ...DEFAULT_NEST, ...opts };
  const dir = join(stage, "build");
  for (const sub of ["dxf/parts", "dxf/sheets", "svg"]) mkdirSync(join(dir, sub), { recursive: true });
  const files: Record<string, Uint8Array> = {};
  const put = (rel: string, data: string | Uint8Array) => {
    const buf = typeof data === "string" ? strToU8(data) : data;
    files[rel] = buf;
    writeFileSync(join(dir, rel), buf);
  };

  const byId = new Map(d.parts.map((p) => [p.id, p]));
  const sheets = nestParts(d.parts, nest);
  for (const s of sheets) {
    const base = `sheet_${s.index}_${s.material}`;
    put(`dxf/sheets/${base}.dxf`, sheetDxf(s, byId));
    put(`svg/${base}.svg`, sheetSvg(s, byId));
  }
  const seen = new Set<string>();
  for (const p of d.parts) {
    if (seen.has(p.label!)) continue;
    seen.add(p.label!);
    put(`dxf/parts/${p.label}.dxf`, partDxf(p, "A"));
    if (faceHasOps(p, "B")) put(`dxf/parts/${p.label}_B.dxf`, partDxf(p, "B"));
  }
  const metrics = machiningMetrics(d);
  put("cutlist.csv", toCsv(cutList(d) as any));
  put("hardware.csv", toCsv(hardwareBom(d).map(({ key, ...r }) => r) as any));
  put("instructions.html", instructionsHtml(d));
  put("SHOP_NOTES.md", shopNotes(d, sheets, nest, metrics));
  const preview = isoSvg(d, d.parts, { dims: true, width: 640, title: d.name, materialColors: true, camera: d.template === "tideline" ? "front" : "isometric" });
  put("svg/preview.svg", preview);
  const png = await svgToPng(preview);
  if (png) put("preview.png", png);
  put("design.json", JSON.stringify(d, null, 2));

  const zipPath = join(stage, `${d.id}.zip`);
  writeFileSync(zipPath, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${d.id}/${k}`, v]))));

  return {
    dir,
    zip: zipPath,
    files: Object.keys(files).sort(),
    sheets: sheets.map((s) => ({ index: s.index, material: s.material, size: `${s.length}×${s.width}`, parts: s.placements.map((p) => p.label + (p.rotated ? "↻" : "")), utilisation: s.utilisation })),
    metrics,
    previewPng: png ? join(dir, "preview.png") : undefined,
  };
}
