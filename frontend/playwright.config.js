// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright config for E2E smoke tests against a deployed environment.
 *
 * Default target is the fork's replica deployment at
 * sports.unseen-university.org. Override with the BASE_URL env var to point
 * at a different host (e.g. upstream gameonpaper.com once PR #164 is merged
 * and that production is on the new instrumentation):
 *
 *     BASE_URL=https://www.gameonpaper.com npx playwright test
 *
 * Until Tier 2 of the migration plan ships Cloudflare Pages preview URLs,
 * PR-triggered runs in CI also hit this default — there is no per-PR
 * preview environment for the fork yet. Acceptable since the replica is
 * already validated by every push via fork-deploy.yml.
 */
module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 30 * 1000,
    expect: {
        timeout: 10 * 1000,
    },
    fullyParallel: true,
    workers: 2,
    // ESPN's scoreboard endpoint aborts intermittently (~1-2% of requests
    // observed), which surfaces as a frontend 500 error page. One retry
    // absorbs that noise without hiding real regressions.
    retries: process.env.CI ? 2 : 1,
    reporter: process.env.CI
        ? [['html', { open: 'never' }], ['github']]
        : 'list',
    use: {
        baseURL: process.env.BASE_URL || 'https://sports.unseen-university.org',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium-desktop',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
