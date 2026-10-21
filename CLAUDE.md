# Limelight Video Editor

This folder is the Limelight Video Editor (a local web app: `node server.mjs`, http://localhost:3000; projects in
`Projects/<name>/`). When the user asks you to edit a video, make a reel / song edit, or change a project:

1. Read `engine/claude-guide.md` - how to work as the editor here (the workflow, the craft rules and the project format).
2. Work through `node engine/edtool.mjs <command>` with the project chosen by `--p "<project name>"` (or `$VEDIT_PROJECT`).
   Run `node engine/edtool.mjs help` for the commands. Changes appear live in the user's open editor and can be undone there.
3. Look at footage before using it: `look` / `sheet` / `frames` make JPG contact sheets - Read them.

The editor server must be running. On the main PC it runs from the tray (`Limelight Editor (tray).vbs` -> `engine/tray.ps1`,
started with Windows; no console window, log in `logs/server.log`, restarts itself if it stops). Restart it from the tray
icon's menu, or stop its node process - the tray starts it again within seconds. Do not also run `Start Video Editor.bat`
while the tray is on (port 3000 would be taken). Before restarting it, check `GET /api/jobs` and the render queue - never
stop a running agent job or render.
