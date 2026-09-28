import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { cutList, hardwareBom } from "../src/bom.js";
import { createDesign, partSignature } from "../src/design.js";
import { worldBox } from "../src/geometry.js";
import { buildPackage } from "../src/package.js";
import { isoSvg, partSvg } from "../src/render.js";
import { saveDesign } from "../src/store.js";

describe("Tideline furniture art", () => {
  it("keeps five grounded towers, clear shadow gaps and the intended shelf rhythm", () => {
    const d = createDesign("tideline", {});
    const widths = [280, 304, 280, 368, 304], heights = [672, 1040, 1480, 1216, 832];
    const shelves = [1, 2, 3, 2, 1];
    let previousEnd = -32;
    for (let i = 0; i < 5; i++) {
      const parts = d.parts.filter((p) => p.id.startsWith(`tower_${i + 1}_`));
      const boxes = parts.map(worldBox);
      const minX = Math.min(...boxes.map((b) => b.min[0])), maxX = Math.max(...boxes.map((b) => b.max[0]));
      expect(minX - previousEnd).toBe(32);
      expect(maxX - minX).toBe(widths[i]);
      expect(Math.min(...boxes.map((b) => b.min[2]))).toBe(0);
      expect(Math.max(...boxes.map((b) => b.max[2]))).toBe(heights[i]);
      expect(parts.filter((p) => p.id.includes("shelf_fixed"))).toHaveLength(shelves[i]);
      previousEnd = maxX;
    }
    expect(previousEnd).toBe(d.overall.width);
    expect(d.issues.filter((issue) => issue.level === "error")).toEqual([]);
    expect(hardwareBom(d).find((h) => h.key === "anti_tip_kit")?.qty).toBe(5);
    expect(d.steps.flatMap((s) => s.parts).sort()).toEqual(d.parts.map((p) => p.id).sort());
  });

  it("carries paint through part labels, cut notes and both render views", () => {
    const d = createDesign("tideline", { accent: "clay" });
    const painted = d.parts.filter((p) => p.finish);
    expect(painted.map((p) => p.id)).toEqual(["tower_2_back", "tower_4_back"]);
    for (const p of painted) {
      expect(p.material).toBe("plywood_6");
      expect(partSignature(p)).not.toBe(partSignature({ ...p, finish: undefined }));
      expect(cutList(d).find((row) => row.label === p.label)?.notes).toContain("Clay red".toLowerCase());
      expect(partSvg(p)).toContain('fill="#A8513D"');
    }
    for (const camera of ["front", "isometric"] as const) {
      const svg = isoSvg(d, d.parts, { camera });
      expect(svg).toContain('fill="#A8513D"');
      expect(svg).not.toMatch(/NaN|Infinity/);
    }
  });

  it("keeps stored finish values safe inside SVG attributes", () => {
    const d = createDesign("tideline", {});
    d.parts[0].finish = { name: "Stored paint", color: '\" onload=\"alert(1)' };
    expect(isoSvg(d, d.parts)).not.toContain("onload");
    expect(partSvg(d.parts[0])).not.toContain("onload");
  });

  it("packages the same geometry, finish recipe and wall fixing plan", async () => {
    const previous = process.env.AIKEA_HOME;
    const home = mkdtempSync(join(tmpdir(), "aikea-tideline-"));
    process.env.AIKEA_HOME = home;
    try {
      const d = createDesign("tideline", {}, "TIDELINE / 01");
      saveDesign(d);
      const kit = await buildPackage(d);
      const files = unzipSync(readFileSync(kit.zip));
      const find = (name: string) => strFromU8(files[Object.keys(files).find((key) => key.endsWith(`/${name}`))!]);
      expect(JSON.parse(find("design.json"))).toEqual(d);
      expect(find("cutlist.csv")).toContain("#A8513D");
      expect(find("instructions.html")).toContain("Anchor each tower");
      expect(kit.sheets).toHaveLength(4);
      expect(kit.metrics.parts).toBe(34);
    } finally {
      if (previous === undefined) delete process.env.AIKEA_HOME;
      else process.env.AIKEA_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
