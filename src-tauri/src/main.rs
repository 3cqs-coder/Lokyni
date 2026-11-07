// Prevent a second console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Lokyni desktop shell.
//
// This native window does not contain the application. Its only job is to run the existing
// local server as a child process, wait for it to start listening, then point the window at
// it. The server is unaware it is running inside a desktop app — it is the same server that
// runs from a terminal or as a background service — so all application logic stays in one
// place and the shell stays a thin, replaceable launcher.
//
// The bundled files live under the read-only resource directory: `app/` holds the staged
// application (its own file set plus dependencies) and `app/runtime/` holds a copy of the
// runtime, so the end user needs nothing else installed. The server's writable data (its
// configuration and document index) is kept in the per-user data directory instead of the
// read-only bundle.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// Where the panic hook writes. Set once the per-user data dir is resolved; until then (and if that fails) the
// hook falls back to the temp dir, so even a panic during early startup leaves a trace.
static PANIC_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
use tauri::{Manager, RunEvent, WindowEvent, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::DownloadEvent;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

// Holds the running server child and the port it was started on. The port lets the close
// handler ask the server whether it is busy before quitting.
struct Server(Mutex<Option<(Child, u16)>>);

// Strip Windows' verbatim path prefix. Tauri's resource directory comes back in verbatim form
// (`\\?\C:\...`), which the runtime's module resolver cannot parse. A verbatim UNC path
// (`\\?\UNC\server\share`) maps back to `\\server\share`. Everywhere else this is a no-op.
fn plain_path(p: &Path) -> PathBuf {
    if cfg!(windows) {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

// Ensure the bundled runtime is executable. Some Linux resource packagers drop the executable
// bit, which makes the launch fail with a permission error and the window never loads. A no-op
// on Windows.
#[cfg(unix)]
fn ensure_executable(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(p) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(p, perms);
    }
}
#[cfg(not(unix))]
fn ensure_executable(_p: &Path) {}

// Whether a loopback port is free right now (best-effort — there is an unavoidable gap
// between this check and the server binding it).
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// Ask the OS for a free loopback port by binding to port 0 and reading back the assignment.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(7887)
}

// Resolve the port to run on. A port is remembered in the data directory and reused across
// launches so the window's origin stays stable — otherwise a fresh random port every launch
// would give the web app a new origin each time and silently reset everything it keeps in
// browser storage (theme, the current conversation, the feature toggles). Falls back to a
// fresh free port only when the remembered one is taken.
fn resolve_port(data_dir: &Path) -> u16 {
    let marker = data_dir.join("desktop-port");
    if let Ok(text) = std::fs::read_to_string(&marker) {
        if let Ok(p) = text.trim().parse::<u16>() {
            if p != 0 && port_is_free(p) {
                return p;
            }
        }
    }
    let p = free_port();
    let _ = std::fs::write(&marker, p.to_string());
    p
}

// Fetch the server's /status body with a short, self-contained HTTP request — no HTTP-client
// dependency. Returns None on any error. `Sec-Fetch-Site: none` satisfies the server's
// cross-origin guard, which treats it as a direct request.
fn fetch_status(port: u16) -> Option<String> {
    // A BOUNDED connect: this runs on the main/UI thread from the window-close handler (server_busy), so a
    // filtered or half-open loopback port must not block it on the OS default connect timeout (tens of
    // seconds) and freeze the quit flow. A real loopback connect returns in microseconds.
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "GET /status HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nSec-Fetch-Site: none\r\nConnection: close\r\n\r\n",
        port
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    if buf.is_empty() { None } else { Some(buf) }
}

// True only when the responder on this port is actually Lokyni (its /status shape), so the
// window is never pointed at some unrelated loopback service that won the port in a race.
fn server_is_lokyni(port: u16) -> bool {
    fetch_status(port).map(|b| b.contains("\"documents\"") && b.contains("\"ready\"")).unwrap_or(false)
}

// If the server is busy (indexing, answering, or building the knowledge graph), the short reason WHY — read
// before quitting so the confirm dialog can say what is running. None when idle or unreachable. No serde: a
// tiny, fail-safe substring parse of the /status JSON, matching how busy was already read here.
fn server_busy_reason(port: u16) -> Option<String> {
    let body = fetch_status(port)?;
    if !body.contains("\"busy\":true") {
        return None;
    }
    // Pull "busyReason":"<reason>" when present; a null/absent reason falls back to a generic phrase.
    let reason = body
        .split("\"busyReason\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "working".to_string());
    Some(reason)
}

// A log file for the server's output, in the writable data directory. A packaged process is
// otherwise silent, so a startup failure would leave no trace; a file (rather than a pipe)
// also cannot fill and stall the writer. Rotated on open so it can't grow without bound across
// launches: once it passes the cap, one previous generation is kept as desktop.log.old and a
// fresh file is started — so the log is bounded to roughly twice the cap.
const DESKTOP_LOG_MAX: u64 = 5 * 1024 * 1024;
fn server_log(data_dir: &Path) -> Stdio {
    let path = data_dir.join("desktop.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > DESKTOP_LOG_MAX {
            let _ = std::fs::rename(&path, data_dir.join("desktop.log.old"));
        }
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => Stdio::from(f),
        Err(_) => Stdio::null(),
    }
}

// Append one line to the desktop log. Used for shell-side events that never reach the sidecar's own
// stdout/stderr — most importantly a failure to even spawn the runtime — so the startup-error dialog's
// "see the log" actually has something to show. Best-effort; a logging failure must never cascade.
fn log_line(data_dir: &Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(data_dir.join("desktop.log")) {
        let _ = writeln!(f, "[shell] {}", msg);
    }
}

// Stop the server child gracefully: ask it to shut down (so it flushes caches, finishes an
// in-flight index write, and closes any helper processes) and only force-kill if it does not
// exit in time. On Unix that is SIGTERM then SIGKILL; elsewhere a direct kill.
// Spawn the bundled Node runtime running the server on `port`. Single-sourced so the first launch and the
// bind-race respawn (in the readiness thread) build the child identically — same stdin pipe (its EOF is the
// never-orphan shutdown signal), same per-platform teardown wiring (Linux PDEATHSIG, Windows no-console).
fn spawn_server(runtime: &Path, entry: &Path, data_dir: &Path, tessdata: &Path, port: u16) -> std::io::Result<Child> {
    let mut cmd = Command::new(runtime);
    cmd.arg(entry)
        .arg("--port")
        .arg(port.to_string())
        // Point the sidecar at the bundled, read-only OCR language packs (the English floor ships in the app's
        // resources). The server seeds them into its writable data dir on first OCR, so a fresh — possibly offline
        // — desktop install can read scanned pages without a network download.
        .arg("--bundled-tessdata-dir")
        .arg(tessdata)
        // The desktop window only ever loads 127.0.0.1, so force the sidecar to bind loopback regardless of what
        // config.json says — a `bindAddress: "0.0.0.0"` there would otherwise expose the single-user,
        // unauthenticated desktop control plane (and every indexed document) to the local network, with the
        // DNS-rebind Host guard auto-disabled for the non-loopback bind.
        .arg("--bind")
        .arg("127.0.0.1")
        // Mark this as a desktop launch so the server watches its stdin. We keep the stdin pipe open for the
        // app's whole lifetime; the server treats EOF on it — which the OS delivers when this shell exits by
        // ANY means (quit, crash, force-quit, SIGKILL), on every platform — as a shutdown, so it is never left
        // orphaned holding the port and data directory. A cooperative "quit\n" line (see stop_child) is the
        // clean stop, important on Windows where a windowless child has no SIGTERM to honor.
        .arg("--desktop")
        .current_dir(data_dir)
        .stdin(Stdio::piped())
        .stdout(server_log(data_dir))
        .stderr(server_log(data_dir));
    // Unix: put the child in its OWN process group (setsid), so a last-resort force-kill can take down the WHOLE
    // tree — the sidecar PLUS any descendants it spawned (OCR/parse workers, a URL-ingestion browser) — via a
    // process-group signal, mirroring the Windows taskkill /T tree-kill. A wedged sidecar that ignored the
    // cooperative stop would otherwise have its children orphaned by a single-process SIGKILL (which skips the
    // sidecar's own exit sweep). On Linux also arm PDEATHSIG so the kernel SIGTERMs the child if this shell dies
    // unexpectedly (crash/SIGKILL) before it can orphan. (macOS has no PDEATHSIG; the stdin-EOF watch covers that
    // path there.) setsid leaves the stdin pipe intact, so the EOF never-orphan signal still works.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                #[cfg(target_os = "linux")]
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong, 0, 0, 0);
                Ok(())
            });
        }
    }
    // Don't pop a console window when launching the runtime on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

