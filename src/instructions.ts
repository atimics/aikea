import { hardwareBom, cutList } from "./bom.js";
import { getMaterial } from "./materials.js";
import { esc, isoSvg, partSvg } from "./render.js";
import type { Design, HardwareKey } from "./types.js";

const I = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<HardwareKey | "hex" | "screwdriver" | "hammer" | "person" | "wall" | "arrow_cw", string> = {
  cam15: I(`<circle cx="32" cy="32" r="18" fill="#d9d9d9"/><path d="M22 32h20"/><path d="M40 20a14 14 0 0 1 4 6" stroke="#c0392b"/><path d="M44 21l0 6-6-1" stroke="#c0392b"/>`),
  cam_bolt: I(`<rect x="14" y="26" width="10" height="12" rx="2" fill="#d9d9d9"/><path d="M24 32h26"/><path d="M28 28l2 8M34 28l2 8M40 28l2 8M46 28l2 8"/>`),
  dowel8x30: I(`<rect x="12" y="26" width="40" height="12" rx="6" fill="#e8c792"/><path d="M18 27v10M26 27v10M34 27v10M42 27v10"/>`),
  confirmat7x50: I(`<path d="M10 24h8v16h-8z" fill="#d9d9d9"/><path d="M18 29h34l4 3-4 3H18"/><path d="M24 29l2 6M30 29l2 6M36 29l2 6M42 29l2 6"/>`),
  shelf_pin5: I(`<rect x="16" y="28" width="22" height="8" rx="2" fill="#d9d9d9"/><rect x="38" y="24" width="10" height="16" rx="2" fill="#d9d9d9"/>`),
  anti_tip_kit: I(`<rect x="10" y="12" width="10" height="40" fill="#e5e5e5"/><path d="M20 26h14l10 6h10"/><circle cx="50" cy="32" r="3"/><circle cx="15" cy="20" r="2"/>`),
  felt_pad: I(`<circle cx="32" cy="32" r="16" fill="#9aa5b1"/><circle cx="32" cy="32" r="10"/>`),
  wood_glue: I(`<path d="M24 20h16v30a4 4 0 0 1-4 4h-8a4 4 0 0 1-4-4z" fill="#fff"/><path d="M28 20v-8h8v8M32 12V6"/>`),
  hex: I(`<path d="M16 48V20a4 4 0 0 1 4-4h28"/><path d="M44 12l6 4-6 4"/>`),
  screwdriver: I(`<rect x="8" y="26" width="22" height="12" rx="5" fill="#f1c40f"/><path d="M30 32h22M52 29v6"/>`),
  hammer: I(`<rect x="14" y="12" width="26" height="12" rx="2" fill="#d9d9d9"/><path d="M28 24v30"/>`),
  person: I(`<circle cx="22" cy="16" r="5"/><path d="M22 22v18M14 30h16M22 40l-6 14M22 40l6 14"/><circle cx="44" cy="16" r="5"/><path d="M44 22v18M36 30h16M44 40l-6 14M44 40l6 14"/>`),
  wall: I(`<path d="M8 8h14v48H8z" fill="#e5e5e5"/><path d="M8 20h14M8 32h14M8 44h14"/><path d="M22 30h22v26H22" fill="#f3d9b1"/><path d="M22 34h16" stroke="#c0392b"/>`),
  arrow_cw: I(`<path d="M44 20a16 16 0 1 0 4 14" stroke="#c0392b"/><path d="M50 14v10H40" stroke="#c0392b"/>`),
};

function hintBadge(h?: string): string {
  switch (h) {
    case "two_people": return `<div class="hint">${ICONS.person}<span>2×</span></div>`;
    case "tighten_cams": return `<div class="hint">${ICONS.cam15}${ICONS.arrow_cw}</div>`;
    case "wall_anchor": return `<div class="hint warn">${ICONS.wall}<span>!</span></div>`;
    case "lay_flat": return `<div class="hint"><svg viewBox="0 0 64 64" width="56" height="56"><rect x="6" y="40" width="52" height="8" fill="#f3d9b1" stroke="#5b3a12"/><path d="M6 54h52" stroke="#111" stroke-width="2"/></svg></div>`;
    default: return "";
  }
}

