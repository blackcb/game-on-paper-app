// Hardcoded current season — matches the Express stack's literal 2025
// at frontend/cfb/routes.js:692, :697, :716, :880, :885 and the
// cache-first percentile clamp at routes.js:439. When the next CFB
// season starts, bump this in lockstep with the Express constant
// (eventually both sides should derive it from the date — see the
// "change after week 4" comment in routes.js).
export const CURRENT_SEASON = 2025;

// Minimum supported season. The summary service has no data before
// this; recursive year-fallback in the Express stack stops here too.
export const MIN_SEASON = 2014;
