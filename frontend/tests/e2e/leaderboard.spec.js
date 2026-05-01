// @ts-check
const { test, expect } = require('@playwright/test');

// 2024 is the most recent fully-completed season as of this writing — its
// summary data won't drift mid-season. If you re-run these tests in a
// future year and 2024 returns sparse data, bump to the most recent
// completed season.
const STABLE_SEASON = 2024;

test.describe(`leaderboard /cfb/year/${STABLE_SEASON}/teams/differential`, () => {
    test('renders a leaderboard table with at least 100 rows', async ({
        page,
    }) => {
        await page.goto(`/cfb/year/${STABLE_SEASON}/teams/differential`);

        // The leaderboard renders a single primary table inside the
        // .container; each FBS team is a row.
        const rows = page.locator('table tbody tr');
        await expect(rows.first()).toBeVisible();
        const count = await rows.count();
        expect(count).toBeGreaterThanOrEqual(100);

        // Sanity check: the title should mention the season number. Catches
        // server-side rendering errors that produce a 200 with a default /
        // generic page.
        await expect(page).toHaveTitle(new RegExp(`${STABLE_SEASON}`));
    });
});
