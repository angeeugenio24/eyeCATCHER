import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  supabase,
  signUp,
  signIn,
  signOut,
  getCurrentUser,
  getProfile,
  updateProfile,
  saveSession as saveSessionToSupabase,
  getSessionStats,
  updateScreenTime,
  getScreenTimeSummary,
  getRandomTip,
  getAllProfiles,
  getAllSessions,
  getAllScreenTimeLogs,
  getAllTips,
  createTip,
  updateTip,
  deleteTip,
  getSystemConfig,
  updateSystemConfig,
  updateUserRole,
  Profile,
} from "./supabase";

// ===== Types =====
interface TimerState {
  is_running: boolean;
  is_paused: boolean;
  elapsed_seconds: number;
  pause_count: number;
}

// ===== State =====
let timerInterval: ReturnType<typeof setInterval> | null = null;
let screenTimeInterval: ReturnType<typeof setInterval> | null = null;
let timerState: TimerState = {
  is_running: false,
  is_paused: false,
  elapsed_seconds: 0,
  pause_count: 0,
};
let hasWarningShown = false;
let currentStatsPeriod = "today";
let currentUserId: string | null = null;
let currentProfile: Profile | null = null;
let screenTimeAccumulator = 0;
let adminClickCount = 0;
let adminClickTimer: ReturnType<typeof setTimeout> | null = null;

// ===== Dynamic Constants (from user settings) =====
let TIMER_DURATION_SECONDS = 20 * 60;
let BREAK_DURATION_SECONDS = 20;
let WARNING_BEFORE_SECONDS = 2 * 60;
let NOTIFICATION_MODE = "moderate";

// ===== DOM Elements =====
function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error("Element #" + id + " not found");
  return el;
}

