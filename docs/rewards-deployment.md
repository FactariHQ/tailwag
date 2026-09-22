# Tail Wag Rewards — deployment record (Sep 19 2026)

## What it is
Tailwags earn tickets (1 per tailwag received to pilot; TICKETS_PER_WAG_GIVEN = 0). Admins post reward
pods; staff put tickets into whichever pods they want; pods draw automatically at close, weighted by
tickets, without replacement. Tickets in a pod are spent win or lose; withdrawable until close; cancel
refunds. Fresh start: only tailwags given on/after 2026-09-19T17:07:13Z count. The automatic monthly
raffle is retired (RAFFLE_ENABLED = FALSE).

## Where things live
| Thing | ID / URL |
|---|---|
| Rewards site (staff open this) | https://sites.google.com/actaba.com/tail-wag-rewards (actaba.com only) |
| Portal Apps Script project "Tail Wag Rewards" | 1AWNy9ZWb0MCQmJPMjRs-IQGkk0AUuWEz3FZtktz0WHaQszZqWi82jEhm |
| Portal web app deployment (access DOMAIN) | AKfycby48t97ewQQN3PBtg3O5889KZLLczGZP-os5vLPvLLubMkSUbpZfU-UEtdwKgSA2wL9 |
| Slack Apps Script project "Tail Wag" | 1O_1Gl8sEkFiKJedzNmFKzKBAsv9oCybWyxowx6zjL0QXRafWAPm4ZwoY |
| Slack web app deployment (access ANYONE_ANONYMOUS, the URL Slack calls) | AKfycbwrMNnV9AL-RFPM_InEOMbehObIhmytfsj4SHzXvOXH-HwLcbQ6vmVAzKRfZibpD4X4 |
| Shared spreadsheet "Tail Wag" | 1bmsM9W6K1cEKmRkgLldE-yQYE-0xFefrAS4yIVUL_2w |
| Owner of all of the above | robots@actaba.com |

New tabs: Pods, Tickets (append-only wallet ledger), Winners. New Config keys: REWARDS_*,
TICKETS_PER_WAG_*, SLACK_APP_URL. Roster gained google_email.

Admins: ADMIN_USER_IDS (Josh U02MYB4DJMP) plus REWARDS_ADMIN_EMAILS = josh@actaba.com, robots@actaba.com.
Josh's Slack email is josh@factari.com and his Google login is josh@actaba.com, so his wallet shows once
the two are linked (Admin tab → Link → josh972 → josh@actaba.com).

## Redeploying (both projects run the same code)
```
npm test                                   # 206 tests (test/run.js + ideas.js + hide.js)
npm run push:portal                        # builds dist/portal (DOMAIN manifest + PORTAL_SPREADSHEET_ID), pushes
cd dist/portal && clasp create-deployment -i AKfycby48t97ewQQN3PBtg3O5889KZLLczGZP-os5vLPvLLubMkSUbpZfU-UEtdwKgSA2wL9
# Slack project: push src/ with its own .clasp.json, then
clasp create-deployment -i AKfycbwrMNnV9AL-RFPM_InEOMbehObIhmytfsj4SHzXvOXH-HwLcbQ6vmVAzKRfZibpD4X4
```
`create-deployment -i` updates in place, so the URLs never change. Check with `selfTestRewards()` in the
portal editor.

## Reward ideas (added Sep 21 2026)
Ideas tab on the site: staff nominate rewards, upvote each other's, and a picked idea pays its nominator
IDEA_SELECTED_TICKETS (20). "Make it a reward" pre-fills the pod editor and picking happens on save.
New sheet tab Ideas (created on first use, or by setupSpreadsheet/setupRewards), new Config keys
IDEAS_ENABLED, IDEA_SELECTED_TICKETS, IDEA_MAX_OPEN_PER_PERSON, new Tickets kind `idea`.

## Hiding finished rewards (added Sep 21 2026)
The staff Rewards tab shows live rewards only; drawn ones appear on Winners. Admin tab → Rewards has
**Hide from staff / Show to staff** on drawn or cancelled pods, which also takes their winners off the
staff Winners tab. It sets Pods.hidden_ts (the column is added on first use); nothing is deleted and no
tickets move. Deployed: portal @10, Slack @22.

## Reasons read as names (added Sep 22 2026)
A reaction reason is the message that was reacted to, and Slack hands that text back with people written
as `<@U09TWPG0H7Z>`. `humanizeMentions_` (01_Util.gs) turns mentions, group mentions, channel links and
URLs into plain text before the reason is stored, so nothing shows a raw id. Mentions become "@Name"
text, not live mentions — the reason is quoted in the channel, in a DM and on the site, and nobody wants
three pings. Rows stored before this are rendered the same way at display time (roster lookup only, no
Slack call): portal `ledgerForPage_`, `/wags feed`, `/wags @person`, App Home. Deployed: portal @11,
Slack @23.

## Security fix shipped with this
Every top-level function without a trailing underscore is callable via google.script.run from any page
a web app serves. Before this release the anonymous Slack /exec page could call getConfigAll() and read
the bot token. Config accessors are now private, editor functions are owner-only, scheduled jobs accept
only their own trigger id. Rotating the Slack bot token is recommended.

## Open items
- Live Apps Script matches `main` (Sep 22 2026: portal deployment @11, Slack deployment @23). Google's reauth policy expires the clasp token every few hours
  (`invalid_rapt`); in a cloud session, sign in with a two-step flow whose pending state survives
  workspace restarts, since a waiting `clasp login --no-localhost` process does not.
- The two test rewards (Threshold Reduction, drawn; $50 Gas Card, cancelled) are off the Rewards tab;
  click Hide from staff on each to take Threshold Reduction off Winners too.
- No real reward pods yet — prizes are Josh's call.
- Link josh972 to josh@actaba.com on the Admin tab so Josh's own wallet shows up.
- Rotate the Slack bot token (the old anonymous `/exec` page could read it before this release).
- `/wag-admin sync` to fill in the roster emails that are still blank.
