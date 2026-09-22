# Tail Wag

Peer recognition for Slack, backed by a Google Sheet you own.

Everyone gets a small, fixed number of **tailwags** to give away each period. Because the supply is scarce and refills on a clock, a tailwag means something — nobody can spam them, and nobody can hoard them either. Every tailwag carries a public reason, builds a leaderboard, unlocks badges at milestones, and earns **tickets** that people spend on the rewards they actually want.

Built for ACT, and configured out of the box with ACT's five clinical values as the value tags.

---

## What it does

**Three ways to give a tailwag**

```
/wag @sam covered two sessions at no notice on Tuesday
```

```
@sam :jackson: saved me two hours on the Denver auth today
```
Typed in any channel the bot is in. No slash command needed — the way HeyTaco works.

React with :jackson: on someone's message. Their message becomes the reason.

**Extras on the give syntax**

| You type | What happens |
|---|---|
| `/wag @sam @dana covered the weekend between them` | One tailwag each |
| `/wag @sam x2 carried the whole week` | Two tailwags to Sam |
| `/wag @sam :jackson::jackson::jackson: three sessions covered` | Three tailwags |
| `/wag @sam #real-world made it work at the daycare` | Tagged to a company value |

**Looking things up**

| Command | Shows |
|---|---|
| `/wags` | Your balance, badges, streak, raffle entries, with leaderboard buttons |
| `/wags leaderboard` | Top receivers this period |
| `/wags month` · `/wags all` | Monthly and all-time boards |
| `/wags given` | Most generous people |
| `/wags @sam` | Someone else's standing and recent recognition |
| `/wags feed` | The recent reasons |
| `/wags raffle` | Your odds this month |
| `/wags help` | The rules, rendered from the live config |

There is also an **App Home tab** — balance, badges with a progress bar, both leaderboards and the recent feed, no typing required — and a **web leaderboard page** for an office screen or an all-hands slide.

**Rules enforced**

- A fixed allowance per person per period, refilling automatically. Unused tailwags expire by default.
- No tailwags to yourself, to bots, or to deactivated accounts.
- A per-recipient cap, so two friends cannot farm each other.
- A minimum reason length, with the error message showing a good example.
- Managers draw from a separate pool, so manager praise doesn't crowd out peer praise.

**Rewards**

- **Badges** unlock automatically on lifetime tailwags received (10 / 25 / 50 / 100 / 250 by default) and on tailwags *given*, so generosity is recognized too.
- **Raffle**: every tailwag received is one entry in that month's drawing, drawn weighted on the 1st and announced in the channel. An occasional contributor still has a real chance; a standout has a proportionally better one.
- **Streaks** count consecutive periods in which you gave at least one tailwag.

---

## How to deploy it

Roughly 20 minutes, most of it clicking around in Slack.

### 1. Create the Apps Script project