fn stop_child(child: &mut Child) {
    // Cooperative stop first: write a "quit" line on the piped stdin. This is cross-platform and,
    // on Windows, the only clean channel a windowless child can honor (no SIGTERM). On Unix also
    // send SIGTERM. Then wait for a clean exit on either platform before force-killing, so the
    // server can flush caches and finish an in-flight index write.
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        let _ = stdin.write_all(b"quit\n");
        let _ = stdin.flush();
    }
    #[cfg(unix)]
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
    // Wait STRICTLY LONGER than the sidecar's own graceful hard timeout (lib/shutdown.js
    // HARD_TIMEOUT_MS = 8000 ms) before force-killing. If this window merely equaled that deadline,
    // a legitimately slow-but-valid teardown (a large in-flight index write, closing a URL-ingest
    // browser) could be SIGKILLed at the same instant Node runs its `exit` handler — skipping the
    // synchronous orphan sweep that kills any child browser or parse helper, which would then orphan.
    // 12 s leaves the sidecar clear headroom to finish its bounded exit; keep it above the 8 s cap if
    // either constant changes.
    for _ in 0..120 {
        if matches!(child.try_wait(), Ok(Some(_))) { return; }
        std::thread::sleep(Duration::from_millis(100));
    }
    // Force-kill, last resort (the sidecar ignored the cooperative stop for >12 s). A plain single-process kill
    // would leave a wedged sidecar's descendants (OCR/parse workers, a URL-ingestion Chromium) orphaned, because
    // SIGKILL/TerminateProcess runs no exit sweep. So kill the whole TREE on every platform: taskkill /T on
    // Windows, the process GROUP on Unix (the child is its own group leader via setsid at spawn).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let pid = child.id().to_string();
        let killed = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        // Fall back to the single-process kill if taskkill is unavailable (e.g. stripped-down Windows).
        if !killed { let _ = child.kill(); }
    }
    #[cfg(not(windows))]
    {
        // Negative pid = the whole process group (led by the child via setsid) — takes its descendants with it.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill();   // belt-and-suspenders: also target the leader directly
    }
    let _ = child.wait();
}