function getElSafe(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ===== Screen Navigation =====
function showScreen(screenId: string): void {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  getEl(screenId).classList.add("active");
}

function showAuthError(msg: string): void {
  const el = getElSafe("auth-error");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

function hideAuthError(): void {
  const el = getElSafe("auth-error");
  if (el) { el.textContent = ""; el.classList.add("hidden"); }
}

function showProfileError(msg: string): void {
  const el = getElSafe("profile-error");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

// ===== Auth Flow =====
async function handleSignUp(): Promise<void> {
  hideAuthError();
  const email = (getEl("auth-email") as HTMLInputElement).value.trim();
  const password = (getEl("auth-password") as HTMLInputElement).value;
  const confirmPassword = (getEl("auth-confirm-password") as HTMLInputElement).value;
  const name = (getEl("auth-name") as HTMLInputElement).value.trim();

  if (!email || !password || !name || !confirmPassword) {
    showAuthError("Please fill in all fields.");
    return;
  }
  if (password.length < 6) {
    showAuthError("Password must be at least 6 characters.");
    return;
  }
  if (password !== confirmPassword) {
    showAuthError("Passwords do not match.");
    return;
  }

  const { user, error } = await signUp(email, password, name);
  if (error) { showAuthError(error); return; }
  if (!user) { showAuthError("Sign up failed. Please try again."); return; }

  currentUserId = user.id;
  currentProfile = await getProfile(user.id);
  showScreen("profile-setup-screen");
}

async function handleSignIn(): Promise<void> {
  hideAuthError();
  const email = (getEl("auth-email") as HTMLInputElement).value.trim();
  const password = (getEl("auth-password") as HTMLInputElement).value;

  if (!email || !password) {
    showAuthError("Please enter email and password.");
    return;
  }

  const { user, error } = await signIn(email, password);
  if (error) { showAuthError(error); return; }
  if (!user) { showAuthError("Sign in failed."); return; }

  currentUserId = user.id;
  currentProfile = await getProfile(user.id);
  await loadUserSettings();
  showScreen("timer-screen");
}

async function handleSignOut(): Promise<void> {
  stopScreenTimeTracking();
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  await signOut();
  currentUserId = null;
  currentProfile = null;
  resetTimerUI();
  showScreen("auth-screen");
}

// ===== Profile Setup =====
async function handleProfileSave(): Promise<void> {
  if (!currentUserId) return;
  const age = parseInt((getEl("profile-age") as HTMLInputElement).value) || null;
  const screenHours = parseFloat((getEl("profile-screen-hours") as HTMLInputElement).value) || 8;
  const workType = (getEl("profile-work-type") as HTMLSelectElement).value;

  const ok = await updateProfile(currentUserId, {
    age,
    daily_screen_hours: screenHours,
    work_type: workType,
  });
  if (!ok) { showProfileError("Failed to save profile."); return; }
  currentProfile = await getProfile(currentUserId);
  await loadUserSettings();
  showScreen("timer-screen");
}

// ===== Settings =====
async function loadSettingsUI(): Promise<void> {
  if (!currentProfile) return;
  (getEl("settings-name") as HTMLInputElement).value = currentProfile.display_name || "";
  (getEl("settings-age") as HTMLInputElement).value = currentProfile.age ? String(currentProfile.age) : "";
  (getEl("settings-screen-hours") as HTMLInputElement).value = String(currentProfile.daily_screen_hours || 8);
  (getEl("settings-work-type") as HTMLSelectElement).value = currentProfile.work_type || "general";
  (getEl("settings-break-interval") as HTMLInputElement).value = String(currentProfile.break_interval_minutes);
  (getEl("settings-break-duration") as HTMLInputElement).value = String(currentProfile.break_duration_seconds);
  (getEl("settings-notification-mode") as HTMLSelectElement).value = currentProfile.notification_mode;
}

async function handleSettingsSave(): Promise<void> {
  if (!currentUserId) return;
  const name = (getEl("settings-name") as HTMLInputElement).value.trim();
  const age = parseInt((getEl("settings-age") as HTMLInputElement).value) || null;
  const screenHours = parseFloat((getEl("settings-screen-hours") as HTMLInputElement).value) || 8;
  const workType = (getEl("settings-work-type") as HTMLSelectElement).value;
  const breakInterval = parseInt((getEl("settings-break-interval") as HTMLInputElement).value) || 20;
  const breakDuration = parseInt((getEl("settings-break-duration") as HTMLInputElement).value) || 20;
  const notifMode = (getEl("settings-notification-mode") as HTMLSelectElement).value;

  await updateProfile(currentUserId, {
    display_name: name,
    age,
    daily_screen_hours: screenHours,
    work_type: workType,
    break_interval_minutes: breakInterval,
    break_duration_seconds: breakDuration,
    notification_mode: notifMode,
  });
  currentProfile = await getProfile(currentUserId);
  await loadUserSettings();

  const msg = getElSafe("settings-saved-msg");
  if (msg) {
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2000);
  }
}

async function loadUserSettings(): Promise<void> {
  if (!currentProfile) return;
  TIMER_DURATION_SECONDS = currentProfile.break_interval_minutes * 60;
  BREAK_DURATION_SECONDS = currentProfile.break_duration_seconds;
  NOTIFICATION_MODE = currentProfile.notification_mode;
  WARNING_BEFORE_SECONDS = getWarningTime();

  const countdownEl = getElSafe("countdown-number");
  if (countdownEl) countdownEl.textContent = String(currentProfile.break_interval_minutes);
}

function getWarningTime(): number {
  switch (NOTIFICATION_MODE) {
    case "light": return 1 * 60;
    case "strict": return 5 * 60;
    default: return 2 * 60;
  }
}

// ===== Screen Time Monitoring =====
function startScreenTimeTracking(): void {
  screenTimeAccumulator = 0;
  screenTimeInterval = setInterval(() => {
    if (!timerState.is_paused) {
      screenTimeAccumulator++;
      if (screenTimeAccumulator % 60 === 0 && currentUserId) {
        updateScreenTime(currentUserId, 60, false);
        screenTimeAccumulator = 0;
      }
    }
  }, 1000);
}

async function stopScreenTimeTracking(): Promise<void> {
  if (screenTimeInterval) {
    clearInterval(screenTimeInterval);
    screenTimeInterval = null;
  }
  if (currentUserId && screenTimeAccumulator > 0) {
    await updateScreenTime(currentUserId, screenTimeAccumulator, false);
    screenTimeAccumulator = 0;
  }
}

// ===== Minute Scroll Rendering =====
function renderMinuteScroll(): void {
  const container = getEl("minute-scroll-list");
  container.innerHTML = "";

  const remaining = TIMER_DURATION_SECONDS - timerState.elapsed_seconds;
  const displayTime = Math.max(0, remaining);
  const currentMinute = Math.floor(displayTime / 60);
  const currentSecond = displayTime % 60;

  for (let i = -2; i <= 2; i++) {
    const minute = currentMinute + i;
    if (minute < 0) continue;

    const item = document.createElement("div");
    const isCurrent = i === 0;

    if (isCurrent) {
      item.className = "minute-item current";
      item.innerHTML = '<span class="minute-number">' + minute + '</span><span class="second-number">' + currentSecond.toString().padStart(2, "0") + '</span>';
    } else {
      item.className = "minute-item";
      item.textContent = String(minute);
    }

    container.appendChild(item);
  }
}

// ===== Timer Logic =====
function startTimer(): void {
  timerState = {
    is_running: true,
    is_paused: false,
    elapsed_seconds: 0,
    pause_count: 0,
  };
  hasWarningShown = false;

  getEl("timer-idle").classList.add("hidden");
  getEl("timer-running").classList.remove("hidden");
  getEl("terminate-btn").classList.remove("hidden");

  renderMinuteScroll();
  updateTimerDisplay();

  invoke("start_timer").catch(console.error);

  timerInterval = setInterval(() => {
    if (!timerState.is_paused && timerState.is_running) {
      timerState.elapsed_seconds++;
      updateTimerDisplay();
      checkTimerMilestones();
    }
  }, 1000);

  startScreenTimeTracking();
}

function updateTimerDisplay(): void {
  renderMinuteScroll();
}

function checkTimerMilestones(): void {
  const alertAt = Math.max(0, TIMER_DURATION_SECONDS - WARNING_BEFORE_SECONDS);
  if (alertAt > 0 && timerState.elapsed_seconds >= alertAt && !hasWarningShown) {
    hasWarningShown = true;
    showAlertNotification();
  }
  if (timerState.elapsed_seconds >= TIMER_DURATION_SECONDS) {
    triggerBlurOverlay();
  }
}

function showAlertNotification(): void {
  if (NOTIFICATION_MODE === "light") return;
  invoke("send_notification", {
    title: "eyeCATCHER",
    body: Math.floor(WARNING_BEFORE_SECONDS / 60) + " minute(s) left before eye break!",
  }).catch(console.error);
}

async function triggerBlurOverlay(): Promise<void> {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  await stopScreenTimeTracking();

  if (currentUserId) {
    await updateScreenTime(currentUserId, 0, true);
  }

  // Get a random tip and store it for the blur overlay to use
  const tip = await getRandomTip();
  if (tip) {
    localStorage.setItem("eyecatcher_break_tip_title", tip.title);
    localStorage.setItem("eyecatcher_break_tip_desc", tip.description);
    localStorage.setItem("eyecatcher_break_tip_cat", tip.category);
  } else {
    localStorage.removeItem("eyecatcher_break_tip_title");
    localStorage.removeItem("eyecatcher_break_tip_desc");
    localStorage.removeItem("eyecatcher_break_tip_cat");
  }
  localStorage.setItem("eyecatcher_break_duration", String(BREAK_DURATION_SECONDS));

  invoke("open_blur_overlay").catch(console.error);
}

async function onBlurComplete(): Promise<void> {
  if (currentUserId) {
    await saveSessionToSupabase(currentUserId, true, timerState.pause_count, timerState.elapsed_seconds);
  }
  invoke("save_session", { successful: true, pauses: timerState.pause_count }).catch(console.error);
  resetTimerUI();
  startTimer();
}

async function terminateTimer(): Promise<void> {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  stopScreenTimeTracking();
  timerState.is_running = false;

  if (currentUserId) {
    await saveSessionToSupabase(currentUserId, false, timerState.pause_count, timerState.elapsed_seconds);
  }
  invoke("save_session", { successful: false, pauses: timerState.pause_count }).catch(console.error);
  invoke("stop_timer").catch(console.error);

  resetTimerUI();
}

function resetTimerUI(): void {
  getEl("timer-idle").classList.remove("hidden");
  getEl("timer-running").classList.add("hidden");
  getEl("terminate-btn").classList.add("hidden");

  timerState = { is_running: false, is_paused: false, elapsed_seconds: 0, pause_count: 0 };
  hasWarningShown = false;

  const countdownEl = getElSafe("countdown-number");
  if (countdownEl && currentProfile) {
    countdownEl.textContent = String(currentProfile.break_interval_minutes);
  }
}

function pauseTimer(): void {
  if (timerState.is_running && !timerState.is_paused) {
    timerState.is_paused = true;
    timerState.pause_count++;
    updateTimerDisplay();
    invoke("pause_timer").catch(console.error);
  }
}

function resumeTimer(): void {
  if (timerState.is_running && timerState.is_paused) {
    timerState.is_paused = false;
    updateTimerDisplay();
    invoke("resume_timer").catch(console.error);
  }
}

// ===== Statistics =====
function switchStats(period: string): void {
  currentStatsPeriod = period;
  loadStats(period);
  updateStatsTabs();
}

function updateStatsTabs(): void {
  const leftBtn = getEl("tab-left");
  const rightBtn = getEl("tab-right");

  switch (currentStatsPeriod) {
    case "today":
      leftBtn.innerHTML = "&lt; Weekly";
      rightBtn.innerHTML = "Monthly &gt;";
      break;
    case "weekly":
      leftBtn.innerHTML = "&lt; Daily";
      rightBtn.innerHTML = "Monthly &gt;";
      break;
    case "monthly":
      leftBtn.innerHTML = "&lt; Weekly";
      rightBtn.innerHTML = "Daily &gt;";
      break;
  }
}

async function loadStats(period: string): Promise<void> {
  if (!currentUserId) return;
  try {
    const stats = await getSessionStats(currentUserId, period);
    getEl("stat-successful").textContent = String(stats.successful_sessions);
    getEl("stat-terminations").textContent = String(stats.terminations);
    getEl("stat-paused").textContent = String(stats.times_paused);

    const summary = await getScreenTimeSummary(currentUserId, period);
    const hours = Math.floor(summary.total_seconds / 3600);
    const mins = Math.floor((summary.total_seconds % 3600) / 60);
    getEl("stat-screen-time").textContent = hours + "h " + mins + "m";
    getEl("stat-breaks-taken").textContent = String(summary.breaks_taken);

    const titleEl = getEl("stats-screen").querySelector(".stats-title");
    if (titleEl) {
      if (period === "today") titleEl.textContent = "Today's Record";
      else if (period === "weekly") titleEl.textContent = "Weekly Record";
      else titleEl.textContent = "Monthly Record";
    }
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
}

// ===== HTML Escaping =====
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===== Admin Panel =====
function handleAdminAccess(): void {
  adminClickCount++;
  if (adminClickTimer) clearTimeout(adminClickTimer);
  adminClickTimer = setTimeout(() => { adminClickCount = 0; }, 800);

  if (adminClickCount >= 5) {
    adminClickCount = 0;
    if (currentProfile && currentProfile.role === "admin") {
      loadAdminPanel();
      showScreen("admin-screen");
    }
  }
}

async function loadAdminPanel(): Promise<void> {
  const profiles = await getAllProfiles();
  const userListEl = getEl("admin-user-list");
  userListEl.innerHTML = "";
  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "admin-row";
    const nameText = escapeHtml(p.display_name || "N/A");
    const userSelected = p.role === "user" ? "selected" : "";
    const adminSelected = p.role === "admin" ? "selected" : "";
    row.innerHTML = '<span class="admin-row-name">' + nameText + "</span>" +
      '<span class="admin-row-meta">' + escapeHtml(p.work_type) + " | " + escapeHtml(p.role) + "</span>" +
      '<select class="admin-role-select" data-uid="' + escapeHtml(p.id) + '">' +
      '<option value="user" ' + userSelected + ">User</option>" +
      '<option value="admin" ' + adminSelected + ">Admin</option>" +
      "</select>";
    userListEl.appendChild(row);
  }

  userListEl.querySelectorAll(".admin-role-select").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const target = e.target as HTMLSelectElement;
      const uid = target.getAttribute("data-uid");
      if (uid) await updateUserRole(uid, target.value);
    });
  });

  const allSessionsData = await getAllSessions();
  const allLogs = await getAllScreenTimeLogs();
  const totalUsers = profiles.length;
  const totalSessions = allSessionsData.length;
  const successRate = totalSessions > 0
    ? Math.round((allSessionsData.filter(s => s.successful).length / totalSessions) * 100)
    : 0;
  const totalScreenHours = Math.round(allLogs.reduce((sum, l) => sum + l.total_seconds, 0) / 3600);

  getEl("analytics-total-users").textContent = String(totalUsers);
  getEl("analytics-total-sessions").textContent = String(totalSessions);
  getEl("analytics-success-rate").textContent = successRate + "%";
  getEl("analytics-total-screen-hours").textContent = totalScreenHours + "h";

  const config = await getSystemConfig();
  (getEl("admin-break-interval") as HTMLInputElement).value = String(config["default_break_interval_minutes"] || 20);
  (getEl("admin-break-duration") as HTMLInputElement).value = String(config["default_break_duration_seconds"] || 20);
  const rawMode = config["default_notification_mode"];
  const modeStr = typeof rawMode === "string" ? rawMode.replace(/"/g, "") : "moderate";
  (getEl("admin-notification-mode") as HTMLSelectElement).value = modeStr;

  await loadAdminTips();
}

