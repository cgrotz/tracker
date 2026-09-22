# Budget — a minimal calorie tracker

A single-page, offline-first calorie and weight tracker. No accounts, no server, no
dependencies, no build step: everything lives in `localStorage` on the device.

## Screens

- **Home** — the calories left today in green / yellow / red, then a 3x3 quick-add
  grid: your eight most-logged foods, with a fixed **Calories** tile in the last
  slot for manual entry. One tap logs a repeat food; the confirmation toast carries
  an **Undo**, because a mis-tap would otherwise silently cost you 600 kcal.
  Below the grid sits a search box with a barcode-scan button. Typing replaces the
  grid with your own matching foods, instantly and with no network. Open Food Facts
  is searched only when you press Enter or tap the search button — see below for why. While searching, the search box moves above the results so
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
week; the week runs Monday–Sunday and the bank **resets Sunday at midnight**.

The **first week starts the day you begin tracking**, not the Monday before it, and
its budget is prorated to the days that remain — start on a Tuesday and you get a
six-day week at 6x the daily budget, not seven. Days before that date never
contribute to the rollover, so a midweek start cannot hand you a phantom surplus.
Backfilling an entry earlier than your start date moves the start date back to it. The
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

- **Search is throttled, hard.** Measured back to back from one IP after heavy use:
  **4/4 barcode lookups succeeded at ~45 ms, 1/4 searches succeeded**. Failed searches
  are rejected in ~60 ms with a response carrying no `Access-Control-Allow-Origin`
  header, so the browser reports a CORS error and hides the status code. Failure rate
  rises with how much you have searched recently and clears after a pause. Every
  search endpoint behaves this way — the German and world `cgi/search.pl`,
  `/api/v2/search`, and `search.openfoodfacts.org` (which additionally never returned
  a usable CORS response in any test).

  Consequences, all deliberate:
  - Remote search **never fires while typing**. An earlier 700 ms debounce did, which
    burned four or five requests per word on a phone — slow typing made every search
    fail, which is exactly how this was found. It now needs Enter or a tap.
  - A client-side guard stops at 8 remote searches per rolling minute and says so.
  - Every request retries up to **3 times with exponential backoff** (500, 1500,
    4500 ms plus jitter), inside `offGet`, so barcode lookups get it too. Bounded
    by three guardrails: a 15 s overall deadline, a ceiling of 20 actual requests
    per rolling minute, and a rule that only retries what can plausibly recover —
    network/CORS rejections, timeouts, 429 and 5xx. A 404 is an answer, not a
    failure, and is never retried. After that, the error and a **Try again** button.
  - Measured: four consecutive searches all succeeded, two of them on the second
    attempt — the retry turned two visible failures into results. It is not a cure.
    Push the endpoint hard enough and all four attempts still fail, which is why
    the failure path and local-first search still matter.
  - Results are cached per session, so repeating a query is free.
  - Barcode lookup (`/api/v2/product`) is unaffected and stays fast and reliable.
  Settings → **Food lookup → Test Open Food Facts** runs these probes on any device
  and reports what that browser actually gets back.
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

## Updating an installed app

The service worker is stale-while-revalidate, so a launch serves the cached build and
downloads the new one in the background. To avoid needing a second launch, the app
listens for a newly installed worker and shows an **Update ready — Reload** toast; it
also re-checks when the app returns to the foreground (at most every 15 min), since
iOS suspends a home-screen app rather than reloading it.

**Bump `CACHE` in `sw.js` on every deploy.** That byte change is what makes the
browser notice a new worker. Forget it and clients can launch forever without
updating. Never tell anyone to clear website data to force an update — on iOS that
also deletes every weight and entry.

## Data

Stored under the `caltrack.v1` key in `localStorage` — per browser, per device, never
uploaded. Clearing site data erases it, and on iOS a home-screen web app may keep its
own storage separate from Safari's, so data entered in one may not appear in the other.

Settings → **Data** has **Back up** and **Restore from backup**. Back up offers three
routes, because iOS download behaviour is inconsistent: the native share sheet
(`navigator.share` with a file), a plain file download, and the raw JSON as selectable
text with a copy button. Restore accepts a file or pasted text, validates the shape,
drops malformed rows, shows you the counts and asks before replacing anything.

## Files

| file | |
|---|---|
| `index.html` | shell |
| `app.js` | state, budget math, all views |
| `styles.css` | theming, light + dark |
| `sw.js` | offline cache |
| `manifest.webmanifest` | installable PWA |