// Take the child out of shared state and stop it (called from window-close and app-exit).
fn stop_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Server>() {
        let taken = state.0.lock().unwrap().take();
        if let Some((mut child, _)) = taken { stop_child(&mut child); }
    }
}

// If the server is busy (indexing/answering), ask before quitting. Returns true when the user chose "Keep
// working" (i.e. cancel the quit). Shared by the window-close path AND the macOS Cmd+Q / app-menu Quit path
// (RunEvent::ExitRequested), so both honor the confirmation — a window-close-only guard let Cmd+Q abort
// in-flight work with no prompt.
fn confirm_keep_working(app: &tauri::AppHandle) -> bool {
    let port = app.try_state::<Server>()
        .and_then(|s| s.0.lock().unwrap().as_ref().map(|(_, p)| *p));
    if let Some(port) = port {
        if let Some(reason) = server_busy_reason(port) {
            return !app
                .dialog()
                .message(format!("Lokyni is still {reason}. Quitting now will stop it before it finishes."))
                .title("Quit Lokyni?")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Quit anyway".to_string(),
                    "Keep working".to_string(),
                ))
                .blocking_show();
        }
    }
    false
}

// Show a startup-failure dialog pointing at the log, then exit — used when the server dies
// before it ever starts listening (a missing/mismatched native module, a broken config, a
// port collision). Non-blocking dialog so it is safe to call from a worker thread.
fn show_startup_error(app: &tauri::AppHandle, data_dir: &Path) {
    let log = data_dir.join("desktop.log");
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "Lokyni could not start its local service.\n\nSee the log for details:\n{}",
            log.display()
        ))
        .title("Lokyni failed to start")
        .kind(MessageDialogKind::Error)
        .show(move |_| { handle.exit(1); });
}

