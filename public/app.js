const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titles = { bookshelf: 'Bookcase', cabinet: 'Cabinet', cube: 'Storage cube', desk: 'Desk' };
const names = { bookshelf: 'Everyday bookcase', cabinet: 'Living room cabinet', cube: 'Little storage cube', desk: 'A desk of my own' };
const icons = {
  bookshelf: '<path d="M10 3h20v24H10zM10 10h20M10 18h20M13 27v3m14-3v3"/>',
  cabinet: '<path d="M3 10h34v16H3zM3 18h34M6 26v4m28-4v4"/>',
  cube: '<path d="m8 9 14-6 12 6v16l-14 6-12-6zM8 9l12 6 14-6M20 15v16M11 13v10l9 4"/>',
  desk: '<path d="m3 10 12-6 22 5-11 6zM5 12v16l4-2V14m25-4v16l-4 2V13M9 22l21 4"/>',
};
const labels = {
  width: 'Width', height: 'Height', depth: 'Depth', material: 'Panel material', joinery: 'Joinery',
  adjustableShelves: 'Adjustable shelves', fixedShelves: 'Fixed shelves', backMaterial: 'Back panel', load: 'Expected load',
  plinthHeight: 'Plinth height (mm)', fixedShelfHeights: 'Fixed shelf heights (mm, comma separated)',
  edgeBandFronts: 'Band the front edges', edgeBand: 'Band visible edges', topOverhang: 'Top overhang (mm)',
  modestyHeight: 'Rear panel height (mm)', modestyInset: 'Rear panel inset (mm)',
};
const choiceLabels = { cam_dowel: 'Cam locks + dowels', confirmat: 'Confirmat screws', light: 'Decor & light storage', books: 'Everyday books', heavy: 'Records & heavy books' };
let options, template = 'bookshelf', params = {}, designId, baseRevision, result, view = 'assembled', step = 0, sheet = 0;
let dirty = true, touched = false, pending = true, busy = false, valid = false, sequence = 0, timer, controller, toastTimer;
const draftKey = 'aikea.workshop.draft.v1';