async function loadAdminTips(): Promise<void> {
  const tips = await getAllTips();
  const tipsListEl = getEl("admin-tips-list");
  tipsListEl.innerHTML = "";
  for (const tip of tips) {
    const row = document.createElement("div");
    row.className = "admin-tip-row";
    const toggleLabel = tip.is_active ? "Deactivate" : "Activate";
    row.innerHTML = '<div class="admin-tip-info">' +
      "<strong>" + escapeHtml(tip.title) + "</strong>" +
      '<span class="admin-tip-cat">' + escapeHtml(tip.category) + "</span>" +
      "<p>" + escapeHtml(tip.description) + "</p>" +
      "</div>" +
      '<div class="admin-tip-actions">' +
      '<button class="admin-tip-toggle" data-id="' + escapeHtml(tip.id) + '" data-active="' + tip.is_active + '">' + toggleLabel + "</button>" +
      '<button class="admin-tip-delete" data-id="' + escapeHtml(tip.id) + '">Delete</button>' +
      "</div>";
    tipsListEl.appendChild(row);
  }

  tipsListEl.querySelectorAll(".admin-tip-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id")!;
      const isActive = btn.getAttribute("data-active") === "true";
      await updateTip(id, { is_active: !isActive });
      await loadAdminTips();
    });
  });

  tipsListEl.querySelectorAll(".admin-tip-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id")!;
      await deleteTip(id);
      await loadAdminTips();
    });
  });
}