// Show a dialog when the sidecar exits UNEXPECTEDLY after the app was already running (a crash, an
// OOM kill, an external kill), then exit — so the user gets a clear message instead of a dead
// 127.0.0.1 page. The caller has already taken the child out of shared state, so the follow-on
// RunEvent::Exit stop_server is a no-op (nothing left to signal). Non-blocking dialog, safe from the
// supervision worker thread.
fn show_sidecar_crashed(app: &tauri::AppHandle, data_dir: &Path) {
    let log = data_dir.join("desktop.log");
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "Lokyni's local service stopped unexpectedly.\n\nReopen Lokyni to start it again.\nSee the log for details:\n{}",
            log.display()
        ))
        .title("Lokyni service stopped")
        .kind(MessageDialogKind::Error)
        .show(move |_| { handle.exit(1); });
}

// On Linux the window runs inside a WebKitGTK WebView whose accelerated-compositing renderer
// fails on many GPU + driver + compositor combinations (NVIDIA especially, and many Wayland
// setups): the GTK window paints its background color but the WebView surface never composites,
// so the app shows a blank dark window instead of the interface or the loading splash — the
// "stays black until it loads" report. WebKitGTK reads these only from the environment and
// offers no config/command-line equivalent. We set, as DEFAULTS an advanced user can override:
//   • WEBKIT_DISABLE_DMABUF_RENDERER — the common NVIDIA/Wayland black-screen fix.
//   • WEBKIT_DISABLE_COMPOSITING_MODE — the stronger escalation: it turns off GPU compositing
//     entirely, so the WebView renders in software and paints reliably on ANY machine. This is
//     what fixes the machines where disabling only the DMABUF renderer is not enough. The cost
//     is a little GPU acceleration, which is irrelevant for this simple document interface.
//   • __NV_DISABLE_EXPLICIT_SYNC — free, and heads off a related NVIDIA/Wayland crash.
//   • GTK_OVERLAY_SCROLLING — "0" turns off GTK/WebKitGTK OVERLAY scrollbars, which otherwise float ON TOP of the
//     page content (a GNOME default). Overlaid scrollbars were covering the right-aligned controls in scrolling
//     panels (the Settings toggles), making them unclickable. With overlay off, the scrollbar takes its own
//     track beside the content, so nothing is covered. WebKitGTK reads this from the environment only.
// Linux-only, so macOS (WKWebView) and Windows (WebView2) are untouched. Each is set only when
// the user has not already set it, so anyone on a working accelerated path can opt back in.
#[cfg(target_os = "linux")]
fn tune_linux_webview() {
    for (key, value) in [
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
        ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
        ("__NV_DISABLE_EXPLICIT_SYNC", "1"),
        ("GTK_OVERLAY_SCROLLING", "0"),
    ] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}
#[cfg(not(target_os = "linux"))]
fn tune_linux_webview() {}

