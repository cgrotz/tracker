# Budget — a minimal calorie tracker

A single-page, offline-first calorie and weight tracker. No accounts, no server, no
dependencies, no build step: everything lives in `localStorage` on the device.

## Screens

- **Home** — the calories left today in green / yellow / red, then a 3x3 quick-add
  grid: your eight most-logged foods, with a fixed **Calories** tile in the last
  slot for manual entry. One tap logs a repeat food; the confirmation toast carries
  an **Undo**, because a mis-tap would otherwise silently cost you 600 kcal.
  Below the grid sits a search box with a barcode-scan button. Typing replaces the
  grid with results: your own foods first (matched locally, instantly), then Open
  Food Facts below them. While searching, the search box moves above the results so
  it does not get pushed off-screen. A "log today's weight" button appears until you
  have weighed in, and today's entries are listed underneath; tap one to edit or delete.
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

## Food lookup (Open Food Facts)

Adding food offers three routes: manual calories, name search, or a barcode scan.
Both lookups hit the public [Open Food Facts](https://de.openfoodfacts.org/data) API
directly from the browser — no key, no proxy, CORS is open.

- **Search** — `cgi/search.pl` on the German instance. Roughly 1.2 s per query, and
  **it fails intermittently**: the failing responses carry no `Access-Control-Allow-Origin`
  header, so the browser reports a CORS error and hides the status code. It recovers
  after a pause, which looks like throttling, but that cannot be confirmed client side.
  So search runs on submit only, never per keystroke, results are cached for the
  session, and the failure path always offers manual entry. Treat name search as best
  effort; barcode lookup (`/api/v2/product`) has been consistently reliable. The newer
  `search.openfoodfacts.org` endpoint is unusable here: it sends no CORS headers at all.
- **Barcode** — native `BarcodeDetector` (Chrome, Android) when present; otherwise
  ZXing is pulled from a CDN *only when you tap scan*, so the offline core stays
  dependency free. Both share one `facingMode: environment` camera stream. Needs
  HTTPS, which GitHub Pages provides.
- Products are cached by barcode in `S.foods`, so re-scanning a familiar item works
  with no signal. Anything you log becomes a quick-add chip, which is the real
  offline path.
- `energy-kcal_100g` is almost always present; `serving_size` is messy free text
  (`"62.5 g (1 tranche)"`, `"71,4g"`) and is parsed best-effort into a "1 serving"
  shortcut. The portion step always lets you override the grams.

Browsers forbid setting `User-Agent`, which is how Open Food Facts asks clients to
identify themselves, so the app passes `app_name` / `app_version` query parameters
instead. Worth re-checking against their current API policy.

Open Food Facts data is licensed under the
[Open Database License](https://opendatacommons.org/licenses/odbl/) (ODbL).

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
