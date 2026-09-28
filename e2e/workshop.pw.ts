import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

test('design, inspect, save, download and reopen a furniture kit', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save design', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workshop.png'), fullPage: true });
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('740');
  await page.getByRole('spinbutton', { name: 'Height', exact: true }).fill('1600');
  await page.getByRole('spinbutton', { name: 'Depth', exact: true }).fill('250');
  const name = `Alcove ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Design name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save design', exact: true }).click();
  await expect(page.getByText('Saved to your workshop', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Exploded', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-exploded');
  await page.screenshot({ path: testInfo.outputPath('exploded.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Assembly', exact: true }).click();
  await page.getByRole('button', { name: 'Next assembly step', exact: true }).click();
  await expect(page.getByText('Step 2 of 6', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Cut layout', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'CHOOSE A SHEET', exact: true })).toHaveValue('0');
  await page.getByRole('combobox', { name: 'CHOOSE A SHEET', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Explore parts & hardware', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Parts & hardware', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Anti-tip kit');
  await page.getByRole('button', { name: 'Close parts and hardware', exact: true }).click();
  await page.getByRole('button', { name: 'Build my kit', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download kit', exact: false }).click();
  const zipPath = await (await download).path();
  const zip = unzipSync(readFileSync(zipPath!));
  const model = JSON.parse(strFromU8(zip[Object.keys(zip).find((key) => key.endsWith('/design.json'))!]));
  expect(model.overall).toEqual({ width: 740, depth: 250, height: 1600 });
  expect(model.name).toBe(name);
  await page.getByRole('tab', { name: 'Assembled', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('kit-ready.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Save design', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'My designs', exact: true }).click();
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('740');
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('1600');
  await expect(page.getByRole('spinbutton', { name: 'Depth', exact: true })).toHaveValue('250');
  expect(errors).toEqual([]);
});

test('restores a draft and gates invalid fabrication settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save design', exact: true })).toBeEnabled();
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('760');
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('760');
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('20');
  await expect(page.getByRole('button', { name: 'Build my kit', exact: true })).toBeDisabled();
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('760');
  await page.getByRole('combobox', { name: 'Panel material', exact: true }).selectOption('baltic_birch_18');
  await expect(page.getByText(/does not fit a 1525/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build my kit', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Panel material', exact: true }).selectOption('plywood_18');
  await expect(page.getByRole('button', { name: 'Build my kit', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Assembled', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Exploded', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('switches between all templates with working defaults', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Build my kit', exact: true })).toBeEnabled();
  for (const name of ['Cabinet', 'Storage cube', 'Desk', 'Tideline', 'Bookcase']) {
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(page.getByRole('button', { name: 'Build my kit', exact: true })).toBeEnabled();
    await expect(page.getByRole('img', { name: new RegExp(`^${name}: assembled`) })).toBeVisible();
  }
});

test('makes a Tideline art piece with a chosen finish', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Build my kit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Tideline', exact: true }).click();
  await expect(page.getByRole('img', { name: /^Tideline: assembled/ })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('1664');
  await page.getByRole('combobox', { name: 'Accent finish', exact: true }).selectOption('ink');
  const name = `Tideline ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Design name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Build my kit', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download kit', exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'My designs', exact: true }).click();
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Accent finish', exact: true })).toHaveValue('ink');
  await expect(page.getByRole('img', { name: /^Tideline: assembled/ }).locator('polygon[fill="#294B50"]').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('tideline.png'), fullPage: true });
});
