import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDesign, reviseDesign } from "../src/design.js";
import { buildPackage } from "../src/package.js";
import { designDir, listDesigns, loadDesign, saveDesign } from "../src/store.js";
import { designFromInput, revisionOf, studioDesign, studioOptions } from "../src/studio.js";

const originalHome = process.env.AIKEA_HOME;
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "aikea-studio-")); process.env.AIKEA_HOME = home; });
afterAll(() => { if (originalHome === undefined) delete process.env.AIKEA_HOME; else process.env.AIKEA_HOME = originalHome; rmSync(home, { recursive: true, force: true }); });

describe("workshop designs", () => {
  it("previews every template with matching assembly steps, parts and sheet layouts", () => {
    for (const option of studioOptions().templates) {
      const d = createDesign(option.key, option.defaults);
      const result = studioDesign(d);
      expect(result.preview).toContain('<svg');
      expect(result.exploded).not.toEqual(result.preview);
      expect(result.steps).toHaveLength(d.steps.length);
      expect(result.cutlist.reduce((n, r) => n + r.qty, 0)).toBe(d.parts.length);
      expect(result.buildable, option.key).toBe(true);
      expect(result.sheets.length).toBeGreaterThan(0);
    }
    expect(listDesigns()).toHaveLength(0);
  });
  it("preserves omitted settings, the id, and creation date on a partial revision", () => {
    const d = createDesign("bookshelf", { width: 700, height: 1500, depth: 280, adjustableShelves: 3, joinery: "confirmat" });
    d.createdAt = "2025-01-01T00:00:00.000Z";
    const revised = reviseDesign(d, "bookshelf", { width: 760 });
    expect(revised.params).toMatchObject({ width: 760, height: 1500, depth: 280, adjustableShelves: 3, joinery: "confirmat" });
    expect(revised.id).toBe(d.id);
    expect(revised.createdAt).toBe(d.createdAt);
    expect(revised.updatedAt).toBeTruthy();
    expect(revised.name).toBe(d.name);
  });
  it("uses the new template defaults when switching the type of a saved design", () => {
    const original = createDesign("bookshelf", { height: 1800, depth: 280, adjustableShelves: 3 });
    const desk = reviseDesign(original, "desk", {});
    expect(desk.overall).toEqual({ width: 1400, height: 740, depth: 700 });
    expect(desk.params).not.toHaveProperty('adjustableShelves');
  });
  it("detects a stale browser revision after an assistant changes the saved design", () => {
    const d = createDesign("cube", {}); saveDesign(d);
    const revision = revisionOf(d);
    saveDesign(reviseDesign(d, "cube", { width: 500 }));
    expect(() => designFromInput({ template: "cube", design_id: d.id, expected_revision: revision, params: { height: 450 } })).toThrow('changed in another client');
    expect(loadDesign(d.id).overall.width).toBe(500);
  });
  it("returns actionable checks while keeping invalid sheet layouts out of the preview", () => {
    const result = studioDesign(createDesign("bookshelf", { material: "baltic_birch_18", height: 2000 }));
    expect(result.buildable).toBe(false);
    expect(result.sheets).toEqual([]);
    expect(result.design.issues.some((i) => i.level === "error")).toBe(true);
    expect(result.preview).toContain('<svg');
  });
});

describe("fabrication package integrity", () => {
  it("enforces blocking checks at the shared builder used by CLI, MCP and browser", async () => {
    const d = createDesign("bookshelf", { material: "baltic_birch_18", height: 2000 }); saveDesign(d);
    await expect(buildPackage(d)).rejects.toThrow("Fix design errors first");
    expect(existsSync(join(designDir(d.id), 'build'))).toBe(false);
  });
  it("writes a complete ZIP and clears old files when a design is revised", async () => {
    const d = createDesign("cube", {}); saveDesign(d);
    const first = await buildPackage(d);
    const files = unzipSync(readFileSync(first.zip));
    expect(JSON.parse(strFromU8(files[`${d.id}/design.json`]))).toEqual(d);
    expect(Object.keys(files)).toContain(`${d.id}/instructions.html`);
    const updated = reviseDesign(d, "cube", { width: 480 }); saveDesign(updated);
    expect(existsSync(first.zip)).toBe(false);
    expect(existsSync(first.dir)).toBe(false);
    expect(loadDesign(d.id)).toEqual(updated);
    const second = await buildPackage(updated);
    const current = unzipSync(readFileSync(second.zip));
    expect(JSON.parse(strFromU8(current[`${d.id}/design.json`])).overall.width).toBe(480);
    expect(readdirSync(designDir(d.id)).some((f) => f.startsWith('.build-'))).toBe(false);
  });
  it("keeps the last complete package when new nesting settings fail", async () => {
    const d = createDesign("bookshelf", { material: "baltic_birch_18", height: 1480, width: 700 }); saveDesign(d);
    const first = await buildPackage(d);
    const zip = readFileSync(first.zip);
    await expect(buildPackage(d, { trim: 50 })).rejects.toThrow();
    expect(readFileSync(first.zip)).toEqual(zip);
    expect(existsSync(join(first.dir, 'instructions.html'))).toBe(true);
    expect(readdirSync(designDir(d.id)).some((f) => f.startsWith('.build-'))).toBe(false);
  });
  it("rejects overlapping builds and discards a build if the model changes during rendering", async () => {
    const d = createDesign("cube", {}); saveDesign(d);
    const building = buildPackage(d);
    const overlap = buildPackage(d);
    await expect(overlap).rejects.toThrow('being built');
    saveDesign(reviseDesign(d, "cube", { width: 450 }));
    await expect(building).rejects.toThrow('changed during the build');
    expect(existsSync(join(designDir(d.id), `${d.id}.zip`))).toBe(false);
    expect(readdirSync(designDir(d.id)).some((f) => f.startsWith('.build-'))).toBe(false);
    await expect(buildPackage(d)).rejects.toThrow('Load the latest');
  });
  it.each([{ toolDia: 0 }, { spacing: -1 }, { trim: Number.NaN }])("checks build options %j", async (opts) => {
    await expect(buildPackage(createDesign("cube", {}), opts)).rejects.toThrow('must be between');
  });
});