async function handleAdminConfigSave(): Promise<void> {
  const interval = parseInt((getEl("admin-break-interval") as HTMLInputElement).value) || 20;
  const duration = parseInt((getEl("admin-break-duration") as HTMLInputElement).value) || 20;
  const mode = (getEl("admin-notification-mode") as HTMLSelectElement).value;

  await updateSystemConfig("default_break_interval_minutes", interval);
  await updateSystemConfig("default_break_duration_seconds", duration);
  await updateSystemConfig("default_notification_mode", '"' + mode + '"');

  const msg = getElSafe("admin-config-saved");
  if (msg) { msg.classList.remove("hidden"); setTimeout(() => msg.classList.add("hidden"), 2000); }
}

async function handleAddTip(): Promise<void> {
  const title = (getEl("new-tip-title") as HTMLInputElement).value.trim();
  const desc = (getEl("new-tip-desc") as HTMLTextAreaElement).value.trim();
  const cat = (getEl("new-tip-category") as HTMLSelectElement).value;
  if (!title || !desc) return;

  await createTip(title, desc, cat);
  (getEl("new-tip-title") as HTMLInputElement).value = "";
  (getEl("new-tip-desc") as HTMLTextAreaElement).value = "";
  await loadAdminTips();
}

function showAdminTab(tabId: string): void {
  document.querySelectorAll(".admin-tab-content").forEach(t => t.classList.add("hidden"));
  document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.remove("active"));
  getEl(tabId).classList.remove("hidden");
  const btn = document.querySelector('[data-admin-tab="' + tabId + '"]');
  if (btn) btn.classList.add("active");
}

