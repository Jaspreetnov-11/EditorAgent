# Limelight Editor as a product - the plan to 10/10

What it takes to sell Limelight Editor against Premiere Pro / Final Cut Pro / DaVinci Resolve, item by item, in the
order to do it. Honest effort: a small team (2-3 developers + 1 support person), about 12-24 months in all.

| # | Item | What "done" means | Steps | Effort |
|---|---|---|---|---|
| 1 | **Licences cleared** | nothing in the product that a paid licence forbids | `docs/product/licence-check.md` - the six items at its end | 2-4 weeks |
| 2 | **Each customer's data kept separate** | one installation per customer (their own PC / server); or, hosted, one locked-off space per customer | today the editor is one office: logins, projects and chat are shared inside it. Product: a `tenant` on every project, user, chat, render and setting; every API checks it; files under `<data>/<tenant>/`; a test that one tenant can never read another's | 2-3 months |
| 3 | **Licence activation** | the editor runs only with a valid key; seats counted; works offline for 30 days | a licence server (signs keys: customer, seats, end date); the editor checks the signed key at start and once a day, keeps a 30-day grace offline; seats = signed-in editors at once; the owner page shows the licence | 1-2 months |
| 4 | **One-click installer** | download one .exe, next-next-finish, the editor opens | build from the Limelight Kit: Node, FFmpeg, Python + AI wheels, models (offered as "download AI packs" to keep the installer small), the editor, the tray, Limelight Editor.exe; Windows code-signing certificate (no SmartScreen warning); an uninstaller; a first-run wizard (folder for projects, admin login, licence key) | 1-2 months |
| 5 | **Update channel** | customers get updates by themselves, safely | today's release system (`tools/server/deploy.ps1`: tests, trial on a standby, then the server) becomes: releases signed and published to an update server in channels (stable / beta); the editor checks daily, downloads, and the tray brings it in when no job or render runs; one-click roll back to the previous release | 1 month |
| 6 | **Manuals** | a user manual, an admin guide and short videos | start from `engine/help-guide.md` and the help chat; a manual per page (Media, Edit, Motion, Nodes, Color, Audio, Labs, Presets, Deliver) with screenshots; an admin guide (install, users, helpers, backups, standby); 10 two-minute videos | 1-2 months |
| 7 | **Support** | customers can get help and we can fix fast | in-editor "Help > Report a problem" that sends the crash dashboard's entries + logs (with consent) to a support inbox; a ticket tool; response times per plan; the help chat answers first | 2-4 weeks, then a support person |
| 8 | **Proven at scale** | 100+ editors on one server, measured | the load test (simulated editors), then what it shows: a real database for projects / users instead of JSON files, projects spread over worker processes / servers | 2-3 months |
| 9 | **Speed proven** | published head-to-head numbers | `tools/bench/headtohead.mjs` + the hand timings in `tools/bench/HEAD-TO-HEAD.md`, on a clean PC, for each release | 1 week per round |
| 10 | **Security reviewed** | an outside security test passed | two-step login, expiring links (MeshLink for outside access), audit log, encrypted backups, then a paid penetration test | 1-2 months |

## Done already (October 2026)

- Code only after sign-in; browser code scrambled; Limelight Editor.exe locked (no DevTools, view source, save page).
- Releases tested before they go out, tried on the standby PC first, sent over SSH - never through the NAS.
- Crash dashboard (Mazbooti > Crashes), week-long test run (`tools/soak`), daily saves (`refs/daily/<date>`).
- Render bar like Premiere: red sections render in the background and play exactly.
- Licence check of every model, tool and font: `docs/product/licence-check.md`.
