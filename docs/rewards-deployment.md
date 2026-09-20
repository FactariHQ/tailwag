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
npm test                                   # 188 tests
npm run push:portal                        # builds dist/portal (DOMAIN manifest + PORTAL_SPREADSHEET_ID), pushes
cd dist/portal && clasp create-deployment -i AKfycby48t97ewQQN3PBtg3O5889KZLLczGZP-os5vLPvLLubMkSUbpZfU-UEtdwKgSA2wL9
# Slack project: push src/ with its own .clasp.json, then
clasp create-deployment -i AKfycbwrMNnV9AL-RFPM_InEOMbehObIhmytfsj4SHzXvOXH-HwLcbQ6vmVAzKRfZibpD4X4
```
`create-deployment -i` updates in place, so the URLs never change. Check with `selfTestRewards()` in the
portal editor.

## Security fix shipped with this
Every top-level function without a trailing underscore is callable via google.script.run from any page
a web app serves. Before this release the anonymous Slack /exec page could call getConfigAll() and read
the bot token. Config accessors are now private, editor functions are owner-only, scheduled jobs accept
only their own trigger id. Rotating the Slack bot token is recommended.

## Open items
- GitHub: commits d0b3cf8 and 9b25326 are local to the build session; the session's git proxy has no
  write access to FactariHQ/tailwag. Needs the repo added to the session, or a push via the connector.
- No reward pods exist yet — prizes are Josh's call.