// ===== Event Listeners from Rust Backend =====
async function setupBackendListeners(): Promise<void> {
  await listen("user-idle", () => {
    if (timerState.is_running && !timerState.is_paused) {
      pauseTimer();
    }
  });

  await listen("user-active", () => {
    if (timerState.is_running && timerState.is_paused) {
      resumeTimer();
    }
  });

  await listen("blur-complete", () => {
    onBlurComplete();
  });
}

// ===== Initialization =====
window.addEventListener("DOMContentLoaded", async () => {
  // Register splash screen auth buttons before any async calls
  // so they always work even if Supabase is unreachable
  function setAuthMode(mode: "signin" | "signup"): void {
    const nameGroup = getEl("auth-name-group");
    const confirmGroup = getEl("auth-confirm-group");
    const signUpBtn = getEl("auth-signup-btn");
    const signInBtn = getEl("auth-signin-btn");
    const heading = getEl("auth-heading");
    const toggleText = getEl("auth-toggle-mode");
    const extraRow = getEl("auth-extra-row");
    if (mode === "signin") {
      nameGroup.classList.add("hidden");
      confirmGroup.classList.add("hidden");
      signUpBtn.classList.add("hidden");
      signInBtn.classList.remove("hidden");
      extraRow.classList.remove("hidden");
      heading.textContent = "Login";
      toggleText.innerHTML = "don't have an account? <span class=\"link\">sign up</span>";
    } else {
      nameGroup.classList.remove("hidden");
      confirmGroup.classList.remove("hidden");
      signUpBtn.classList.remove("hidden");
      signInBtn.classList.add("hidden");
      extraRow.classList.add("hidden");
      heading.textContent = "Sign up";
      toggleText.innerHTML = "already have an account? <span class=\"link\">login</span>";
    }
    hideAuthError();
  }

  getEl("splash-login-btn").addEventListener("click", () => {
    setAuthMode("signin");
    showScreen("auth-screen");
  });

  getEl("splash-signup-btn").addEventListener("click", () => {
    setAuthMode("signup");
    showScreen("auth-screen");
  });

  getEl("auth-back-btn").addEventListener("click", () => {
    hideAuthError();
    showScreen("splash-screen");
  });

  let user = null;
  try {
    user = await getCurrentUser();
  } catch (e) {
    console.error("Failed to check auth status:", e);
  }

  if (user) {
    currentUserId = user.id;
    try {
      currentProfile = await getProfile(user.id);
    } catch (e) {
      console.error("Failed to load profile:", e);
    }
    if (currentProfile) {
      await loadUserSettings();
      showScreen("timer-screen");
    } else {
      showScreen("profile-setup-screen");
    }
  }

  getEl("auth-signup-btn").addEventListener("click", handleSignUp);
  getEl("auth-signin-btn").addEventListener("click", handleSignIn);

  getEl("auth-toggle-mode").addEventListener("click", () => {
    const nameGroup = getEl("auth-name-group");
    const isSignUp = !nameGroup.classList.contains("hidden");
    setAuthMode(isSignUp ? "signin" : "signup");
  });

  getEl("profile-save-btn").addEventListener("click", handleProfileSave);
  getEl("start-timer-btn").addEventListener("click", () => { startTimer(); });
  getEl("terminate-btn").addEventListener("click", () => { terminateTimer(); });

  getEl("go-stats-btn").addEventListener("click", () => {
    switchStats("today");
    showScreen("stats-screen");
  });

  getEl("go-timer-btn").addEventListener("click", () => { showScreen("timer-screen"); });

  getEl("go-settings-btn").addEventListener("click", () => {
    loadSettingsUI();
    showScreen("settings-screen");
  });
  getEl("settings-save-btn").addEventListener("click", handleSettingsSave);
  getEl("settings-back-btn").addEventListener("click", () => { showScreen("timer-screen"); });
  getEl("settings-logout-btn").addEventListener("click", handleSignOut);

  getEl("tab-left").addEventListener("click", () => {
    switch (currentStatsPeriod) {
      case "today": switchStats("weekly"); break;
      case "weekly": switchStats("today"); break;
      case "monthly": switchStats("weekly"); break;
    }
  });

  getEl("tab-right").addEventListener("click", () => {
    switch (currentStatsPeriod) {
      case "today": switchStats("monthly"); break;
      case "weekly": switchStats("monthly"); break;
      case "monthly": switchStats("today"); break;
    }
  });

  const timerTitle = getElSafe("timer-app-title");
  if (timerTitle) timerTitle.addEventListener("click", handleAdminAccess);

  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-admin-tab");
      if (tabId) showAdminTab(tabId);
    });
  });

  getElSafe("admin-config-save-btn")?.addEventListener("click", handleAdminConfigSave);
  getElSafe("admin-add-tip-btn")?.addEventListener("click", handleAddTip);
  getElSafe("admin-back-btn")?.addEventListener("click", () => { showScreen("timer-screen"); });

  // Theme toggle
  getEl("theme-toggle-btn").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("eyecatcher-theme", next);
  });

  setupBackendListeners().catch((e) => console.error("Backend listeners failed:", e));

  const reportActivity = () => { invoke("report_activity").catch(() => {}); };
  document.addEventListener("mousemove", reportActivity);
  document.addEventListener("keydown", reportActivity);
  document.addEventListener("click", reportActivity);
  document.addEventListener("scroll", reportActivity);

  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (_event === "SIGNED_OUT") {
      currentUserId = null;
      currentProfile = null;
    } else if (session?.user) {
      currentUserId = session.user.id;
      currentProfile = await getProfile(session.user.id);
    }
  });
});
