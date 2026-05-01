// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('scoreboard /cfb/', () => {
    test('renders at least one game thumb and has no console errors', async ({
        page,
    }) => {
        const consoleErrors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', (err) => consoleErrors.push(err.message));

        await page.goto('/cfb/');

        // Title is always set by the head partial regardless of body
        // content, so this is the cheapest "the route resolved without
        // a 5xx" smoke check.
        await expect(page).toHaveTitle(/Game on Paper/);

        // The scoreboard renders one card per game with a link to the game
        // detail. There may be zero games on a true off-day, so this is a
        // soft assertion: we verify either ≥1 game card or the explicit
        // "no games" copy. Either is a healthy response.
        const gameLinks = page.locator('a[href*="/cfb/game/"]');
        const noGamesText = page.getByText('No games scheduled.');
        const hasGames = (await gameLinks.count()) > 0;
        const hasNoGamesCopy = await noGamesText.isVisible().catch(() => false);
        expect(
            hasGames || hasNoGamesCopy,
            'expected either game thumbs or the "No games scheduled." copy',
        ).toBeTruthy();

        // Filter out known-noisy console errors that aren't from our code:
        // browser extension churn, third-party script load order, ad
        // blockers blocking analytics. None of these indicate a real
        // regression and they're not stable across CI / local runs.
        const realErrors = consoleErrors.filter(
            (e) =>
                !/cloudflareinsights\.com/.test(e) &&
                !/plausible\.io/.test(e) &&
                !/extension/.test(e) &&
                !/asynchronous response by returning true/.test(e),
        );
        expect(realErrors, `unexpected console errors: ${realErrors.join('\n')}`).toEqual([]);
    });
});
