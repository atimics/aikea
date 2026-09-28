import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Design } from "./types.js";

export function aikeaHome(): string {
  const dir = process.env.AIKEA_HOME || join(homedir(), ".aikea");
  mkdirSync(join(dir, "designs"), { recursive: true });
  return dir;
}

export function designDir(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid design id "${id}"`);
  return join(aikeaHome(), "designs", id);
}

export function saveDesign(d: Design): string {
  const dir = designDir(d.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "design.json");
  writeFileSync(file, JSON.stringify(d, null, 2));
  return file;
}

export function loadDesign(id: string): Design {
  const file = join(designDir(id), "design.json");
  if (!existsSync(file)) throw new Error(`No design "${id}". Use aikea_list_designs to see saved designs.`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function listDesigns(): { id: string; name: string; template: string; overall: Design["overall"]; createdAt: string }[] {
  const root = join(aikeaHome(), "designs");
  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, "design.json")))
    .map((id) => {
      const d = JSON.parse(readFileSync(join(root, id, "design.json"), "utf8")) as Design;
      return { id: d.id, name: d.name, template: d.template, overall: d.overall, createdAt: d.createdAt };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
