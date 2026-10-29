// nlfolder.mjs - keeps a ready Premiere Pro / DaVinci Resolve hand-off in every project's own folder, so the edit opens
// there even when the editor is down:
//   <project>\Open in Premiere.cmd     double-click: Premiere Pro opens the timeline
//   <project>\Open in DaVinci.cmd      double-click: Resolve opens, Workspace > Scripts > Limelight Timeline makes it a project
//   <project>\Premiere - DaVinci\      <name>.xml (FCP7 XML, both import it) + title PNGs + subtitles + README +
//                                      Limelight Timeline.lua (the Resolve script the .cmd puts in Resolve's Scripts menu)
// The footage is linked where it is (the NAS), nothing is copied. The server rewrites it a little after each save
// (server.mjs nleSoon) in a child process - the title PNGs are drawn with ffmpeg - and right away for Open in Premiere /
// Open in DaVinci in the editor (Limelight Editor.exe's limelight://nle/ link opens it on the PC the user sits at).
//
// node engine/nlfolder.mjs <job.json>   job: { project, media: { id: item }, dir, subtitlesPath } -> prints { xml, folder, clips }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportTimeline } from './nlexport.mjs';

export const NLE_DIR = 'Premiere - DaVinci';
const safe = (n) => String(n).replace(/[\\/:*?"<>|]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'Timeline';

// 🎬 Resolve (the free one too) runs scripts from Workspace > Scripts; this one takes the XML that Open in DaVinci left in
// %APPDATA%\Limelight\resolve-next.txt and opens it as a new project with the timeline's frame rate and size.
// (Limelight Editor.exe carries the same script - engine/browser/Program.cs ResolveScript - keep the two in step.)
export const RESOLVE_LUA = `-- Limelight Timeline: opens the timeline the Limelight editor handed over (Open in DaVinci) as a new project.
local resolve = resolve or (bmd and bmd.scriptapp and bmd.scriptapp("Resolve")) or (Resolve and Resolve())
if not resolve then print("Limelight: DaVinci Resolve is not reachable") return end
local list = os.getenv("APPDATA") .. "\\\\Limelight\\\\resolve-next.txt"
local f = io.open(list, "r")
local xml = f and f:read("*l")
if f then f:close() end
if not xml or xml == "" then print("Limelight: nothing to open - press Open in DaVinci in the editor, or the Open in DaVinci file in the project folder") return end
xml = xml:gsub("^\\239\\187\\191", ""):gsub('^%s*"?', ""):gsub('"?%s*$', "")
local x = io.open(xml, "r")
if not x then print("Limelight: cannot read " .. xml) return end
local s = x:read("*a")
x:close()
local name = s:match("<sequence[^>]*><name>(.-)</name>") or "Limelight"
name = name:gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
local tb = tonumber(s:match("<timebase>(%d+)</timebase>")) or 25
local fps = tostring(tb)
if s:match("<ntsc>(%a+)</ntsc>") == "TRUE" then fps = string.format("%.3f", tb * 1000 / 1001):gsub("0+$", "") end
local w, h = s:match("<width>(%d+)</width>"), s:match("<height>(%d+)</height>")
local pm = resolve:GetProjectManager()
if pm:GetCurrentProject() then pm:SaveProject() end
local pname, n = name, 1
local proj = pm:CreateProject(pname)
while not proj and n < 50 do n = n + 1; pname = name .. " " .. n; proj = pm:CreateProject(pname) end
proj = proj or pm:GetCurrentProject()
if not proj then print("Limelight: could not make a project") return end
proj:SetSetting("timelineFrameRate", fps)
proj:SetSetting("timelinePlaybackFrameRate", fps)
if w and h then proj:SetSetting("timelineResolutionWidth", w); proj:SetSetting("timelineResolutionHeight", h) end
local tl = proj:GetMediaPool():ImportTimelineFromFile(xml, { timelineName = name, importSourceClips = true })
if not tl then print("Limelight: Resolve could not import " .. xml) return end
proj:SetCurrentTimeline(tl)
resolve:OpenPage("edit")
pm:SaveProject()
os.remove(list)
print("Limelight: opened " .. name .. " (project " .. pname .. ")")
`;

// the double-click launchers (plain batch: no PowerShell policy in the way; they look for the newest Premiere / Resolve)
const PREMIERE_CMD = String.raw`@echo off
rem Limelight: opens this project's timeline in Adobe Premiere Pro (works when the editor is down too).
chcp 65001 >nul
set "X="
for %%f in ("%~dp0${NLE_DIR}\*.xml") do set "X=%%~ff"
if not defined X goto noxml
set "PP="
for /d %%d in ("%ProgramFiles%\Adobe\Adobe Premiere Pro*") do if exist "%%~d\Adobe Premiere Pro.exe" set "PP=%%~d\Adobe Premiere Pro.exe"
if not defined PP goto nopp
start "" "%PP%" "%X%"
exit /b 0
:nopp
echo Adobe Premiere Pro is not installed on this PC. On a PC with Premiere: File ^> Import ^> this XML:
echo "%X%"
pause
exit /b 1
:noxml
echo The timeline XML is not in the "${NLE_DIR}" folder yet - open the project in the editor once.
pause
exit /b 1
`;
const RESOLVE_CMD = String.raw`@echo off
rem Limelight: opens this project's timeline in DaVinci Resolve (works when the editor is down too).
chcp 65001 >nul
set "X="
for %%f in ("%~dp0${NLE_DIR}\*.xml") do set "X=%%~ff"
if not defined X goto noxml
set "R=%ProgramFiles%\Blackmagic Design\DaVinci Resolve\Resolve.exe"
if not exist "%R%" goto nor
set "S=%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility"
if not exist "%S%" mkdir "%S%"
copy /y "%~dp0${NLE_DIR}\Limelight Timeline.lua" "%S%\Limelight Timeline.lua" >nul
if not exist "%APPDATA%\Limelight" mkdir "%APPDATA%\Limelight"
>"%APPDATA%\Limelight\resolve-next.txt" echo "%X%"
echo "%X%"| clip
tasklist /fi "imagename eq Resolve.exe" | find /i "Resolve.exe" >nul || start "" "%R%"
echo.
echo  DaVinci Resolve is opening. Open any project (Untitled is fine), then:
echo      Workspace ^> Scripts ^> Limelight Timeline
echo  - the timeline comes in as a new project, its clips linked from the NAS.
echo  (Or File ^> Import ^> Timeline and paste the path - it is on the clipboard.)
echo.
pause
exit /b 0
:nor
echo DaVinci Resolve is not installed on this PC.
pause
exit /b 1
:noxml
echo The timeline XML is not in the "${NLE_DIR}" folder yet - open the project in the editor once.
pause
exit /b 1
`;
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
function writeIfChanged(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {}
  fs.writeFileSync(file, text, 'utf8');
}

export function writeNleFolder({ project, media, dir, subtitlesPath }) {
  const outDir = path.join(dir, NLE_DIR), base = safe(project.name || path.basename(dir));
  const r = exportTimeline({ project, media, outDir, base, subtitlesPath });
  writeIfChanged(path.join(outDir, 'Limelight Timeline.lua'), RESOLVE_LUA);
  writeIfChanged(path.join(dir, 'Open in Premiere.cmd'), crlf(PREMIERE_CMD));
  writeIfChanged(path.join(dir, 'Open in DaVinci.cmd'), crlf(RESOLVE_CMD));
  // what an earlier write left that this one did not make: old title PNGs, the XML of the project's old name
  // (a Premiere project / Resolve file someone saved in here stays)
  const keep = new Set([...r.files, 'Limelight Timeline.lua'].map((f) => path.resolve(outDir, f).toLowerCase()));
  const sweep = (d, top) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/ titles$/i.test(e.name)) { sweep(p, false); if (!fs.readdirSync(p).length) fs.rmdirSync(p); } continue; }
      if (keep.has(p.toLowerCase())) continue;
      if (!top || /\.(xml|srt|vtt)$|- README\.txt$/i.test(e.name)) fs.rmSync(p, { force: true });
    }
  };
  try { sweep(outDir, true); } catch {}
  return { xml: path.join(outDir, r.xml), folder: outDir, clips: r.clips, notes: r.notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(writeNleFolder(job)));
}
