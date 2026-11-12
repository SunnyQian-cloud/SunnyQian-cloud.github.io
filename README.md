# Blockwise

A mobile-first planning web app for a small, voluntary student pilot. It answers one question:
**“What should I work on next, for how long, and why?”**

- Capture assignments, projects and test prep in one line (typed, pasted as a short list, or dictated), then review every field before saving.
- See the next seven days of deadlines, with tests and projects side by side.
Two screens:
- **Today:** what to do now or next (labelled "Now · A block · 10:30–11:15" or "Next · Study hours · 7:30"), "This session 25 min · 2 h left in total", and **Done** / **Not now**. Underneath, all of today block by block, in the same rows as Week: blocks that are over say "Over", the block you're in is marked "now", and classes show as grey lines. Shortfalls are combined into one warning.
- **Week:** every free block and study hour for the next 6 days as its own row, showing what's planned there or a blue "Free" tag. Classes appear as short grey "Class" rows in between, so the day reads like the real timetable. A test or anything due in a class block shows in that block's row with a "Test" or "Due" tag (no minutes); other due items are listed at the top of the day.

Also:
- Minutes on a test mean **study time** ("Bio test Tuesday, study 45 min"), and anything can be **in a class block** ("History test Friday, D block"), so free blocks earlier that day count.
- Students can **keep a free block free**: always (lunch, a club) or for one day, by tapping it on Week.
- Every task name opens the task to change, finish or delete it, and the **Tasks** tab lists everything.
- On phones, a card asks students to **add Blockwise to the Home Screen**, because iPhone Safari can erase site data after a week unused. **Copy my plan / Paste my plan** moves tasks into the Home Screen app.

Three actions at the top: **Edit schedule** (today-only changes, then classes & free blocks, week rotation and study hours), **+ Add task**, and **⋯** (all tasks, help, example, reminders, feedback, backup, start over).

Live site: https://sunnyqian-cloud.github.io (GitHub Pages; the repository holds only the app files).

The look is black and blue (dark theme, checked for contrast). A first-time visitor sees one welcome screen ("Free block. Now what?") with a two-second picture of a test turning into study time in a free block, then **Plan my next free block** or **See an example**. Students set it up once in two steps: pick the week by which blocks meet on Saturday (ECF, ADB, or no Saturday classes), then tap their free blocks (A–G). An optional **Check each day** grid, laid out like the printed schedule (Senate, Meet and Community time included), fixes blocks that aren't free every week on the same weekday; it starts folded on a phone and open on a computer. A short Getting started list follows; dorm study hours are built in. Weeks alternate on their own, and a day off or a busy evening is one switch. Three tabs: Today, Week (one day at a time on a phone, with the day buttons staying on screen; the whole week on a computer) and Tasks (everything in the order to work on it). Adding is one typed line (voice is off for the pilot; `?voice=1` turns it on for testing), checked as one tappable line before saving. **Add reminders to my calendar** makes a calendar file with an alert before every free block and study hours, with no server.

Everything runs in the browser. There's no account and no AI service. Plans stay in the browser's local storage on the student's device. The one thing sent anywhere is a few anonymous **usage counts** (approved by Middlesex for the pilot; see below).

## Run it

Requirements: any modern browser. Node 18+ is needed only for the local server and tests.

```bash
npm start            # serves the app at http://127.0.0.1:8080/
```

Any static file server works (for example `python3 -m http.server`). Opening `index.html` directly from disk (`file://`) won't work, because browsers block JavaScript modules there.

### Try the critical scenario

On Today, open **⋯ → Try the example day** (or use the button on the empty screen). The example day opens in a separate sandbox (with a simulated 4:00 PM clock when opened at another time of day). It never touches real data.

## Tests

```bash
npm test             # 64 unit tests: parsing, ranking, scheduling, week planning, reminders, storage (no dependencies)
npm run test:e2e     # 32 browser tests incl. accessibility scans (needs Playwright + Chrome)
```

To set up the browser tests on a new machine, run `npm install`, then `npm i -D playwright && npx playwright install chromium`. Alternatively, set `CHROME_PATH` to an installed Chrome. See [docs/TEST_REPORT.md](docs/TEST_REPORT.md) for what was actually run and what still needs checking on real devices.

## Project layout

```
index.html, styles.css      App shell and styles (no build step)
src/dates.js                Local-date and time helpers (DST/month/year safe)
src/model.js                Shared rules: kinds, buffers, deadline meaning, constants
src/parse.js                One-line and bulk parsing into editable drafts
src/rank.js                 Ranking and tiers (order only)
src/schedule.js             Free time, interval merging, chunk sizing, placement
src/plan.js                 Bounded allocation passes, plan output, "outdated" detection, explanations
src/store.js                localStorage wrapper, strict validation, export/import
src/voice.js                Optional Web Speech dictation wrapper
src/demo.js                 Fictional example day
src/schools/middlesex.js    Middlesex 2026–27 block grid (from the student planner) and dorm study hours
src/ics.js                  Calendar reminder file (repeating events with 5-minute alerts)
src/app.js, src/dom.js      UI (all task text rendered with textContent)
tests/unit, tests/e2e       Node test runner + Playwright
tools/serve.mjs             Tiny static server for dev and tests
docs/                       Rules, test report, pilot materials, reminders note, backlog, screenshots
```

## Hosting for the pilot (not done — needs your decision)

Nothing has been deployed. For a pilot, any free static host works, such as GitHub Pages, Netlify or Cloudflare Pages. Things to know first:

- **Use one permanent URL.** Browser storage belongs to the exact web address. If the address changes, students see an empty app and have to import a backup.
- **HTTPS is required** for the microphone on phones.
- Students should **export a backup** now and then. Clearing browser data deletes everything, and the backup file is the only way to recover.
- On some iPhones, a Home Screen icon opens a separate copy with its own storage. The in-app tip tells students how to move their data across with a backup.

## Privacy in this build

- Plans are in local storage only. No accounts or ads.
- **Usage counts (school-approved, Nov 2026).** To see whether students try Blockwise and come back, each phone sends a few step counts: first visit, opened (once a day), finished setup, made a first plan, did something (once a day), and came back in week 2 after a first plan. A count holds only the step, the date, the app version, an optional link label (`?src=xc`) and a random one-time code so a retried send isn't counted twice. It never holds task text, deadlines, classes, free blocks, names or typed text, and there's no ID that links one phone's counts together. Counts go to a private Google Sheet via `tools/blockwise-usage.gs` (Apps Script), which rejects anything else. The example day is never counted. Students see a note on the welcome screen (or a one-time notice if they started earlier) before anything is counted, and can turn it off in ⋯ → Usage counts. Start over clears it. Counts are phones/browsers, not people.
- Apart from usage counts, pages make no network requests other than loading the app itself. The exception is voice: the browser's own speech service may send audio to its maker (for example Google for Chrome) to transcribe it, and students see a notice explaining this before the microphone is used.
- Students are asked not to enter names, grades or ID numbers. Local storage isn't encrypted.
- Export (JSON), validated import with a summary and replace confirmation, and delete-all are in **⋯ Settings, data & help**.
- Feedback is copy-and-paste only. Nothing is submitted from the app.
- The reminder calendar file is made on the device and downloaded. Nothing is sent anywhere.

## Docs

- [How recommendations work](docs/RULES.md)
- [Test results and limitations](docs/TEST_REPORT.md)
- [10-minute usability script](docs/USABILITY_SCRIPT.md)
- [Two-week pilot plan](docs/PILOT_PLAN.md)
- [What a daily reminder would require](docs/REMINDERS.md)
- [Backlog](docs/BACKLOG.md)
