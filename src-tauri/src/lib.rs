use chrono::{Local, NaiveDate, Datelike};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::Color;

// ===== Data Structures =====

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    date: String,
    successful: bool,
    pauses: u32,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStore {
    sessions: Vec<Session>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStats {
    successful_sessions: u32,
    terminations: u32,
    times_paused: u32,
}

// ===== App State =====

struct AppState {
    last_activity: std::time::Instant,
    timer_running: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            last_activity: std::time::Instant::now(),
            timer_running: false,
        }
    }
}

// ===== Helpers =====

fn get_data_dir() -> PathBuf {
    let mut dir = dirs_next().unwrap_or_else(|| PathBuf::from("."));
    dir.push("eyecatcher_data");
    fs::create_dir_all(&dir).ok();
    dir
}

fn dirs_next() -> Option<PathBuf> {
    // Use platform-appropriate data directory
    #[cfg(target_os = "linux")]
    {
        std::env::var("XDG_DATA_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| PathBuf::from(h).join(".local").join("share"))
            })
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA").ok().map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Some(PathBuf::from("."))
    }
}

fn get_sessions_file() -> PathBuf {
    get_data_dir().join("sessions.json")
}

fn load_sessions() -> SessionStore {
    let path = get_sessions_file();
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&data).unwrap_or(SessionStore {
            sessions: Vec::new(),
        })
    } else {
        SessionStore {
            sessions: Vec::new(),
        }
    }
}

fn save_sessions(store: &SessionStore) {
    let path = get_sessions_file();
    if let Ok(data) = serde_json::to_string_pretty(store) {
        fs::write(path, data).ok();
    }
}

// ===== Tauri Commands =====

#[tauri::command]
fn start_timer(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.timer_running = true;
        s.last_activity = std::time::Instant::now();
    }
}

#[tauri::command]
fn stop_timer(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.timer_running = false;
    }
}

#[tauri::command]
fn pause_timer(state: State<Mutex<AppState>>) {
    // Frontend handles pause logic; this is for backend awareness
    if let Ok(mut s) = state.lock() {
        s.timer_running = false;
    }
}

#[tauri::command]
fn resume_timer(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.timer_running = true;
        s.last_activity = std::time::Instant::now();
    }
}

#[tauri::command]
fn report_activity(state: State<Mutex<AppState>>) {
    if let Ok(mut s) = state.lock() {
        s.last_activity = std::time::Instant::now();
    }
}

#[tauri::command]
fn save_session(successful: bool, pauses: u32) {
    let now = Local::now();
    let session = Session {
        date: now.format("%Y-%m-%d").to_string(),
        successful,
        pauses,
        timestamp: now.format("%Y-%m-%dT%H:%M:%S").to_string(),
    };

    let mut store = load_sessions();
    store.sessions.push(session);
    save_sessions(&store);
}

#[tauri::command]
fn get_stats(period: String) -> SessionStats {
    let store = load_sessions();
    let today = Local::now().date_naive();

    let filtered: Vec<&Session> = store
        .sessions
        .iter()
        .filter(|s| {
            if let Ok(session_date) = NaiveDate::parse_from_str(&s.date, "%Y-%m-%d") {
                match period.as_str() {
                    "today" => session_date == today,
                    "weekly" => {
                        let days_diff = (today - session_date).num_days();
                        days_diff >= 0 && days_diff < 7
                    }
                    "monthly" => {
                        session_date.year() == today.year()
                            && session_date.month() == today.month()
                    }
                    _ => session_date == today,
                }
            } else {
                false
            }
        })
        .collect();

    let successful_sessions = filtered.iter().filter(|s| s.successful).count() as u32;
    let terminations = filtered.iter().filter(|s| !s.successful).count() as u32;
    let times_paused: u32 = filtered.iter().map(|s| s.pauses).sum();

    SessionStats {
        successful_sessions,
        terminations,
        times_paused,
    }
}

#[tauri::command]
fn send_notification(title: String, body: String, app: AppHandle) {
    // Use tauri notification plugin
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .ok();
}

#[tauri::command]
async fn open_blur_overlay(app: AppHandle) -> Result<(), String> {
    // Close existing blur window if it's still open
    if let Some(window) = app.get_webview_window("blur-overlay") {
        window.close().ok();
    }

    // Create fullscreen, always-on-top, undecorated, transparent window for the blur overlay
    let _blur_window = WebviewWindowBuilder::new(
        &app,
        "blur-overlay",
        WebviewUrl::App("blur.html".into()),
    )
    .title("eyeCATCHER - Break")
    .fullscreen(true)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .focused(true)
    .transparent(true)
    .background_color(Color(15, 15, 15, 200))
    .build()
    .map_err(|e| e.to_string())?;

    // Apply platform-specific blur effect to the window
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_blur;
        apply_blur(&_blur_window, Some((18, 18, 18, 200)))
            .map_err(|e| format!("Failed to apply blur: {:?}", e))
            .ok(); // Don't fail if blur isn't supported, fall back to semi-transparent bg
    }

    Ok(())
}

#[tauri::command]
async fn close_blur_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("blur-overlay") {
        window.close().map_err(|e| e.to_string())?;
    }
    // Notify main window that the blur overlay is complete
    app.emit("blur-complete", ()).ok();
    Ok(())
}

// ===== Idle Monitor Background Thread =====

fn start_idle_monitor(app: AppHandle, state_mutex: std::sync::Arc<Mutex<AppState>>) {
    const IDLE_THRESHOLD_SECS: u64 = 120; // 2 minutes

    std::thread::spawn(move || {
        let mut was_idle = false;

        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));

            let (is_timer_running, idle_secs) = {
                if let Ok(s) = state_mutex.lock() {
                    (s.timer_running, s.last_activity.elapsed().as_secs())
                } else {
                    continue;
                }
            };

            if !is_timer_running {
                was_idle = false;
                continue;
            }

            if idle_secs >= IDLE_THRESHOLD_SECS && !was_idle {
                was_idle = true;
                app.emit("user-idle", ()).ok();
            } else if idle_secs < IDLE_THRESHOLD_SECS && was_idle {
                was_idle = false;
                app.emit("user-active", ()).ok();
            }
        }
    });
}

// ===== Entry Point =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = std::sync::Arc::new(Mutex::new(AppState::default()));
    let monitor_state = app_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            start_timer,
            stop_timer,
            pause_timer,
            resume_timer,
            report_activity,
            save_session,
            get_stats,
            send_notification,
            open_blur_overlay,
            close_blur_overlay,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            start_idle_monitor(handle, monitor_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