Go to [script.google.com](https://script.google.com) → **New project**. Name it `Tail Wag`.

Either paste each file from `src/` into the editor (filenames matter — the number prefixes control load order), or use `clasp`:

```bash
npm install -g @google/clasp
clasp login
clasp create-script --type standalone --title "Tail Wag" --rootDir ./src
clasp push
```

`Leaderboard.html` must keep its `.html` extension; the `.gs` files keep theirs.

### 2. Bootstrap the spreadsheet

In the Apps Script editor, run **`setupSpreadsheet`**. Approve the permissions prompt when Google asks.

It creates the spreadsheet with all seven tabs, writes every config key with an explanation next to it, and generates a URL secret. The execution log prints the spreadsheet link and the secret — keep both.

> If you already have the Tail Wag sheet, put its ID in **Project Settings → Script Properties** as `OD_SPREADSHEET_ID` before running setup.

### 3. Deploy the web app

**Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: **Anyone**

"Anyone" is required — Slack's servers are anonymous to Google. The URL secret is what actually guards the endpoint; see [Security](#security) below.

Copy the `/exec` URL. Your Request URL is that plus the secret:

```
https://script.google.com/macros/s/AKfy…/exec?k=YOUR_URL_SECRET
```

Running **`showRequestUrl`** prints it assembled for you.

### 4. Create the Slack app

[api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → pick the workspace → paste `slack/manifest.json`.

Before pasting, replace all four occurrences of `REPLACE_WITH_WEB_APP_URL` with the Request URL from step 3. The same URL goes in all four places — slash commands, events, and interactivity all route through one endpoint.

Then **Install to Workspace**.

> Slack verifies the events Request URL immediately by sending a challenge. If it fails, the web app is not deployed with "Anyone" access, or the `?k=` secret is wrong or missing.

### 4b. Add the emoji

`assets/jackson-emoji.png` and `assets/jackson-tailwag.gif` are the two workspace emoji this
runs on: **`:jackson:`**, the trigger, and **`:jackson-tailwag:`**, a 1.6-second loop for
threads. Add them at **Settings → Customize → Emoji → Add Custom Emoji**.

Slack's limits are 128×128 and 128KB; both files are inside them. Name yours whatever you
like and set `EMOJI_TRIGGER` to match — message runs, badges and the give-by-reaction path
all read that one key, so the whole app follows.

### 5. Wire up the credentials

Open the spreadsheet's **Config** tab and fill in:

| Key | Where to get it |
|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`) |
| `ALLOWED_TEAM_ID` | Left blank, `selfTest` fills it in for you |
| `ANNOUNCE_CHANNEL` | The channel for digests and raffle draws, e.g. `#kudos` |
| `ADMIN_USER_IDS` | Your Slack user ID — profile → ⋮ → Copy member ID |

Invite the bot where it needs to be:

```
/invite @Tail Wag
```

In `#kudos`, and in any channel where people should be able to give by typing or reacting.

### 6. Turn on the schedule and check the wiring

Run **`installTriggers`**, then **`selfTest`**.

`selfTest` checks the token, the channel membership, the spreadsheet, the trigger and the deployment, and prints exactly what is missing. It sends nothing to your team.

### 7. Take it for a spin before anyone sees it

```
/wag @yourself testing    ← refused, as designed
/wag @a-colleague thanks for helping with the thing this morning
/wags
/wag-admin status
```

Run **`seedDemoData`** to populate the boards with five fictional people so you can see what a busy week looks like, then **`clearDemoData`** to wipe every trace.

---

## Configuration

Everything lives on the **Config** tab, each key with a plain-English note beside it. Changes take effect within five minutes (config is cached), or immediately after any `/wag-admin set`.

### The dials that matter most

| Key | Default | Notes |
|---|---|---|
| `ALLOWANCE_PERIOD` | `week` | `week` or `day`. **HeyTaco refills daily** — set this to `day` to match that rhythm exactly. Switching is safe at any time; balances roll over to the new cadence on the next tailwag. |
| `ALLOWANCE_PEER` | `5` | Tailwags per person per period |
| `ALLOWANCE_MANAGER` | `5` | The separate manager pool |
| `MAX_PER_RECIPIENT_PER_PERIOD` | `2` | `0` removes the cap |
| `CARRY_OVER_UNUSED` | `FALSE` | `FALSE` makes tailwags expire, which is what keeps people spending them |
| `MIN_REASON_CHARS` | `12` | |
| `ANNOUNCE_IN_SOURCE_CHANNEL` | `TRUE` | `FALSE` routes every announcement to `ANNOUNCE_CHANNEL` instead |
| `DM_RECIPIENT` | `TRUE` | So recognition lands even if they miss the channel |
| `EMOJI_TRIGGER` | `jackson` | The custom Slack emoji of Jackson. Change it and the whole app follows — message runs, badges and the trigger all read this key |
| `VALUE_REQUIRED` | `FALSE` | Turn on once the value-tagging habit sticks |
| `PAUSED` | `FALSE` | Read-only mode: boards still work, giving is refused |

### Company values

Pre-loaded with ACT's five clinical values:

| Tag | Value |
|---|---|
| `#exceptional-care` | Exceptional Clinical Care |
| `#understand` | Understand, Don't Judge |
| `#bigger-lives` | Build Bigger Lives |
| `#real-world` | Make It Work in the Real World |
| `#collaborate` | Collaborate & Be Transparent |

Tags resolve on any unambiguous prefix, so `#collab` and `#real` both work. Edit `VALUE_TAGS`, `VALUE_LABELS` and `VALUE_EMOJI` to change them — keep the three lists the same length and in the same order. The weekly digest and the web page both report what share of recognition went to each value, which is a genuinely useful read on what the team actually rewards versus what the values poster says.

---

## Admin commands

| Command | What it does |
|---|---|
| `/wag-admin status` | Totals, participation, and the live config at a glance |
| `/wag-admin grant @user 3 reason` | Award tailwags from nowhere — doesn't touch anyone's allowance |
| `/wag-admin topup @user 5` | Add to someone's remaining allowance |
| `/wag-admin set KEY value` | Change a setting without opening the sheet |
| `/wag-admin keys` | List the settable keys |
| `/wag-admin reset confirm` | Refill everyone immediately |
| `/wag-admin draw [2026-08]` | Run a raffle drawing on demand |
| `/wag-admin digest` | Post the digest now |
| `/wag-admin pause` / `resume` | |
| `/wag-admin sync` | Pull the member list from Slack onto the roster |
| `/wag-admin rebuild confirm` | Recompute every balance from the ledger |
| `/wag-admin whoami` | Your ID, pool and workspace |

Secrets cannot be set from Slack — `set SLACK_BOT_TOKEN` is refused on purpose. Destructive commands require the word `confirm`.

---

## Rewards — tickets and prize pods

Tailwags earn tickets. The org puts up **reward pods** — an extra PTO day, a gift card, lunch with the CEO — and everyone decides for themselves which pods to put their tickets in. More tickets in a pod means better odds in that pod's draw. It replaces the old automatic monthly raffle, which `setupRewards()` switches off.

### The rules

| | |
|---|---|
| **Earning** | Every tailwag you **receive** earns `TICKETS_PER_WAG_RECEIVED` tickets (1 to start). `TICKETS_PER_WAG_GIVEN` can reward generosity too (0 to start; 0.5 or 1 work). Admin-granted tailwags pay the receiver, never the admin. |
| **Fresh start** | Only tailwags given on or after `REWARDS_LAUNCH_TS` count. `setupRewards()` stamps it once. |
| **Rate changes** | Forward-only. Tailwags already credited keep the rate they were earned at; the portal credits everything outstanding at the old rate before switching. |
| **Entering** | Pick a number of tickets per pod. Tickets leave your wallet the moment you enter. Take them back out any time before the pod closes. |
| **Drawing** | At the close time the pod draws automatically (within 15 minutes): weighted by tickets, without replacement, so nobody wins the same pod twice. **Every ticket in the pod is spent, win or lose.** |
| **Cancelling** | An admin can cancel a pod; every ticket in it is refunded. |
| **Bonus tickets** | Admins can grant tickets (work anniversaries, launch bonus), or remove them — never below zero. The reason shows in the person's history. |
| **Cooling off** | `REWARDS_EXCLUDE_RECENT_WINNERS_DAYS` keeps recent winners out of new draws, refunding their tickets. 0 by default. |

### Where people see it

- **The rewards site** — a web app embedded in the ACT Google Site, signed in with the actaba.com Google account. Tabs: *Rewards* (open pods with a ticket stepper and a live win-chance, and what's coming up — drawn rewards move to *Winners*), *Ideas* (nominate and upvote rewards), *My tailwags* (every reason people gave, given and received, badges and progress), *Winners*, *Ticket history*, and for admins, *Admin*.
- **Slack** — `/wags rewards` (also `tickets`, `prizes`), a Rewards section on the App Home tab, a line in `/wags help`, and a "+1 ticket" note on every recipient DM.
- **#kudos** — a post when a pod opens, a reminder 24 hours before it closes, and the draw result. Winners are DMed.

### Reward ideas

The **Ideas** tab lets anyone nominate a reward they would like to win. Everyone can upvote (not their own), the board sorts by votes, and when an admin picks an idea its nominator earns `IDEA_SELECTED_TICKETS` tickets (20 to start).

| | |
|---|---|
| **Nominating** | A name (4–80 characters) and optional details. An idea already on the board under the same name is refused with a nudge to upvote it. `IDEA_MAX_OPEN_PER_PERSON` (5) caps how many of one person's ideas can wait at once. The nominator can withdraw an open idea. |
| **Picking** | *Make it a reward* opens the pod editor pre-filled from the idea; saving the pod picks the idea, links the two and pays the nominator. *Pick* pays without making a pod. Picking is final and pays once — the payout is a Tickets row with ref `idea:<id>`, so a double click, a retried request or someone resetting the row by hand cannot pay twice. |
| **Declining** | *Decline* pays nothing and closes voting; an admin can *Reopen* it later. |
| **Announcing** | A pick is posted to the announcement channel and DMed to the nominator (following `REWARDS_ANNOUNCE_PODS` and `REWARDS_DM_WINNERS`). `/wags rewards` and `/wags help` point people at the Ideas tab. |
| **Settings** | Admin tab → Settings: the payout, and a switch to hide the Ideas tab (`IDEAS_ENABLED`). |

Staff see who nominated each idea and the vote counts; only admins see who voted. Ideas live on an **Ideas** tab in the sheet, written only by the portal project like the other rewards tabs.

### The Admin tab

Totals across the economy (earned, granted, unspent, in open draws, spent, pending), a pod editor (title, description, prize, emoji or image, winners, per-person cap, open and close times, draft or publish), every pod with who is in it and **Draw now / Cancel**, **Hide from staff / Show to staff** on drawn or cancelled pods (takes them off the Winners tab without deleting anything or moving a ticket), winners with a *Prize delivered* checkbox, everyone's wallet with a bonus-ticket grant, the earn-rate settings, and the recent ticket activity. Admins are anyone in `ADMIN_USER_IDS`, plus any Google email listed in `REWARDS_ADMIN_EMAILS`.

### The data

Four more tabs:

| Tab | Holds |
|---|---|
| **Pods** | One row per reward. `status` is `draft`, `live`, `drawn` or `cancelled`; "opening soon / open / awaiting draw" is derived from the times so it can never go stale. `hidden_ts` is set when an admin hides a finished pod from staff. |
| **Tickets** | Append-only wallet ledger. Every row is a signed delta: `earn_received`, `earn_given`, `grant`, `idea`, `enter` (−), `withdraw` (+), `refund` (+). A wallet is the sum of a person's rows; what they have in a pod is minus the sum of that pod's rows. Nothing is edited in place, so the tab is its own audit trail. |
| **Winners** | One row per winner per draw — tickets in, tickets in the pod, entrants, the random roll that picked them, and delivery status. |
| **Ideas** | One row per nominated reward idea — nominator, status (`open`, `selected`, `declined`, `withdrawn`), the upvoters, and what was paid and which pod it became. |

Earned tickets are copied from the Ledger into Tickets by the 15-minute job (and before every entry). Until then they show as *pending* at the current rate, so balances are always exact. `REWARDS_ACCRUAL_CURSOR` (`row|id`) remembers how far it got, so it reads only new Ledger rows; if someone deletes Ledger rows by hand it rescans, and the per-row `ref` stops anything being credited twice.

### Two Apps Script projects, one sheet

Slack must reach the web app anonymously; the rewards site must know who is signed in. A web app's access setting comes from the manifest, so one deployment cannot do both. The same code therefore goes to two projects that share the spreadsheet:

| Project | Manifest `webapp.access` | Serves | Writes |
|---|---|---|---|
| **Tail Wag** (Slack) | `ANYONE_ANONYMOUS` | Slack commands, events, the keyed leaderboard page | Ledger, Balances, Badges, Roster |
| **Tail Wag Rewards** (portal) | `DOMAIN` | The rewards site | Pods, Tickets, Winners |

Each tab has one writer, which matters because `LockService` locks are per project. `setupRewards()` records the portal project's id in `REWARDS_JOB_SCRIPT_ID`, and every rewards write — entering, drawing, granting, crediting — refuses to run anywhere else, so the two projects can never race each other or draw the same pod twice. `setupRewards()` itself refuses to run in the Slack project (only the portal build carries `PORTAL_SPREADSHEET_ID`), and refuses to let a second project quietly take over.

Until `setupRewards()` runs, `REWARDS_ENABLED` is FALSE and there is no launch time, so nothing earns and nothing shows as pending — an empty launch time is never read as "count the whole history".

### People whose Google login differs from their Slack email

The site finds you by your Google login, matched to the Slack email on the Roster. If they differ (Slack on factari.com, Google on actaba.com), an admin links them on the Admin tab under **Link**, which writes the Roster's `google_email` column. Roster sync never touches that column. Anyone in `REWARDS_ADMIN_EMAILS` who has no Slack match still gets the Admin tab, just no wallet.

`selfTestRewards()` (run from the rewards project's editor) checks the whole wiring: project ownership, triggers, the Slack cache ping, a real write round trip on a throwaway draft pod that it removes, and which admins and roster people can be recognized.

### Deploying the rewards site

```bash
cp portal/.clasp.json.example portal/.clasp.json   # scriptId of the new project + the Tail Wag spreadsheetId
npm run push:portal                                # builds dist/portal with the DOMAIN manifest, pushes it
```

1. Create a new standalone Apps Script project (owned by the same account as the Slack one), and put its id in `portal/.clasp.json` with the spreadsheet id.
2. `npm run push:portal`. The build compiles the spreadsheet id in, so the project finds the shared sheet on its own.
3. In the editor, run **`setupRewards`** and approve the permissions. It adds the tabs and settings, stamps the launch, retires the monthly raffle, and installs the 15-minute job.
4. **Deploy → New deployment → Web app**, Execute as **Me**, Who has access **Anyone within actaba.com**.
5. Embed the `/exec` URL in a Google Site page (Insert → Embed → By URL, full width), publish the site to actaba.com, and put the site page's URL into `REWARDS_PORTAL_URL` (Admin tab → Settings).
6. Push the Slack project too (`clasp push`, then Manage deployments → New version) so `/wags rewards` and the App Home section go live.

---

## The data

Seven core tabs (plus the four rewards tabs above), all readable by a human:

| Tab | Holds |
|---|---|
| **Config** | Every setting, with notes |
| **Roster** | Everyone, their pool, and whether they're active |
| **Ledger** | Append-only, one row per give — the source of truth |
| **Balances** | One row per person: allowance, spend, totals, badges, streak |
| **Badges** | Every badge awarded, with a timestamp |
| **Raffle** | Entries and winners by month |
| **Events** | Structured log, pruned to the last 5,000 rows |

**The Ledger is authoritative.** Balances is a denormalized cache of it, maintained for speed. If a number ever looks wrong — someone edited a cell, a run was interrupted — `/wag-admin rebuild confirm` recomputes every balance from the ledger and the discrepancy disappears. That command is tested, including the subtle case that an admin grant must not count against the granting admin's own generosity total.

### Why the hot path never reads the ledger

Slack allows three seconds for a slash command, and Apps Script runs synchronously with no way to reply early. So everything a `/wag` needs — remaining allowance, tailwags already sent to this person this period, the recipient's running totals and badge state — lives on that person's single Balances row. A give is: a cached config read, two single-row reads, two single-row writes, one append, and one parallel batch of Slack calls. The public announcement is returned as the HTTP response itself rather than as a separate `chat.postMessage`, which saves a whole round trip on every tailwag. Leaderboards read the Balances tab, never the ledger. The ledger is scanned only by the digest, the feed and the rebuild, none of which are on a clock.

---

## Security

**Apps Script web apps cannot read HTTP request headers.** Slack's documented verification scheme signs each request with an `X-Slack-Signature` header, so the standard HMAC check is not available to a direct Apps Script deployment. Pretending otherwise would be security theatre. Here is what actually guards the endpoint:

1. **A URL secret.** A 40-character random value appended to the Request URL as `?k=…`. Only Slack and you know the full URL; it travels over TLS to Google and never appears in a message. This is the primary shared secret.
2. **A workspace allowlist.** Every Slack payload carries `team_id`. Anything from another workspace is rejected before it reaches any logic.
3. **The legacy verification token**, checked as a second factor when `SLACK_VERIFICATION_TOKEN` is set.
4. **Real HMAC verification**, implemented and tested, which runs automatically if you ever put a proxy in front that copies the signature and timestamp into form fields (`slack_signature`, `slack_timestamp`) — or if you move the app to a host that can read headers.

For an internal recognition app this is a solid bar: an attacker needs the unguessable deployment URL *and* your workspace ID to forge a tailwag, and every tailwag is attributed and visible in a public channel. If you later want header-based verification, `verifySlackSignature_` is ready and `SLACK_SIGNING_SECRET` is the only config to fill in.

**Editor-only functions are guarded.** Apps Script lets any page a web app serves call every top-level function whose name doesn't end in `_`, through `google.script.run`. For the Slack deployment that means anyone who loads the `/exec` URL. So the config accessors are private (`cfgStr_`, `setConfig_`, … — the bot token cannot be read from a page), the setup and trigger functions check that the caller is the script owner (`ownerOnly_`), the scheduled jobs accept only their own trigger's unique id or the owner (`calledByOwnTrigger_`), and every portal function resolves the signed-in person itself rather than trusting an id from the browser.

**Rotating the secret:** change `URL_SECRET` on the Config tab, then update the four Request URLs in the Slack app. Do it in that order and the window of exposure is the time between the two steps.

The web leaderboard page uses the same secret, so the link is safe to pin in a channel but should not be posted anywhere public.

---

## Tests

```bash
npm test          # node test/run.js && node test/ideas.js && node test/hide.js
```

206 tests, no network and no Google account required. `test/harness.js` recreates enough of the Apps Script runtime — `SpreadsheetApp` with real 1-indexed range semantics, `Utilities.formatDate` with genuine timezone handling, `CacheService`, `PropertiesService`, `LockService`, `UrlFetchApp`, `ScriptApp` — to load the actual `.gs` files into a Node VM. The tests exercise the real code, not a reimplementation of it, and the fake spreadsheet is a real 2D array so off-by-one bugs in the store layer surface exactly as they would in production.

The fake sheet also lies the way Sheets lies: it coerces a string like `"2026-09"` into a Date, turns a leading `=` into a live formula, and strips the apostrophe that forces a cell to text. That matters — a version of this app that passed a naive test suite would have reported zero monthly tailwags and an empty raffle forever, because Sheets silently reinterprets the period keys.

Covered: period-key boundaries including the Monday turnover in local time and the New Year straddle; every branch of the give parser; allowance and cap enforcement including partial gives; badge and streak logic; weighted raffle selection with a seeded RNG; emoji and reaction giving including Slack's retry behavior; all four authentication paths including real HMAC verification against Node's crypto; the admin commands; and the failure modes — a held lock, a dead Slack API, a missing token, a wiped cache, a garbage request body.

The final suite, `Regressions — found in adversarial review`, pins eighteen defects found by reviewing the finished code: the date coercion above, a formula-injection path that could have exfiltrated the bot token, a lost update when giver and receiver are the same row, a stale row index overwriting someone else's totals, a dead App Home button, and a daily-mode streak that never accumulated east of UTC+12.

---

## Operating notes

- **The Monday digest** posts last week's leaderboard, the most generous people, and the value breakdown. A silent week produces no post rather than an embarrassing empty one.
- **Reward pods** draw within 15 minutes of their close time. Every step of the rewards job — crediting, opening posts, reminders, draws — is idempotent.
- **The legacy raffle** (off once rewards are set up) draws on the 1st, weighted by entries, and skips the month if participation was under `RAFFLE_MIN_ENTRIES_TO_DRAW`. Last month's winner is excluded by default.
- **Slack retries** any event it doesn't hear back from within three seconds. Every event path claims the event by message timestamp *before* doing work, so a slow run produces a dropped duplicate rather than a double award.
- **One daily trigger** at `DIGEST_HOUR` handles everything scheduled — Apps Script has no monthly trigger, so the job works out for itself what today is.
- **Allowances roll forward lazily**, on read, not only on the trigger. A missed trigger can never hand anyone a stale allowance.
- **Apps Script quotas**: 20,000 UrlFetch calls and 90 minutes of runtime per day on a Workspace account. A tailwag costs roughly 2–5 fetches. A team of 200 people giving 5 tailwags a week each uses well under 1% of that.

## Rolling it out

Recognition apps die when nothing happens in the first week. What works:

1. Start with `VALUE_REQUIRED` off and `MIN_REASON_CHARS` at 12. Add friction later, not on day one.
2. Seed it. Give ten tailwags yourself, in public, with reasons long enough to be worth reading. People copy the format they see first.
3. Say what a tailwag is *for* in the announcement — "you noticed something someone did that made your job easier" beats "recognize your colleagues".
4. Have two or three pods live on day one, at different sizes — something small that draws this week and something big that draws at month end. An abstract prize motivates nobody.
5. Read the value breakdown in the digest after a month. If one value gets 70% of the tailwags and another gets none, that is information about the business, not about the app.

---

## Files

```
src/
  appsscript.json      Manifest, scopes, web app config
  00_Config.gs         Config schema, defaults, typed accessors, badge/value ladders
  01_Util.gs           Period keys, caching, logging, text helpers
  02_Store.gs          Sheet data layer: roster, balances, ledger, badges, raffle
  03_Slack.gs          Web API client (incl. parallel fetchAll), Block Kit builders
  04_Security.gs       Request authentication, HMAC verification, owner-only guard
  05_Kudos.gs          Give parsing, validation, the transaction, leaderboards
  06_Messages.gs       Everything the app says
  07_Commands.gs       /wag, /wags, /wag-admin
  08_Events.gs         Emoji giving, reaction giving, interactivity
  09_Views.gs          The App Home tab
  10_Triggers.gs       Digest, raffle draw, roster sync, rebuild
  11_WebApp.gs         doPost router; doGet serves the leaderboard or the rewards site
  12_Setup.gs          Bootstrap, self-test, demo data
  13_Rewards.gs        Tickets, pods, entering, drawing, the 15-minute rewards job
  14_Portal.gs         The rewards site: identity, page data, admin actions
  15_RewardsSlack.gs   /wags rewards and the App Home rewards section
  16_Ideas.gs          Reward ideas: nominating, upvoting, picking and paying the nominator
  Leaderboard.html     The web leaderboard page
  Portal.html          The rewards site
  PortalLogo.html      Jackson, inlined for the rewards site
portal/                .clasp.json for the rewards project (scriptId + spreadsheetId)
scripts/build-portal.js  Builds dist/portal with the DOMAIN manifest
slack/manifest.json    Paste into Slack to create the app
test/harness.js        Apps Script runtime shim
test/run.js            188 tests
test/ideas.js          10 reward-ideas tests
test/hide.js           8 hide-from-staff and mention-rendering tests
```