export function instructionsHtml(d: Design): string {
  const parts = cutList(d);
  const bom = hardwareBom(d);
  const byLabel = new Map(d.parts.map((p) => [p.label!, p]));
  const hasConfirmat = bom.some((b) => b.key === "confirmat7x50");
  const hasCams = bom.some((b) => b.key === "cam15");
  const tools = [
    hasCams || !hasConfirmat ? ["screwdriver", "Flat / PH2 screwdriver"] : null,
    hasConfirmat ? ["hex", "4mm hex key"] : null,
    bom.some((b) => b.key === "dowel8x30") ? ["hammer", "Soft mallet"] : null,
  ].filter(Boolean) as [keyof typeof ICONS, string][];

  const built = new Set<string>();
  const stepHtml = d.steps.map((s, i) => {
    s.parts.forEach((id) => built.add(id));
    const visible = d.parts.filter((p) => built.has(p.id));
    const img = visible.length
      ? isoSvg(d, visible, { highlight: new Set(s.parts.length ? s.parts : []), width: 560, maxHeight: 460 })
      : "";
    const hw = s.hardware.map((h) => `<div class="hw">${ICONS[h.key]}<b>${h.qty}×</b></div>`).join("");
    const newParts = [...new Set(s.parts.map((id) => d.parts.find((p) => p.id === id)!.label))]
      .map((l) => `<span class="chip">${l} ×${s.parts.filter((id) => d.parts.find((p) => p.id === id)!.label === l).length}</span>`).join("");
    return `<section class="step"><div class="num">${i + 1}</div><div class="body"><h3>${esc(s.title)}</h3><div class="row">${newParts}${hw}${hintBadge(s.hint)}</div><div class="fig">${img}</div><p>${esc(s.text)}</p></div></section>`;
  }).join("");

  const inventory = parts.map((r) => `<div class="inv"><div class="lbl">${r.label}</div><div class="draw">${partSvg(byLabel.get(r.label)!)}</div><div class="meta"><b>${r.qty}×</b> ${esc(r.name)}<br><small>${r.length} × ${r.width} × ${r.thickness} mm</small></div></div>`).join("");
  const hwInv = bom.map((b) => `<div class="inv hwinv">${ICONS[b.key]}<div class="meta"><b>${b.qty}×</b> ${esc(b.name)}<br><small>${esc(b.spec)}</small></div></div>`).join("");
  const materials = [...new Set(d.parts.map((p) => getMaterial(p.material).name))].join(", ");
  const tipOver = d.steps.some((s) => s.hint === "wall_anchor");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.name)} — assembly</title>
<style>
:root{--ink:#111;--muted:#666;--line:#ddd;--wood:#f3d9b1;--accent:#c0392b}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.45 Helvetica,Arial,sans-serif}
main{max-width:820px;margin:0 auto;padding:24px 16px}
h1{font-size:34px;letter-spacing:.02em;margin:0 0 4px}h2{font-size:20px;border-bottom:2px solid var(--ink);padding-bottom:4px;margin-top:40px}
.sub{color:var(--muted)}.cover{text-align:center}.cover svg{max-width:100%;height:auto}
.warn-box{border:3px solid var(--accent);padding:14px 16px;border-radius:6px;display:flex;gap:14px;align-items:center;margin:16px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.inv svg{flex:none}.inv{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:6px;padding:8px}
.inv .lbl{font-size:28px;font-weight:800;width:36px;text-align:center}.inv .draw svg{max-width:130px;height:auto}.inv small{color:var(--muted)}
.tools{display:flex;gap:18px;flex-wrap:wrap}.tools div{text-align:center;font-size:12px;color:var(--muted)}
.step{display:flex;gap:14px;border-top:1px solid var(--line);padding:18px 0;page-break-inside:avoid}
.num{font-size:44px;font-weight:800;min-width:56px}.body{flex:1;min-width:0}.body h3{margin:6px 0 8px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.hw{display:flex;align-items:center;gap:2px;border:1px solid var(--line);border-radius:6px;padding:2px 8px 2px 2px}
.chip{background:var(--wood);border:1px solid #5b3a12;border-radius:14px;padding:2px 10px;font-weight:700}
.hint{display:flex;align-items:center;gap:2px;font-weight:800}.hint.warn{color:var(--accent)}
.fig svg{max-width:100%;height:auto}.fig{margin:8px 0;text-align:center}
@media print{h2{page-break-before:always}.step{page-break-inside:avoid}}
</style></head><body><main>
<div class="cover"><h1>${esc(d.name.toUpperCase())}</h1><div class="sub">${d.overall.width} × ${d.overall.depth} × ${d.overall.height} mm · ${esc(materials)}</div>
${isoSvg(d, d.parts, { dims: true, width: 620, maxHeight: 640, materialColors: true, camera: d.template === "tideline" ? "front" : "isometric" })}</div>
${tipOver ? `<div class="warn-box">${ICONS.wall}<div><b>Tip-over hazard.</b> This furniture must be anchored to the wall with the included anti-tip kit. Use fasteners suited to your wall material.</div></div>` : ""}
<div class="warn-box" style="border-color:#111">${ICONS.person}<div>Assemble on a soft, clean surface. Some steps need two people.</div></div>
<h2>Tools</h2><div class="tools">${tools.map(([k, t]) => `<div>${ICONS[k]}<br>${t}</div>`).join("")}</div>
<h2>Parts</h2><div class="grid">${inventory}</div>
<h2>Hardware</h2><div class="grid">${hwInv}</div>
<p class="sub">Your kit includes a few spare fittings.</p>
<h2>Assembly</h2>${stepHtml}
<p class="sub" style="margin-top:32px">Designed with AIKEA · design ${esc(d.id)}</p>
</main></body></html>`;
}
