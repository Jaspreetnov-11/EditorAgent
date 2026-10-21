# Limelight Video Editor

This folder is the Limelight Video Editor (a local web app: `node server.mjs`, http://localhost:3000; projects in
`Projects/<name>/`). When the user asks you to edit a video, make a reel / song edit, or change a project:

1. Read `engine/claude-guide.md` - how to work as the editor here (the workflow, the craft rules and the project format).
2. Work through `node engine/edtool.mjs <command>` with the project chosen by `--p "<project name>"` (or `$VEDIT_PROJECT`).
   Run `node engine/edtool.mjs help` for the commands. Changes appear live in the user's open editor and can be undone there.
3. Look at footage before using it: `look` / `sheet` / `frames` make JPG contact sheets - Read them.

The editor server must be running (Desktop shortcut "Video Editor" / `Start Video Editor.bat`). Before restarting it,
check `GET /api/jobs` and the render queue - never stop a running agent job or render.
