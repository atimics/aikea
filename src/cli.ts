#!/usr/bin/env node
// Command-line access to the same engine, handy for scripting and CI.
//   aikea options
//   aikea design <template> [params.json|'{"width":900}'] [--name "My shelf"]
//   aikea build <design_id>
//   aikea list
import { existsSync, readFileSync } from "node:fs";
import { cutList } from "./bom.js";
import { createDesign, TEMPLATES } from "./design.js";
import { MATERIALS } from "./materials.js";
import { buildPackage } from "./package.js";
import { listDesigns, loadDesign, saveDesign } from "./store.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2).filter((x, i, all) => !x.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
  switch (cmd) {
    case "options":
      console.log("Templates:", Object.keys(TEMPLATES).join(", "));
      console.log("Materials:", Object.keys(MATERIALS).join(", "));
      break;
    case "design": {
      if (!a1) throw new Error("usage: aikea design <template> [params]");
      const params = a2 ? JSON.parse(existsSync(a2) ? readFileSync(a2, "utf8") : a2) : {};
      const d = createDesign(a1, params, arg("--name"));
      saveDesign(d);
      console.log(`design_id: ${d.id}`);
      for (const i of d.issues) console.log(`[${i.level}] ${i.message}`);
      console.table(cutList(d).map((r) => ({ part: r.label, qty: r.qty, name: r.name, size: `${r.length}x${r.width}x${r.thickness}` })));
      if (process.argv.includes("--build")) {
        const b = await buildPackage(d);
        console.log(`package: ${b.zip}`);
      }
      break;
    }
    case "build": {
      if (!a1) throw new Error("usage: aikea build <design_id>");
      const b = await buildPackage(loadDesign(a1));
      console.log(`package: ${b.zip}`);
      for (const s of b.sheets) console.log(`sheet ${s.index} ${s.material} ${s.parts.join(" ")} ${Math.round(s.utilisation * 100)}%`);
      break;
    }
    case "list":
      for (const d of listDesigns()) console.log(`${d.id}\t${d.name}`);
      break;
    default:
      console.log("usage: aikea <options|design|build|list> …   (MCP server: aikea-mcp)");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
