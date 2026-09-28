import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http.js";
import { designDir, listDesigns, loadDesign } from "../src/store.js";

let app: Server, base: string, home: string, id: string, revision: string;
const originalHome = process.env.AIKEA_HOME;
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'aikea-http-')); process.env.AIKEA_HOME = home;
  app = createApp();
  await new Promise<void>((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  if (originalHome === undefined) delete process.env.AIKEA_HOME; else process.env.AIKEA_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('browser workshop over HTTP', () => {
  it('serves the workshop, scripts, styles and health endpoint', async () => {
    const page = await fetch(base);
    expect(await page.text()).toContain('Made for <em>your</em> space.');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await fetch(base + '/app.js')).headers.get('content-type')).toContain('javascript');
    expect((await fetch(base + '/styles.css')).headers.get('content-type')).toContain('css');
    expect((await fetch(base + '/health')).status).toBe(200);
  });
  it('exposes the real template schemas and material choices', async () => {
    const options = await (await fetch(base + '/api/options')).json();
    expect(options.templates).toHaveLength(4);
    expect(options.templates[0].schema.properties.width.minimum).toBe(250);
    expect(options.materials.length).toBeGreaterThan(4);
  });
  it('previews without creating a saved project', async () => {
    const response = await post('/api/preview', { template: 'bookshelf', params: { height: 1500 } });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.design.overall.height).toBe(1500);
    expect(data.preview).toContain('<svg');
    expect(data.buildable).toBe(true);
    expect(listDesigns()).toHaveLength(0);
  });
  it('saves, lists and reloads a design with the same settings', async () => {
    const saved = await (await post('/api/designs', { template: 'bookshelf', name: 'Studio bookcase', params: { width: 700, height: 1500, depth: 280, adjustableShelves: 3 } })).json();
    id = saved.design.id; revision = saved.revision;
    const list = await (await fetch(base + '/api/designs')).json();
    expect(list[0].id).toBe(id);
    const loaded = await (await fetch(base + `/api/designs/${id}`)).json();
    expect(loaded.design.params).toMatchObject({ width: 700, height: 1500, depth: 280, adjustableShelves: 3 });
    expect(loaded.revision).toBe(revision);
  });
  it('builds and downloads the exact saved model plus instructions and cut files', async () => {
    const response = await post(`/api/designs/${id}/build`, {});
    expect(response.status).toBe(200);
    const kit = await response.json();
    const download = await fetch(base + kit.download);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    const zip = unzipSync(new Uint8Array(await download.arrayBuffer()));
    expect(JSON.parse(strFromU8(zip[`${id}/design.json`]))).toEqual(loadDesign(id));
    expect(Object.keys(zip).some((p) => p.endsWith('.dxf'))).toBe(true);
    expect((await fetch(base + kit.instructions)).status).toBe(200);
    expect((await fetch(base + kit.download, { method: 'HEAD' })).status).toBe(200);
  });
  it('supports partial revisions, rejects stale revisions, and retires stale downloads', async () => {
    const revised = await (await post('/api/designs', { template: 'bookshelf', design_id: id, expected_revision: revision, params: { width: 760 } })).json();
    expect(revised.design.params).toMatchObject({ width: 760, height: 1500, depth: 280 });
    expect((await fetch(base + `/files/${id}/${id}.zip`)).status).toBe(404);
    const stale = await post('/api/designs', { template: 'bookshelf', design_id: id, expected_revision: revision, params: { height: 1700 } });
    expect(stale.status).toBe(422);
    expect((await stale.json()).error).toContain('another client');
    const oldBuild = await post(`/api/designs/${id}/build`, { expected_revision: revision });
    expect(oldBuild.status).toBe(409);
  });
  it('returns useful errors for invalid settings and malformed JSON', async () => {
    const invalid = await post('/api/preview', { template: 'desk', params: { width: 20 } });
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error).toContain('width');
    const bad = await fetch(base + '/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('valid JSON');
    const large = await post('/api/preview', { template: 'cube', name: 'x'.repeat(70 * 1024) });
    expect(large.status).toBe(413);
  });
  it('enforces design checks on the browser build route', async () => {
    const d = await (await post('/api/designs', { template: 'bookshelf', params: { material: 'baltic_birch_18', height: 2000 } })).json();
    expect(d.buildable).toBe(false);
    const build = await post(`/api/designs/${d.design.id}/build`, {});
    expect(build.status).toBe(422);
    expect((await build.json()).error).toContain('Fix design errors');
  });
  it('checks the request origin, host and content type before accepting a write', async () => {
    const foreign = await fetch(base + '/api/designs', { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: JSON.stringify({ template: 'cube' }) });
    expect(foreign.status).toBe(403);
    const form = await fetch(base + '/api/designs', { method: 'POST', body: 'template=cube' });
    expect(form.status).toBe(415);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + '/api/designs', { headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(hostStatus).toBe(403);
  });
  it('limits downloads to design artifacts within the saved-design directory', async () => {
    writeFileSync(join(designDir(id), 'quotes.json'), JSON.stringify({ email: 'private@example.com' }));
    expect((await fetch(base + `/files/${id}/quotes.json`)).status).toBe(404);
    expect((await fetch(base + '/files/%2e%2e%2ffabricators.json')).status).toBe(404);
    expect((await fetch(base + '/files/%ZZ')).status).toBe(400);
    const outside = join(home, 'private.json'); writeFileSync(outside, '{}');
    const link = join(designDir(id), 'other.zip'); symlinkSync(outside, link);
    expect((await fetch(base + `/files/${id}/other.zip`)).status).toBe(404);
  });
  it('keeps MCP Streamable HTTP available beside the workshop', async () => {
    const client = new Client({ name: 'studio-http-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('aikea_design');
      const data: any = await client.callTool({ name: 'aikea_get_design', arguments: { design_id: id, full: true } });
      expect(JSON.parse(data.content[0].text).overall.width).toBe(760);
    } finally { await client.close(); }
  });
});
