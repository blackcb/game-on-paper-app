// @ts-check
const { test, expect } = require('@playwright/test');

// Stable completed regular-season game from 2022. The same gameId is in
// the Day 2 Python snapshot fixtures, so any drift between server-side
// processing and rendered output should fail one set of tests or the other.
const STABLE_GAME_ID = 401403910;

test.describe(`game /cfb/game/${STABLE_GAME_ID}`, () => {
    test('renders score, drive table, and chart canvases', async ({ page }) => {
        await page.goto(`/cfb/game/${STABLE_GAME_ID}`);

        // The score is in the document title, e.g.:
        //   "Game: SomeTeam 24, OtherTeam 17 | Game on Paper"
        await expect(page).toHaveTitle(/\d+,\s+.*\d+\s*\|\s*Game on Paper/);

        // The WP and EPA chart canvases are referenced by id from the
        // anchor links and from the Chart.js initialization. They render
        // server-side as <canvas> elements; Chart.js draws into them on
        // load. Existence + non-zero size is the correctness check.
        const wpChart = page.locator('canvas#wpChart');
        await expect(wpChart).toBeVisible();
        const epChart = page.locator('canvas#epChart');
        await expect(epChart).toBeVisible();

        // The drive chart renders one section per drive, each labelled
        // "Drive Chart". A completed game should have many of these — at
        // least 10 is a comfortable lower bound for any ordinary game.
        const driveSections = page.getByText(/Drive Chart/);
        const driveCount = await driveSections.count();
        expect(
            driveCount,
            `expected at least 10 drive sections for a completed game, got ${driveCount}`,
        ).toBeGreaterThanOrEqual(10);
    });
});
