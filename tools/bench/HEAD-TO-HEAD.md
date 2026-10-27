# Head-to-head speed test - how to time the other editors

Limelight Editor's column is timed automatically: `node tools/bench/headtohead.mjs` (results in `tools/bench/results`).
Premiere Pro, Final Cut Pro and DaVinci Resolve are timed by hand, **on the same PC**, with **the same files**
(`tools/bench/kit`, made by the script), with a stopwatch. Fill the empty columns of the results table.

Rules so the numbers are fair:
- Same PC, nothing else running (no renders, no copies, no zips). Restart the app before each task.
- Default settings of each app; GPU acceleration on where the app offers it. Write the app's version next to its column.
- The stopwatch starts at the click that begins the task and stops when the result is usable (plays smoothly / file done).
- Do every task twice and write the faster time.

| # | Task | Start the stopwatch | Stop it |
|---|---|---|---|
| 1 | Import `A001_4K_HEVC_20s.mp4` until it plays smoothly | drop the file into the project | you can scrub the clip without stutter (if the app makes proxies / optimized media, include that time) |
| 2 | Import the six `B00x_1080p_10s.mp4` clips | drop the six files | all six are ready to use |
| 3 | Export 60 s 1080p H.264, six plain cuts (B001 … B006 in order, 10 s each) | press Export (YouTube 1080p preset or H.264 1080p, 25 fps) | the file is written |
| 4 | Same 60 s with on every shot: exposure +0.2, saturation 115 %, contrast 110 %, Gaussian blur (small), a film look (grain + halation if the app has one), 1 s cross-dissolves | press Export | the file is written |
| 5 | Render 10 s of shot 3 with a render-only effect (Twirl or the app's nearest "render needed" effect) for smooth playback | Sequence > Render In to Out (Premiere: Enter; Resolve: Render Cache; FCP: Render Selection) | the render bar is green / cached |

Limelight-only work (no direct equivalent in the other three, timed separately when asked): a first cut from a Hinglish
brief (Agent), auto Hindi subtitles for 5 minutes, AI Fill of a logo, AI Roto of a person.

Publish only rows that were measured; never fill a cell with an estimate.