async function api(path, body, signal) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Please try again.');
  return data;
}
function message(text, error = false) {
  if (error) { $('global-error').textContent = text; $('global-error').hidden = false; return; }
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
function clearError() { $('global-error').hidden = true; }
function remember() {
  try { localStorage.setItem(draftKey, JSON.stringify({ template, params, name: $('design-name').value, designId, baseRevision })); }
  catch { $('save-state').textContent = 'Save this design to keep your changes'; }
}
function forgetDraft() { try { localStorage.removeItem(draftKey); } catch { /* Server save remains available. */ } }
function controls() {
  $('save-button').disabled = busy || pending || !valid;
  $('build-button').disabled = busy || pending || !valid || !result?.buildable;
  $('parts-button').disabled = !result;
  $('design-form').querySelectorAll('input, select, textarea, button').forEach((e) => { e.disabled = busy; });
  $('design-name').disabled = busy;
  $('projects-button').disabled = busy;
  $('canvas').classList.toggle('is-updating', pending);
  document.querySelector('.canvas-panel').classList.toggle('is-invalid', !valid);
  $('build-note').textContent = pending ? 'Updating your design…' : !valid ? 'Adjust the settings to refresh your design.' : result?.buildable ? 'Your design becomes a downloadable ZIP.' : 'Resolve the fit checks to build your kit.';
}
function inputFor(key, schema, value) {
  const id = `field-${key}`, title = labels[key] || key;
  if (schema.type === 'boolean') return `<div class="check-field"><input data-param="${key}" id="${id}" type="checkbox" ${value ?? !String(params.material).startsWith('baltic') ? 'checked' : ''}><label for="${id}">${title}</label></div>`;
  let choices;
  if (key === 'material') choices = options.materials.filter((m) => m.thickness >= 12).map((m) => [m.key, m.name]);
  else if (key === 'backMaterial') choices = [['', 'Open back'], ...options.materials.filter((m) => m.thickness < 12).map((m) => [m.key, m.name])];
  else if (schema.enum) choices = schema.enum.map((v) => [v, choiceLabels[v] || v]);
  let field;
  if (choices) field = `<select data-param="${key}" id="${id}">${choices.map(([v, label]) => `<option value="${escape(v)}" ${String(value ?? '') === v ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select>`;
  else if (schema.type === 'array') field = `<input data-param="${key}" id="${id}" type="text" placeholder="e.g. 500, 1000" value="${escape((value || []).join(', '))}">`;
  else field = `<input data-param="${key}" id="${id}" type="number" step="${schema.type === 'integer' ? 1 : 'any'}" ${schema.minimum !== undefined ? `min="${schema.minimum}"` : ''} ${schema.maximum !== undefined ? `max="${schema.maximum}"` : ''} value="${escape(value ?? schema.default ?? '')}" required>`;
  return `<div class="field"><label for="${id}">${escape(title)}</label>${field}</div>`;
}
function renderForm() {
  const def = options.templates.find((t) => t.key === template), fields = def.schema.properties;
  $('templates').innerHTML = options.templates.map((t) => `<button type="button" class="template-button" data-template="${t.key}" aria-pressed="${t.key === template}"><svg viewBox="0 0 40 34" aria-hidden="true">${icons[t.key]}</svg>${titles[t.key]}</button>`).join('');
  $('dimensions').innerHTML = ['width', 'height', 'depth'].map((key) => inputFor(key, fields[key], params[key])).join('');
  $('material-field').innerHTML = inputFor('material', fields.material, params.material);
  const primary = template === 'desk' ? ['joinery', 'topOverhang'] : ['adjustableShelves', 'joinery', 'backMaterial'];
  $('primary-fields').innerHTML = primary.map((key) => inputFor(key, fields[key], params[key])).join('');
  const used = new Set(['width', 'height', 'depth', 'material', ...primary]);
  $('advanced-fields').innerHTML = Object.entries(fields).filter(([key]) => !used.has(key)).map(([key, schema]) => inputFor(key, schema, params[key])).join('');
  materialNote();
}
function materialNote() { $('material-note').textContent = options.materials.find((m) => m.key === params.material)?.notes || ''; }
function payload() { return { template, params, name: $('design-name').value.trim() || undefined, ...(designId ? { design_id: designId, expected_revision: baseRevision } : {}) }; }
function readForm() {
  for (const el of $('design-form').querySelectorAll('[data-param]')) {
    const key = el.dataset.param;
    if (el.type === 'checkbox') params[key] = el.checked;
    else if (el.type === 'number') params[key] = el.valueAsNumber;
    else if (key === 'backMaterial') params[key] = el.value || null;
    else if (key === 'fixedShelfHeights') params[key] = el.value.trim() ? el.value.split(',').map((v) => Number(v.trim())) : [];
    else params[key] = el.value;
  }
  materialNote();
}
function markDirty() {
  dirty = true; valid = false; pending = true;
  $('save-state').textContent = 'Draft · saved in this browser';
  $('build-result').hidden = true;
  $('preview-status').textContent = 'Updating preview';
  sequence++; controller?.abort(); clearTimeout(timer); remember(); controls();
  timer = setTimeout(refreshPreview, 300);
}
async function refreshPreview() {
  if (busy) return;
  if (!$('design-form').checkValidity() || !$('design-name').checkValidity()) {
    pending = false; valid = false; controls(); $('preview-status').textContent = 'Check the highlighted settings'; return;
  }
  const request = ++sequence;
  controller?.abort(); controller = new AbortController();
  pending = true; controls();
  try {
    const data = await api('/api/preview', payload(), controller.signal);
    if (request !== sequence) return;
    result = data; valid = true; clearError(); renderResult();
    $('preview-status').textContent = 'Preview up to date';
  } catch (e) {
    if (request !== sequence || e.name === 'AbortError') return;
    valid = false; message(e.message, true); $('preview-status').textContent = 'Adjust your design settings';
  } finally { if (request === sequence) { pending = false; controls(); } }
}
function renderResult() {
  step = Math.min(step, result.steps.length - 1); sheet = Math.min(sheet, Math.max(result.sheets.length - 1, 0));
  $('metrics').innerHTML = `<div><strong>${result.metrics.parts}</strong><span>panels</span></div><div><strong>${result.sheets.length || '—'}</strong><span>sheets</span></div><div><strong>${result.metrics.weightKg}<small> kg</small></strong><span>panel weight</span></div><div><strong>${result.steps.length}</strong><span>assembly steps</span></div>`;
  renderView(); renderChecks(); renderParts();
}
function renderView() {
  if (!result) return;
  document.querySelectorAll('[data-view]').forEach((b) => { const active = b.dataset.view === view; b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
  $('view-panel').setAttribute('aria-labelledby', `tab-${view}`);
  const detail = $('view-details'); detail.hidden = view === 'assembled' || view === 'exploded';
  $('drawing').setAttribute('aria-label', `${titles[template]}: ${view} view, ${result.design.overall.width} mm wide, ${result.design.overall.height} mm tall`);
  if (view === 'assembled' || view === 'exploded') {
    $('drawing').innerHTML = view === 'assembled' ? result.preview : result.exploded;
    $('view-caption').textContent = view === 'assembled' ? 'ISOMETRIC VIEW / MILLIMETRES' : 'EXPLODED VIEW / PART LETTERS';
  } else if (view === 'assembly') {
    const s = result.steps[step];
    $('drawing').innerHTML = s.svg;
    $('view-caption').textContent = `ASSEMBLY / STEP ${step + 1} OF ${result.steps.length}`;
    detail.innerHTML = `<div class="step-controls"><button data-step="${step - 1}" aria-label="Previous assembly step" ${step === 0 ? 'disabled' : ''}>←</button><span>Step ${step + 1} of ${result.steps.length}</span><button data-step="${step + 1}" aria-label="Next assembly step" ${step === result.steps.length - 1 ? 'disabled' : ''}>→</button></div><h3>${escape(s.title)}</h3><p>${escape(s.text)}</p>${s.hardware.length ? `<p class="field-note">${s.hardware.map((h) => `${h.qty} × ${escape(result.hardware.find((x) => x.key === h.key)?.name || h.key)}`).join(' · ')}</p>` : ''}<div class="step-dots">${result.steps.map((_, i) => `<button data-step="${i}" aria-label="Assembly step ${i + 1}" aria-current="${i === step}">${i + 1}</button>`).join('')}</div>`;
  } else {
    const s = result.sheets[sheet];
    $('drawing').innerHTML = s ? s.svg : '<p>Adjust the fit checks to see the sheet layout.</p>';
    $('view-caption').textContent = 'NESTED SHEET / GRAIN-AWARE LAYOUT';
    detail.innerHTML = s ? `<label for="sheet-picker" class="eyebrow">CHOOSE A SHEET</label><select id="sheet-picker" class="sheet-picker">${result.sheets.map((x, i) => `<option value="${i}" ${i === sheet ? 'selected' : ''}>Sheet ${i + 1} — ${escape(x.material)}</option>`).join('')}</select><p class="sheet-stats">${Math.round(s.utilisation * 100)}% of this sheet used · part letters match your cut list.</p><p class="field-note">6.35 mm tool · 4 mm spacing · 12 mm edge trim.</p>` : '<p>Choose a larger sheet material or reduce the panel dimensions.</p>';
  }
}
function renderChecks() {
  const issues = [...result.design.issues];
  if (result.nestingError) issues.unshift({ level: 'error', code: 'nesting', message: result.nestingError });
  const fit = issues.filter((i) => i.code === 'part_exceeds_sheet' || i.code === 'nesting');
  const groups = [
    { title: 'Sheet fit', items: fit, ok: `${result.sheets.length} sheets, with grain direction respected.` },
    { title: 'Strength & stability', items: issues.filter((i) => /sag|tip|racking|back|shelves/.test(i.code)), ok: 'Dimensions checked for the selected load.' },
    { title: 'Joinery & machining', items: issues.filter((i) => !fit.includes(i) && !/sag|tip|racking|back|shelves/.test(i.code)), ok: `${result.metrics.holes} face holes · ${result.metrics.edgeBores} edge bores.` },
  ];
  $('checks').innerHTML = groups.map((g) => {
    const level = g.items.some((i) => i.level === 'error') ? 'error' : g.items.length ? 'warn' : 'ok';
    return `<div class="check-item ${level}"><span class="check-symbol" aria-hidden="true">${level === 'ok' ? '✓' : '!'}</span><div><strong>${g.title}</strong>${g.items.length ? `<details ${level === 'error' ? 'open' : ''}><summary>${g.items.length} ${g.items.length === 1 ? 'note' : 'notes'} to review</summary>${g.items.map((i) => `<p>${escape(i.message)}</p>`).join('')}</details>` : `<p>${g.ok}</p>`}</div></div>`;
  }).join('');
}
function renderParts() {
  $('parts-content').innerHTML = `<p class="field-note">${result.metrics.parts} panels · ${result.metrics.uniqueParts} unique shapes. All dimensions in millimetres.</p><h3>Your panels</h3><div class="part-grid">${result.cutlist.map((p) => `<article class="part-card"><div class="part-picture">${p.svg}</div><strong><span class="part-badge">${escape(p.label)}</span>${escape(p.name)} × ${p.qty}</strong><p>${p.length} × ${p.width} × ${p.thickness} mm</p><p>${escape(p.material)}</p><p>${p.faceOps} face operations · ${p.edgeBores} edge bores</p></article>`).join('')}</div><h3>Hardware, including spares</h3>${result.hardware.map((h) => `<div class="hardware-row"><div><span>${escape(h.name)}</span><p>${escape(h.spec)}</p><p>${h.qty} for assembly + ${h.spares} spare</p></div><strong>× ${h.order}</strong></div>`).join('')}`;
}
async function persist() {
  const saved = await api('/api/designs', payload());
  designId = saved.design.id; baseRevision = saved.revision; result = saved; params = { ...saved.design.params };
  dirty = false; touched = false; valid = true; pending = false; forgetDraft();
  $('save-state').textContent = 'Saved to your workshop';
  renderResult();
  return saved;
}
async function saveOrBuild(build) {
  if (busy || pending || !valid) return;
  busy = true; clearTimeout(timer); sequence++; controller?.abort(); clearError(); controls();
  const button = build ? $('build-button') : $('save-button');
  button.textContent = build ? 'Building your kit…' : 'Saving…';
  try {
    if (dirty || !designId) await persist();
    if (build) {
      const kit = await api(`/api/designs/${designId}/build`, {});
      $('build-result').innerHTML = `<p>Your kit is ready. ${kit.files.length} files, sized for this design.</p><a class="button primary" href="${escape(kit.download)}" download>Download kit <span aria-hidden="true">↓</span></a><a class="text-link" href="${escape(kit.instructions)}" target="_blank" rel="noopener">Open assembly instructions ↗</a>`;
      $('build-result').hidden = false;
      message('Your fabrication kit is ready.');
    } else message('Design saved to your workshop.');
  } catch (e) { message(e.message, true); }
  finally {
    busy = false; button.innerHTML = build ? 'Build my kit <span aria-hidden="true">↗</span>' : 'Save design <span aria-hidden="true">↗</span>'; controls();
  }
}
function mayLeave() { return !dirty || !touched || window.confirm('Start another design? Save this draft first to keep it in your workshop.'); }
function startTemplate(key) {
  if (!mayLeave()) return;
  sequence++; controller?.abort(); clearTimeout(timer);
  template = key; params = { ...options.templates.find((t) => t.key === key).defaults }; designId = undefined; baseRevision = undefined; touched = false;
  $('design-name').value = names[key]; view = 'assembled'; step = 0; sheet = 0;
  renderForm(); markDirty();
}
async function showProjects() {
  $('projects-dialog').showModal(); $('project-list').textContent = 'Loading your designs…';
  try {
    const designs = await api('/api/designs');
    $('project-list').innerHTML = designs.length ? designs.map((d) => `<div class="project-item"><div><strong>${escape(d.name)}</strong><p>${escape(titles[d.template] || d.template)} · ${d.overall.width} × ${d.overall.depth} × ${d.overall.height} mm</p><p>Saved ${escape(new Date(d.updatedAt || d.createdAt).toLocaleDateString())}</p></div><button class="button secondary" data-open="${escape(d.id)}" aria-label="Open ${escape(d.name)}">Open ↗</button></div>`).join('') : '<p class="field-note">Your next favourite piece starts here. Save a design and it will appear in your workshop.</p>';
  } catch (e) { $('project-list').textContent = e.message; }
}
async function openDesign(id) {
  if (!mayLeave()) return;
  busy = true; sequence++; controller?.abort(); clearTimeout(timer); controls();
  try {
    const data = await api(`/api/designs/${id}`);
    result = data; designId = data.design.id; baseRevision = data.revision; template = data.design.template; params = { ...data.design.params };
    $('design-name').value = data.design.name; dirty = false; touched = false; valid = true; pending = false; step = 0; sheet = 0;
    forgetDraft(); clearError(); renderForm(); renderResult();
    $('save-state').textContent = 'Saved to your workshop'; $('preview-status').textContent = 'Preview up to date';
    $('build-result').hidden = true; $('projects-dialog').close();
  } catch (e) { message(e.message, true); pending = false; }
  finally { busy = false; controls(); }
}
$('design-form').addEventListener('submit', (e) => e.preventDefault());
$('design-form').addEventListener('input', () => { touched = true; readForm(); markDirty(); });
$('design-name').addEventListener('input', () => { touched = true; markDirty(); });
$('templates').addEventListener('click', (e) => { const b = e.target.closest('[data-template]'); if (b && b.dataset.template !== template) startTemplate(b.dataset.template); });
$('save-button').addEventListener('click', () => saveOrBuild(false));
$('build-button').addEventListener('click', () => saveOrBuild(true));
$('parts-button').addEventListener('click', () => $('parts-dialog').showModal());
$('projects-button').addEventListener('click', showProjects);
$('workshop-nav').addEventListener('click', () => $('designer').scrollIntoView({ behavior: 'smooth' }));
$('new-button').addEventListener('click', () => { if (mayLeave()) { dirty = false; startTemplate('bookshelf'); $('projects-dialog').close(); } });
$('project-list').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openDesign(b.dataset.open); });
$('connect-button').addEventListener('click', () => { $('mcp-url').textContent = `${location.origin}/mcp`; $('connect-dialog').showModal(); });
$('copy-endpoint').addEventListener('click', async () => { try { await navigator.clipboard.writeText(`${location.origin}/mcp`); message('MCP endpoint copied.'); } catch { message('Select the endpoint above to copy it.'); } });
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
document.querySelector('.view-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) { view = b.dataset.view; renderView(); } });
document.querySelector('.view-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault(); const tabs = [...document.querySelectorAll('[data-view]')], i = tabs.findIndex((b) => b.dataset.view === view);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  view = tabs[next].dataset.view; renderView(); tabs[next].focus();
});
$('view-details').addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) { step = Number(b.dataset.step); renderView(); } });
$('view-details').addEventListener('change', (e) => { if (e.target.id === 'sheet-picker') { sheet = Number(e.target.value); renderView(); } });
window.addEventListener('beforeunload', (e) => { if (dirty && busy) { e.preventDefault(); e.returnValue = ''; } });
async function init() {
  try {
    options = await api('/api/options'); params = { ...options.templates[0].defaults };
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey));
      if (draft && options.templates.some((t) => t.key === draft.template)) {
        template = draft.template; params = { ...options.templates.find((t) => t.key === template).defaults, ...draft.params };
        designId = draft.designId; baseRevision = draft.baseRevision; touched = true; $('design-name').value = draft.name; message('Your draft is back. Keep making it yours.');
      }
    } catch { /* Start with the default design when browser storage is unavailable. */ }
    renderForm(); remember(); await refreshPreview();
  } catch (e) {
    message(`Workshop connection: ${e.message} Refresh this page to try again.`, true);
    $('preview-status').textContent = 'Waiting for the workshop';
    $('drawing').textContent = 'Start the Aikea server, then refresh this page.';
  }
}
init();
