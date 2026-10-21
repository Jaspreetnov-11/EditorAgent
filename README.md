# Limelight Video Editor

A video editor that runs as a local web app (`node server.mjs`, http://localhost:3000) with Premiere / After Effects /
Resolve-style pages (Media, Edit, Motion, Fusion, Color, Audio, Deliver), live team editing, a render farm, and an AI
agent / Claude that edits through `engine/edtool.mjs`.

- Start: `Start Video Editor.bat` (Windows). Needs Node.js, FFmpeg and Python (Whisper, CLIP, Demucs) - see the chats.
- Office link: https://editor.limelightcorp.in (team editing, port 443/80/3100).
- `engine/` render engine, agent, tools · `public/` the editor UI · `tests/` auto-tests (`node tests/run.mjs --server`).
- `Chats/` the full history of how it was built: chats 01-06 (merged) and chat 07.

Not in this repository (kept on the editing computer): projects and footage, `config.json` (logins, keys), `ssl/`,
models, FFmpeg tools, `node_modules` (`npm install` brings them back).
