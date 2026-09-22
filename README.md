# Budget — a minimal calorie tracker

A single-page, offline-first calorie and weight tracker. No accounts, no server, no
dependencies, no build step: everything lives in `localStorage` on the device.

## Screens

- **Home** — one number: the calories left today, in green / yellow / red. A
  "log today's weight" button that disappears once you have weighed in. Today's
  entries are listed underneath; tap one to edit or delete it.
- **History** — weight trend with a 7-day average, daily intake against budget,
  cumulative deficit, projected vs. measured weight change, and a week-by-week table.
- **Settings** — profile, rollover cap, backfilling a missed day.

## How the budget is calculated

```
maintenance = Mifflin-St Jeor BMR(7-day average weight, height, age, sex) x activity
dailyBudget = maintenance + goalKgPerWeek * 1100      (0.5 kg/week = 550 kcal/day)
bank        = sum of (budget - eaten) over the earlier days of this week
allowance   = dailyBudget + bank
```

The budget follows the **7-day average** weight, not the last reading, so day-to-day
water swings do not move it. Unspent calories roll over nightly into the rest of the
week; the week runs Monday–Sunday and the bank **resets Sunday at midnight**. The
surplus carried into a day is capped at one day's budget by default (Settings) so a
skipped day cannot hand you a 4000 kcal allowance.

After ~2 weeks of logging, the Deficit card compares projected against measured weight
change and tells you whether your activity setting is off.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. A service worker is only registered over
`http://localhost` or HTTPS.

## Deploy to GitHub Pages

1. Push this directory to a repository.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. The app is served from `https://<user>.github.io/<repo>/`.

All paths are relative and `.nojekyll` is present, so it works from a subpath as-is.
Bump `CACHE` in `sw.js` whenever you deploy, or clients will keep the cached shell.

## Data

Stored under the `caltrack.v1` key in `localStorage` — per browser, per device, never
uploaded. Clearing site data erases it. There is no export yet; that is the obvious
next addition.

## Files

| file | |
|---|---|
| `index.html` | shell |
| `app.js` | state, budget math, all views |
| `styles.css` | theming, light + dark |
| `sw.js` | offline cache |
| `manifest.webmanifest` | installable PWA |