fn main() {
    // Record any Rust panic to the log before the process aborts (panic = "abort", and on Windows there is no
    // console), so even a fatal, unanticipated panic — in a worker thread, the navigation closure, or the
    // Tauri build — leaves a trace the startup-error dialog's "see the log" can point at, instead of the app
    // vanishing silently. Writes to the data-dir desktop.log once that is known, else a temp-dir fallback.
    std::panic::set_hook(Box::new(|info| {
        let line = format!("[shell] PANIC: {}\n", info);
        let target = PANIC_LOG_DIR.get().map(|d| d.join("desktop.log"))
            .unwrap_or_else(|| std::env::temp_dir().join("lokyni-desktop-panic.log"));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&target) { let _ = f.write_all(line.as_bytes()); }
        eprintln!("{}", line);
    }));

    // Must run BEFORE any WebView is created (the window is built from the config below), so the
    // renderer choice is in effect for the very first paint — including the loading splash.
    tune_linux_webview();

    let builder = tauri::Builder::default();
    // Single instance (macOS + Windows): a second launch must NOT start another app + sidecar (which would put
    // two servers on one data directory). Instead, focus the window that is already open. Registered first, as the
    // plugin requires. NOT registered on Linux: there the plugin registers the app IDENTIFIER as a D-Bus
    // well-known name, and D-Bus rejects any name whose dotted segment starts with a digit — this app's identifier
    // has one ("com.3cqs.lokyni"), so the plugin panics at startup before any window opens. The sidecar's own
    // per-data-dir lock already stops two servers on one data dir, so Linux data stays safe without this plugin; a
    // second Linux launch simply opens a second window that then exits. (Changing the identifier would fix D-Bus
    // too, but it also names the data directory on every platform, so it is deliberately left alone here.)
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(win) = app.webview_windows().values().next() {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        // Opens external links (and mailto:, etc.) in the user's real browser/mail client. Called
        // only from Rust (the navigation handler below), so it needs no capability grant to the
        // remote-served frontend — the app's webview is never given IPC access.
        .plugin(tauri_plugin_opener::init())
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            // Build the main window in code (rather than from tauri.conf.json) so it can carry a
            // navigation handler. The app is a single webview pointed at the local server, so an
            // outbound link followed IN PLACE would navigate away from the app with no way back,
            // and a target="_blank" link does nothing in the desktop webview. The handler keeps
            // in-app origins in the window and hands every other URL to the OS default browser,
            // canceling the in-webview navigation. In-app origins are the bundled splash/loader —
            // served by the webview ITSELF, as the `tauri://` scheme on macOS/Linux (WKWebView) or an
            // `*.localhost` host (`tauri.localhost`) on Windows (WebView2) — plus the local server on
            // 127.0.0.1 / localhost. (Missing the Windows `tauri.localhost` host sent the very first
            // splash load to the system browser, leaving the window blank and popping open a browser.)
            // The frontend rewrites target="_blank" links to top-level navigations in desktop mode so
            // they reach this handler too.
            let nav_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Lokyni")
                .inner_size(1200.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .background_color(tauri::window::Color(0x0f, 0x0f, 0x0f, 0xff))
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    let host = url.host_str().unwrap_or("");
                    let in_app = url.scheme() == "tauri"
                        || ((url.scheme() == "http" || url.scheme() == "https")
                            && (host == "127.0.0.1" || host == "localhost" || host.ends_with(".localhost")));
                    if in_app {
                        return true;
                    }
                    // Outbound link: open it in the system browser and keep the app in place.
                    let _ = nav_handle.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                // Give the frontend's file exports a real "Save As" on macOS/Linux. Those webviews (WebKit) have
                // no File System Access API, so the frontend falls back to a normal browser download; without this
                // the file would land silently in the OS download folder. We let the download finish to a temp
                // file, then (in Finished, OFF the synchronous callback that would freeze the UI thread) show a
                // native save panel and move it to where the user chooses — mirroring the browser's showSaveFilePicker
                // on Chromium. On Windows the webview is Chromium, so the frontend uses showSaveFilePicker directly
                // and this rarely fires. The panel is non-blocking; cancelling just discards the temp file.
                .on_download({
                    let pending = std::sync::Arc::new(Mutex::new(
                        std::collections::HashMap::<String, (PathBuf, String)>::new(),
                    ));
                    move |webview, event| {
                        match event {
                            DownloadEvent::Requested { url, destination } => {
                                let name = destination
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or_else(|| "download".to_string());
                                let mut temp = std::env::temp_dir();
                                temp.push(format!("lokyni-dl-{}-{}", std::process::id(), name));
                                if let Ok(mut map) = pending.lock() {
                                    map.insert(url.to_string(), (temp.clone(), name));
                                }
                                *destination = temp;
                                true
                            }
                            DownloadEvent::Finished { url, path: _, success } => {
                                let entry = pending.lock().ok().and_then(|mut m| m.remove(url.as_str()));
                                if let Some((temp, name)) = entry {
                                    if success {
                                        let app = webview.app_handle().clone();
                                        app.dialog().file().set_file_name(name).save_file(move |dest| {
                                            match dest.and_then(|fp| fp.into_path().ok()) {
                                                Some(target) => {
                                                    // rename fails across volumes (temp vs. the chosen disk) — fall back to copy.
                                                    if std::fs::rename(&temp, &target).is_err() {
                                                        let _ = std::fs::copy(&temp, &target);
                                                        let _ = std::fs::remove_file(&temp);
                                                    }
                                                }
                                                None => {
                                                    let _ = std::fs::remove_file(&temp); // cancelled — discard the temp file
                                                }
                                            }
                                        });
                                    } else {
                                        let _ = std::fs::remove_file(&temp);
                                    }
                                }
                                true
                            }
                            _ => true,
                        }
                    }
                })
                .build()?;

            // Resolve the bundle and per-user data locations WITHOUT `?`: a `?` here would propagate out of
            // setup to .build().expect() and abort the process — which, with panic = "abort" and the Windows
            // "windows" subsystem (no console), means the user double-clicks and nothing happens at all, no
            // window and no message. Route the failure to the startup-error dialog instead (logging to a temp
            // path, since the data dir may be the thing that failed), then return so the dialog can show.
            let res_dir = match app.path().resource_dir() {
                Ok(d) => plain_path(&d),
                Err(e) => {
                    let tmp = std::env::temp_dir();
                    log_line(&tmp, &format!("could not resolve the resource directory: {}", e));
                    show_startup_error(app.handle(), &tmp);
                    return Ok(());
                }
            };
            let app_dir = res_dir.join("app");
            let runtime = app_dir
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            let entry = app_dir.join("lokyni.js");
            // The bundled OCR language packs ship under app/tessdata/ (staged by prepare-sidecar.js).
            let tessdata = app_dir.join("tessdata");
            ensure_executable(&runtime);

            // Writable per-user location for configuration and the document index; the
            // bundle itself is read-only. As above, handle a failure with a dialog rather than a silent abort.
            let data_dir = match app.path().app_data_dir() {
                Ok(d) => plain_path(&d),
                Err(e) => {
                    let tmp = std::env::temp_dir();
                    log_line(&tmp, &format!("could not resolve the per-user data directory: {}", e));
                    show_startup_error(app.handle(), &tmp);
                    return Ok(());
                }
            };
            std::fs::create_dir_all(&data_dir).ok();
            let _ = PANIC_LOG_DIR.set(data_dir.clone());   // route the panic hook to the real log now that we have it

            let port = resolve_port(&data_dir);

            // Handle a spawn FAILURE explicitly rather than .expect() (which, under panic = "abort",
            // would vanish the app with no window and no message). A failed spawn is the single most
            // likely packaging fault — a missing or antivirus-quarantined runtime, a dropped executable
            // bit, a noexec mount, a corrupt bundle — so log it and show the same startup-failure dialog
            // the early-exit path uses, then stop setup here (the dialog's callback exits the app).
            let child = match spawn_server(&runtime, &entry, &data_dir, &tessdata, port) {
                Ok(c) => c,
                Err(e) => {
                    log_line(&data_dir, &format!("failed to start the local server ({}): {}", runtime.display(), e));
                    show_startup_error(app.handle(), &data_dir);
                    return Ok(());
                }
            };
            *app.state::<Server>().0.lock().unwrap() = Some((child, port));

            // Wait for the server off the main thread so the window paints immediately, then
            // navigate it to the running server. Watches for an early child exit so a startup
            // failure surfaces as a dialog rather than an endless "Starting…".
            let handle = app.handle().clone();
            let data_for_thread = data_dir.clone();
            let runtime_t = runtime.clone();
            let entry_t = entry.clone();
            let tessdata_t = tessdata.clone();
            std::thread::spawn(move || {
                // Up to two respawns on a bind race (see below); the port can change across them.
                const MAX_RESPAWNS: u8 = 2;
                let mut respawns: u8 = 0;
                let mut port = port;
                // ── Startup: wait for the sidecar to start listening, or surface an early exit ──
                let mut ready = false;
                for _ in 0..600 {   // up to ~60s
                    // Did the server process die before it started listening? The most common recoverable cause
                    // is a port bind race — something grabbed the remembered port between the free-check and the
                    // sidecar's listen, so it hit EADDRINUSE and exited. Rather than give up, pick a fresh free
                    // port, rewrite the marker, and respawn (bounded). try_wait has already reaped the dead
                    // child; the respawn happens IN PLACE while still holding the state lock, so it is atomic
                    // with a concurrent stop — two sidecars can never be alive at once (never-orphan). If a
                    // shutdown already took the child, exit quietly.
                    enum Step { Poll, Fail }
                    let step = if let Some(state) = handle.try_state::<Server>() {
                        let mut guard = state.0.lock().unwrap();
                        if guard.is_none() { return; }   // a shutdown took the child — stop quietly
                        let dead = matches!(guard.as_mut().map(|(c, _)| c.try_wait()), Some(Ok(Some(_))));
                        if !dead {
                            Step::Poll
                        } else if respawns < MAX_RESPAWNS {
                            respawns += 1;
                            let new_port = free_port();
                            let _ = std::fs::write(data_for_thread.join("desktop-port"), new_port.to_string());
                            match spawn_server(&runtime_t, &entry_t, &data_for_thread, &tessdata_t, new_port) {
                                Ok(c) => {
                                    *guard = Some((c, new_port));
                                    port = new_port;
                                    log_line(&data_for_thread, &format!("the local server exited before listening (likely a port race) — respawned on port {}", new_port));
                                    Step::Poll
                                }
                                Err(e) => {
                                    *guard = None;
                                    log_line(&data_for_thread, &format!("respawn after an early exit failed: {}", e));
                                    Step::Fail
                                }
                            }
                        } else {
                            *guard = None;
                            Step::Fail
                        }
                    } else { Step::Poll };
                    if matches!(step, Step::Fail) { show_startup_error(&handle, &data_for_thread); return; }
                    // Ready only when the responder is actually Lokyni (not a squatting service).
                    if server_is_lokyni(port) {
                        if let Some(win) = handle.get_webview_window("main") {
                            // Navigate natively rather than from page script: the server's
                            // control plane rejects cross-origin requests as a CSRF guard, and a
                            // script-initiated jump from the placeholder page's origin would
                            // count as cross-site and be blocked; a native top-level navigation
                            // is treated as a direct one and allowed.
                            if let Ok(url) = url::Url::parse(&format!("http://127.0.0.1:{}/", port)) {
                                let _ = win.navigate(url);
                            }
                        }
                        ready = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !ready { show_startup_error(&handle, &data_for_thread); return; }

                // ── Supervision: once the window is live, keep watching the sidecar. If it dies
                // unexpectedly later (an OOM kill, a fatal error in a native module, an external
                // kill of the node process), surface it instead of leaving the window on a dead
                // 127.0.0.1 page with no explanation. A normal quit takes the child out of shared
                // state first (stop_server), so a `None` here means an app-initiated shutdown and the
                // watch simply ends — only a still-present child that has exited is a real crash.
                // health_fails counts consecutive unresponsive health probes; a generous threshold (below) avoids
                // false alarms during a legitimately heavy but healthy operation (a big native FAISS add, a GC
                // pause), while still catching a genuinely wedged event loop.
                let mut health_fails: u32 = 0;
                loop {
                    std::thread::sleep(Duration::from_secs(2));
                    let crashed = if let Some(state) = handle.try_state::<Server>() {
                        let mut guard = state.0.lock().unwrap();
                        if guard.is_none() { return; }   // normal shutdown took the child — stop watching quietly
                        let dead = matches!(guard.as_mut().map(|(c, _)| c.try_wait()), Some(Ok(Some(_))));
                        if dead { *guard = None; }
                        dead
                    } else { return };
                    if crashed { show_sidecar_crashed(&handle, &data_for_thread); return; }
                    // The process is alive — but it may be WEDGED (a blocked event loop, a native-module deadlock)
                    // and the window left on a dead page with no explanation. A bounded /status probe (connect +
                    // read capped at 500 ms) with a generous consecutive-failure tolerance (~16 s of sustained
                    // no-response) surfaces that too, without false-alarming on a brief healthy stall.
                    if server_is_lokyni(port) {
                        health_fails = 0;
                    } else {
                        health_fails += 1;
                        if health_fails >= 8 {
                            // Confirm a shutdown didn't race us before declaring the sidecar wedged.
                            if handle.try_state::<Server>().map(|s| s.0.lock().unwrap().is_none()).unwrap_or(true) { return; }
                            show_sidecar_crashed(&handle, &data_for_thread);
                            return;
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                // If the server is busy, confirm before quitting so long work is not aborted.
                if confirm_keep_working(app) {
                    api.prevent_close();
                    return;
                }
                // Hide the window immediately so the up-to-12s graceful sidecar teardown below isn't perceived
                // as a frozen window; the process then exits once stop_server returns.
                let _ = window.hide();
                stop_server(app);
                // Quit the whole app on window close, on every platform. Without this, macOS keeps the
                // process alive after the last window closes (the platform default), leaving Lokyni running
                // with no window and a sidecar we just stopped — the Dock icon would do nothing and the
                // "quit and reopen to apply a setting" flow (for example turning on verbose logging) could
                // never complete. Windows and Linux already exit on last-window-close; calling exit here
                // makes all three deterministic. It runs only when actually quitting: a "Keep working"
                // choice above returns before reaching this point.
                app.exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Lokyni desktop shell")
        .run(|app, event| {
            match event {
                // macOS Cmd+Q / app-menu Quit raises ExitRequested (not a window CloseRequested), so apply the
                // same busy confirmation here — otherwise Cmd+Q aborts an in-flight index/answer with no prompt.
                RunEvent::ExitRequested { api, .. } => {
                    if confirm_keep_working(app) { api.prevent_exit(); }
                    // Quitting (e.g. Cmd+Q): hide the windows so the graceful teardown in RunEvent::Exit isn't
                    // perceived as a hang.
                    else { for w in app.webview_windows().values() { let _ = w.hide(); } }
                }
                // Stop the server on any application exit path, not just a window close, so it is
                // never left orphaned holding the port.
                RunEvent::Exit => stop_server(app),
                _ => {}
            }
        });
}
