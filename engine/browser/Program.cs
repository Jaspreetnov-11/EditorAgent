// Limelight Editor.exe - the office's own window for the editor. Microsoft WebView2 (the Edge engine Windows keeps up to
// date) shows https://editor.limelightcorp.in and nothing else: other sites open in the PC's normal browser. Tuned for
// editing: no slowing down in the background, the graphics card always on, a big disk cache for preview copies (each
// clip comes from the server once per PC). It tells the editor it is this window (User-Agent "LimelightEditor/<v>").
// When the editor does not answer it tries the next address in LimelightEditor.json (e.g. http://Jaspreet), and
// shows a page that tries again by itself. Settings: LimelightEditor.json next to the exe; its data (sign-in, cache)
// in %LOCALAPPDATA%\LimelightEditor.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LimelightEditor
{
    [DataContract]
    class Settings
    {
        [DataMember(Name = "urls")] public string[] Urls = { "https://editor.limelightcorp.in/" };
        [DataMember(Name = "allowedHosts")] public string[] AllowedHosts = { "editor.limelightcorp.in" };
        [DataMember(Name = "allowedNets")] public string[] AllowedNets = { "192.168." };
        [DataMember(Name = "diskCacheGB")] public int DiskCacheGB = 20;
        [DataMember(Name = "devTools")] public bool DevTools;
        // ⛓ which PC runs the editor while the main one is down (engine/standby.mjs writes it on the NAS)
        [DataMember(Name = "standbyFile")] public string StandbyFile = @"\\192.168.0.99\Team Editing\Limelight Backups\live\standby.json";

        public static Settings Load()
        {
            var f = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "LimelightEditor.json");
            try
            {
                using (var s = File.OpenRead(f)) return (Settings)new DataContractJsonSerializer(typeof(Settings)).ReadObject(s);
            }
            catch { return new Settings(); }
        }
    }

    [DataContract]
    class StandbyInfo
    {
        [DataMember(Name = "state")] public string State;
        [DataMember(Name = "url")] public string Url;
        [DataMember(Name = "beat")] public double Beat;
    }

    // ⛓ the editor's line of PCs (PC A, then JASPREET, PC B, any helper - engine/standby.mjs): where it runs right now
    static class Line
    {
        // the standby running the editor (it writes standby.json every 5 s) - null when none, or it stopped answering
        public static string ActiveStandby(string file)
        {
            try
            {
                StandbyInfo sb;
                using (var f = File.OpenRead(file)) sb = (StandbyInfo)new DataContractJsonSerializer(typeof(StandbyInfo)).ReadObject(f);
                var now = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                return sb != null && sb.State == "active" && !string.IsNullOrEmpty(sb.Url) && now - sb.Beat < 30000 ? sb.Url : null;
            }
            catch { return null; }
        }
        // does the editor at this address answer at all (3 s)? Any reply counts - the owner's own port has no /team/ping
        public static bool Answers(string origin)
        {
            try
            {
                var r = (HttpWebRequest)WebRequest.Create(origin.TrimEnd('/') + "/team/ping");
                r.Timeout = 3000;
                using (r.GetResponse()) return true;
            }
            catch (WebException e) { return e.Response != null; }
            catch { return false; }
        }
        public static string Origin(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https") ? u.GetLeftPart(UriPartial.Authority) : null;
    }

    static class Program
    {
        public static readonly string Version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

        // is THE editor running on this PC (its own port answers, and it is a deployed one - "main": the server PC or a
        // standby)? A coding / test run on port 3000 must not take this window: it goes away and the tabs say "refused"
        static bool EditorHere()
        {
            try
            {
                var r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3000/api/version");
                r.Timeout = 1500;
                using (var res = (HttpWebResponse)r.GetResponse())
                using (var rd = new StreamReader(res.GetResponseStream()))
                    return res.StatusCode == HttpStatusCode.OK && rd.ReadToEnd().Replace(" ", "").Contains("\"main\":true");
            }
            catch { return false; }
        }

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var s = Settings.Load();
            try { Setup.Run(); } catch { } // (every start: shortcuts and limelight:// links point at this exe, wherever it is now)
            if (args.Contains("--setup")) return; // (an installer / IT: set up only, no window)
            var url = args.FirstOrDefault(a => a.StartsWith("http", StringComparison.OrdinalIgnoreCase));
            // the editor's own PC (or a standby running it): its own address - the owner's, no sign-in needed
            if (url == null && EditorHere()) s.Urls = new[] { "http://localhost:3000/" }.Concat(s.Urls).ToArray();
            // limelight://#/p/<project> (or limelight://anything) -> that page of the editor
            var link = args.FirstOrDefault(a => a.StartsWith("limelight:", StringComparison.OrdinalIgnoreCase));
            if (url == null && link != null) url = s.Urls[0].TrimEnd('/') + "/" + link.Substring("limelight:".Length).TrimStart('/');
            Application.Run(new EditorWindow(s, url));
        }
    }

    // 🖥 the editor opens here by default (not enforced): this PC's Desktop and Start menu shortcuts start this exe, and
    // limelight:// links open in it. Only for the user who runs it (HKCU, no administrator). An old "Limelight
    // Editor.url" Desktop shortcut that opened the editor in the browser is replaced. The PC's own browser is untouched.
    static class Setup
    {
        public static void Run()
        {
            var exe = Application.ExecutablePath;
            using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\limelight"))
            {
                k.SetValue("", "URL:Limelight Editor");
                k.SetValue("URL Protocol", "");
                using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", "\"" + exe + "\",0");
                using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", "\"" + exe + "\" \"%1\"");
            }
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            Link(Path.Combine(desktop, "Limelight Editor.lnk"), exe);
            Link(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Limelight Editor.lnk"), exe);
            var old = Path.Combine(desktop, "Limelight Editor.url");
            try { if (File.Exists(old) && File.ReadAllText(old).IndexOf("limelightcorp", StringComparison.OrdinalIgnoreCase) >= 0) File.Delete(old); } catch { }
        }

        static void Link(string lnk, string exe)
        {
            var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            var l = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            void set(string p, object v) => l.GetType().InvokeMember(p, BindingFlags.SetProperty, null, l, new[] { v });
            set("TargetPath", exe);
            set("WorkingDirectory", Path.GetDirectoryName(exe));
            set("IconLocation", exe + ",0");
            set("Description", "Limelight Editor");
            l.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, l, null);
        }
    }

    class EditorWindow : Form
    {
        readonly Settings s;
        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        int urlIndex;
        string startUrl;

        public EditorWindow(Settings settings, string url)
        {
            s = settings;
            startUrl = url;
            Text = "Limelight Editor";
            BackColor = Color.FromArgb(17, 17, 17);
            WindowState = FormWindowState.Maximized;
            MinimumSize = new Size(1024, 640);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            KeyPreview = true;
            KeyDown += (o, e) => { if (e.KeyCode == Keys.F11) ToggleFullScreen(); };
            Controls.Add(web);
            Load += async (o, e) => await Start();
        }

        // the title bar in the editor's charcoal, not Windows' white: dark mode (Windows 10 and 11), and on Windows 11
        // the exact caption, text and border colours (older Windows ignores what it does not know)
        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            void set(int attr, int v) { try { DwmSetWindowAttribute(Handle, attr, ref v, 4); } catch { } }
            set(20, 1);          // DWMWA_USE_IMMERSIVE_DARK_MODE
            set(35, 0x00111111); // DWMWA_CAPTION_COLOR (0x00BBGGRR) = #111111
            set(34, 0x00111111); // DWMWA_BORDER_COLOR
            set(36, 0x00F7F7F7); // DWMWA_TEXT_COLOR
        }

        bool full;
        FormWindowState before;
        void ToggleFullScreen()
        {
            full = !full;
            if (full) { before = WindowState; FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Normal; WindowState = FormWindowState.Maximized; }
            else { FormBorderStyle = FormBorderStyle.Sizable; WindowState = before; }
        }

        // 🗂 the editor's project tabs in the title bar, like Chrome / Explorer: a page that draws its own title bar (the
        // tab strip, public/js/tabs.js) says so ("win:custom") and Windows' caption goes - the sides and bottom still resize,
        // the strip's empty part drags / snaps / double-click maximises (WebView2 "app-region: drag"). Any other page (sign
        // in, "not answering") keeps the normal title bar.
        bool custom, customAsked;
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern int GetSystemMetrics(int i);
        void SetCustom(bool on)
        {
            if (custom == on) return;
            custom = on;
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0020 | 0x0002 | 0x0001 | 0x0004 | 0x0010); // SWP_FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER|NOACTIVATE
            SendWindowState();
        }
        protected override void WndProc(ref Message m)
        {
            // WM_NCCALCSIZE: Windows works out the frame as always, then the top goes back up - no caption, same borders
            if (m.Msg == 0x0083 && m.WParam != IntPtr.Zero && custom && !full)
            {
                var top = System.Runtime.InteropServices.Marshal.ReadInt32(m.LParam, 4);
                base.WndProc(ref m);
                // (maximised, the window reaches past the screen by its frame: keep the strip on the screen)
                var pad = WindowState == FormWindowState.Maximized ? GetSystemMetrics(33) + GetSystemMetrics(92) : 0; // SM_CYFRAME + SM_CXPADDEDBORDER
                System.Runtime.InteropServices.Marshal.WriteInt32(m.LParam, 4, top + pad);
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }
        FormWindowState lastState = (FormWindowState)(-1);
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (WindowState != lastState) { lastState = WindowState; SendWindowState(); }
        }
        void SendWindowState()
        {
            try { web.CoreWebView2?.PostWebMessageAsJson("{\"win\":\"" + (WindowState == FormWindowState.Maximized ? "max" : "normal") + "\"}"); } catch { }
        }

        async Task Start()
        {
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LimelightEditor");
            // editing, not saving battery: timers and video keep full speed in the background, the graphics card is used
            // even where Edge would play safe, and a big disk cache keeps each played preview copy on this PC
            var flags = string.Join(" ", new[] {
                "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
                "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy",
                "--autoplay-policy=no-user-gesture-required",
                "--disk-cache-size=" + ((long)Math.Max(1, s.DiskCacheGB) * 1024 * 1024 * 1024),
            });
            CoreWebView2Environment env;
            try
            {
                env = await CoreWebView2Environment.CreateAsync(null, data, new CoreWebView2EnvironmentOptions(flags));
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Microsoft Edge WebView2 is not on this PC. Install it from microsoft.com/edge/webview2 (Evergreen) and start again.\n\n" + ex.Message,
                    "Limelight Editor", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }
            var wv = web.CoreWebView2;
            // (a WebView2 too old for a page-drawn title bar: the page is not told it can draw one - "LimelightFrame/1")
            var frame = false;
            try { wv.Settings.IsNonClientRegionSupportEnabled = true; frame = true; } catch { }
            wv.Settings.UserAgent = wv.Settings.UserAgent + " LimelightEditor/" + Program.Version + (frame ? " LimelightFrame/1" : "");
            wv.WebMessageReceived += (o, e) =>
            {
                if (!Allowed(e.Source)) return;
                string m; try { m = e.TryGetWebMessageAsString(); } catch { return; }
                if (m == "win:custom" && frame) { customAsked = true; SetCustom(true); }
                else if (m == "win:min") WindowState = FormWindowState.Minimized;
                else if (m == "win:max") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                else if (m == "win:close") Close();
                else if (m == "win:state") SendWindowState();
            };
            // a new page: the normal title bar again unless it draws its own (asked before it finished loading - no flicker)
            wv.NavigationStarting += (o, e) => { customAsked = false; };
            wv.NavigationCompleted += (o, e) => { if (!customAsked) SetCustom(false); };
            // 🔒 the editor's code stays out of reach in this window: no DevTools (whatever LimelightEditor.json says), no
            // browser right-click menu (the editor's own menus still work), no browser keys - F12, Ctrl+U view source,
            // Ctrl+S save page, Ctrl+P, F5 (the editor has its own Refresh); typing, copy and paste are not browser keys
            wv.Settings.AreDevToolsEnabled = false;
            wv.Settings.AreDefaultContextMenusEnabled = false;
            wv.Settings.IsStatusBarEnabled = false;
            wv.Settings.IsZoomControlEnabled = false; // (Ctrl+wheel is the timeline's)
            wv.Settings.AreBrowserAcceleratorKeysEnabled = false;
            // a page or code file "downloaded" from the editor (Save as) is refused; renders, subtitles and the rest still save
            wv.DownloadStarting += (o, e) =>
            {
                var u = e.DownloadOperation.Uri ?? "";
                var mime = e.DownloadOperation.MimeType ?? "";
                if (Allowed(u) && (Regex.IsMatch(u, @"\.(js|mjs|css|html?)(\?|#|$)", RegexOptions.IgnoreCase) || Regex.IsMatch(mime, "javascript|text/html|text/css"))) e.Cancel = true;
            };
            wv.DocumentTitleChanged += (o, e) => Text = string.IsNullOrEmpty(wv.DocumentTitle) ? "Limelight Editor" : wv.DocumentTitle;

            // only the editor in here; anything else opens in the PC's own browser
            wv.NavigationStarting += (o, e) =>
            {
                if (e.Uri.StartsWith("view-source:", StringComparison.OrdinalIgnoreCase)) { e.Cancel = true; return; } // (🔒 never shown, here or outside)
                if (e.Uri.StartsWith("data:") || e.Uri.StartsWith("about:")) return;
                if (!Allowed(e.Uri)) { e.Cancel = true; OpenOutside(e.Uri); }
            };
            wv.NewWindowRequested += (o, e) =>
            {
                e.Handled = true;
                if (e.Uri.StartsWith("view-source:", StringComparison.OrdinalIgnoreCase)) return;
                if (Allowed(e.Uri)) wv.Navigate(e.Uri); else OpenOutside(e.Uri);
            };
            // the microphone (voice-over), camera and clipboard: for the editor only
            wv.PermissionRequested += (o, e) =>
            {
                e.State = Allowed(e.Uri) ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };
            // the editor not answering: the PC of the line running it now (standby.json), else the next address, else a
            // page that tries again by itself
            wv.NavigationCompleted += (o, e) =>
            {
                if (e.IsSuccess || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                var sb = Line.ActiveStandby(s.StandbyFile);
                if (sb != null && Line.Origin(sb) != Line.Origin(wv.Source)) { wv.Navigate(sb); return; }
                if (++urlIndex < s.Urls.Length) { wv.Navigate(s.Urls[urlIndex]); return; }
                urlIndex = 0;
                wv.NavigateToString(RetryPage(s.Urls[0]));
            };
            wv.Navigate(startUrl ?? s.Urls[0]);
            // ⛓ every 10 s: the PC this window shows has stopped answering and another PC of the line runs the editor ->
            // go there (same page); the main editor is back and the standby has handed back -> back to the main one
            var watch = new Timer { Interval = 10000 };
            var checking = false;
            watch.Tick += async (o, e) =>
            {
                if (checking) return;
                checking = true;
                try
                {
                    var cur = wv.Source ?? "";
                    var origin = Line.Origin(cur);
                    var file = s.StandbyFile;
                    // (the main editor's addresses: not a standby's :3100 link)
                    var mains = s.Urls.Select(Line.Origin).Where(x => x != null && !x.EndsWith(":3100")).ToArray();
                    var go = await Task.Run(() =>
                    {
                        var sb = Line.ActiveStandby(file);
                        if (origin == null) return sb; // (the "not answering" page: straight to the standby, if one runs)
                        if (sb != null && Line.Origin(sb) != origin && !Line.Answers(origin)) return sb;
                        // on a standby that has handed back (or gone): the main editor, when it answers
                        if (sb == null && !mains.Contains(origin) && mains.Length > 0 && Line.Answers(mains[0])) return mains[0] + "/";
                        return null;
                    });
                    if (go != null)
                    {
                        var hash = cur.Contains("#") ? cur.Substring(cur.IndexOf('#')) : "";
                        wv.Navigate(go.TrimEnd('/') + "/" + hash);
                    }
                }
                catch { }
                finally { checking = false; }
            };
            watch.Start();
        }

        bool Allowed(string uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
            if (u.Scheme != "http" && u.Scheme != "https") return false;
            var h = u.Host.ToLowerInvariant();
            return s.AllowedHosts.Any(a => h == a.ToLowerInvariant()) || s.AllowedNets.Any(n => h.StartsWith(n));
        }

        static void OpenOutside(string uri)
        {
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
        }

        static string RetryPage(string url) =>
            "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"10;url=" + WebUtility.HtmlEncode(url) + "\">" +
            "<body style=\"font:16px Segoe UI,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\">" +
            "<div><h2>The editor is not answering</h2><p>Trying again every 10 seconds. If the main editor PC is down, the next PC in the line (JASPREET, then PC B, then a helper) takes over within about 30 seconds - this window goes there by itself.</p></div>";
    }
}
