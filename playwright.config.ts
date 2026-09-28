import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4330', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1100 } } },
    { name: 'tablet', use: { browserName: 'chromium', viewport: { width: 900, height: 1000 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node dist/index.js --http',
    url: 'http://127.0.0.1:4330/health',
    reuseExistingServer: false,
    env: { HOST: '127.0.0.1', PORT: '4330', AIKEA_HOME: join(process.cwd(), '.aikea-browser-tests') },
  },
});
