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

    static class Program
    {
        public static readonly string Version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var s = Settings.Load();
            var url = args.FirstOrDefault(a => a.StartsWith("http", StringComparison.OrdinalIgnoreCase));
            Application.Run(new EditorWindow(s, url));
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

        bool full;
        FormWindowState before;
        void ToggleFullScreen()
        {
            full = !full;
            if (full) { before = WindowState; FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Normal; WindowState = FormWindowState.Maximized; }
            else { FormBorderStyle = FormBorderStyle.Sizable; WindowState = before; }
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
            wv.Settings.UserAgent = wv.Settings.UserAgent + " LimelightEditor/" + Program.Version;
            wv.Settings.AreDevToolsEnabled = s.DevTools;
            wv.Settings.IsStatusBarEnabled = false;
            wv.Settings.IsZoomControlEnabled = false; // (Ctrl+wheel is the timeline's)
            wv.Settings.AreBrowserAcceleratorKeysEnabled = true;
            wv.DocumentTitleChanged += (o, e) => Text = string.IsNullOrEmpty(wv.DocumentTitle) ? "Limelight Editor" : wv.DocumentTitle;

            // only the editor in here; anything else opens in the PC's own browser
            wv.NavigationStarting += (o, e) =>
            {
                if (e.Uri.StartsWith("data:") || e.Uri.StartsWith("about:")) return;
                if (!Allowed(e.Uri)) { e.Cancel = true; OpenOutside(e.Uri); }
            };
            wv.NewWindowRequested += (o, e) =>
            {
                e.Handled = true;
                if (Allowed(e.Uri)) wv.Navigate(e.Uri); else OpenOutside(e.Uri);
            };
            // the microphone (voice-over), camera and clipboard: for the editor only
            wv.PermissionRequested += (o, e) =>
            {
                e.State = Allowed(e.Uri) ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };
            // the editor not answering: the next address, else a page that tries again by itself
            wv.NavigationCompleted += (o, e) =>
            {
                if (e.IsSuccess || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                if (++urlIndex < s.Urls.Length) { wv.Navigate(s.Urls[urlIndex]); return; }
                urlIndex = 0;
                wv.NavigateToString(RetryPage(s.Urls[0]));
            };
            wv.Navigate(startUrl ?? s.Urls[0]);
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
            "<div><h2>The editor is not answering</h2><p>Trying again every 10 seconds. If the main editor PC is down, the standby PC takes over within about 2 minutes.</p></div>";
    }
}
