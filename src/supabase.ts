import { createClient, SupabaseClient, User, Session } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing Supabase environment variables. Check .env file.");
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== Types =====

export interface Profile {
  id: string;
  display_name: string | null;
  age: number | null;
  daily_screen_hours: number | null;
  work_type: string;
  role: string;
  notification_mode: string;
  break_interval_minutes: number;
  break_duration_seconds: number;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  successful: boolean;
  pauses: number;
  duration_seconds: number;
  created_at: string;
}

export interface ScreenTimeLog {
  id: string;
  user_id: string;
  date: string;
  total_seconds: number;
  breaks_taken: number;
}

export interface EyeCareTip {
  id: string;
  title: string;
  description: string;
  category: string;
  is_active: boolean;
  created_at: string;
}

export interface SystemConfig {
  key: string;
  value: string | number;
  updated_at: string;
}

// ===== Auth Helpers =====

export async function signUp(email: string, password: string, displayName: string): Promise<{ user: User | null; error: string | null }> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) return { user: null, error: error.message };
  return { user: data.user, error: null };
}

export async function signIn(email: string, password: string): Promise<{ user: User | null; session: Session | null; error: string | null }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { user: null, session: null, error: error.message };
  return { user: data.user, session: data.session, error: null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function getCurrentUser(): Promise<User | null> {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

// ===== Profile Helpers =====

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error) { console.error("getProfile error:", error); return null; }
  return data as Profile;
}

export async function updateProfile(userId: string, updates: Partial<Profile>): Promise<boolean> {
  const { error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId);
  if (error) { console.error("updateProfile error:", error); return false; }
  return true;
}

// ===== Session Helpers =====

export async function saveSession(userId: string, successful: boolean, pauses: number, durationSeconds: number): Promise<boolean> {
  const { error } = await supabase
    .from("sessions")
    .insert({ user_id: userId, successful, pauses, duration_seconds: durationSeconds });
  if (error) { console.error("saveSession error:", error); return false; }
  return true;
}

export async function getSessionStats(userId: string, period: string): Promise<{ successful_sessions: number; terminations: number; times_paused: number }> {
  const now = new Date();
  let startDate: string;

  if (period === "today") {
    startDate = now.toISOString().split("T")[0] + "T00:00:00";
  } else if (period === "weekly") {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    startDate = weekAgo.toISOString();
  } else {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    startDate = monthStart.toISOString();
  }

  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .gte("created_at", startDate);

  if (error || !data) return { successful_sessions: 0, terminations: 0, times_paused: 0 };

  const records = data as SessionRecord[];
  return {
    successful_sessions: records.filter(s => s.successful).length,
    terminations: records.filter(s => !s.successful).length,
    times_paused: records.reduce((sum, s) => sum + s.pauses, 0),
  };
}

// ===== Screen Time Helpers =====

export async function updateScreenTime(userId: string, additionalSeconds: number, breakTaken: boolean): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // Try to get existing record for today
  const { data: existing } = await supabase
    .from("screen_time_logs")
    .select("*")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  if (existing) {
    await supabase
      .from("screen_time_logs")
      .update({
        total_seconds: (existing as ScreenTimeLog).total_seconds + additionalSeconds,
        breaks_taken: (existing as ScreenTimeLog).breaks_taken + (breakTaken ? 1 : 0),
      })
      .eq("id", (existing as ScreenTimeLog).id);
  } else {
    await supabase
      .from("screen_time_logs")
      .insert({
        user_id: userId,
        date: today,
        total_seconds: additionalSeconds,
        breaks_taken: breakTaken ? 1 : 0,
      });
  }
}

export async function getScreenTimeSummary(userId: string, period: string): Promise<{ total_seconds: number; breaks_taken: number; days_active: number }> {
  const now = new Date();
  let startDate: string;

  if (period === "today") {
    startDate = now.toISOString().split("T")[0];
  } else if (period === "weekly") {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    startDate = weekAgo.toISOString().split("T")[0];
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  }

  const { data, error } = await supabase
    .from("screen_time_logs")
    .select("*")
    .eq("user_id", userId)
    .gte("date", startDate);

  if (error || !data) return { total_seconds: 0, breaks_taken: 0, days_active: 0 };

  const logs = data as ScreenTimeLog[];
  return {
    total_seconds: logs.reduce((sum, l) => sum + l.total_seconds, 0),
    breaks_taken: logs.reduce((sum, l) => sum + l.breaks_taken, 0),
    days_active: logs.length,
  };
}

// ===== Eye Care Tips =====

export async function getActiveTips(): Promise<EyeCareTip[]> {
  const { data, error } = await supabase
    .from("eye_care_tips")
    .select("*")
    .eq("is_active", true);
  if (error || !data) return [];
  return data as EyeCareTip[];
}

export async function getRandomTip(): Promise<EyeCareTip | null> {
  const tips = await getActiveTips();
  if (tips.length === 0) return null;
  return tips[Math.floor(Math.random() * tips.length)];
}

// ===== Admin Helpers =====

export async function getAllProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as Profile[];
}

export async function getAllSessions(): Promise<SessionRecord[]> {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return data as SessionRecord[];
}

export async function getAllScreenTimeLogs(): Promise<ScreenTimeLog[]> {
  const { data, error } = await supabase
    .from("screen_time_logs")
    .select("*")
    .order("date", { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return data as ScreenTimeLog[];
}

export async function getAllTips(): Promise<EyeCareTip[]> {
  const { data, error } = await supabase
    .from("eye_care_tips")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as EyeCareTip[];
}

export async function createTip(title: string, description: string, category: string): Promise<boolean> {
  const { error } = await supabase
    .from("eye_care_tips")
    .insert({ title, description, category });
  if (error) { console.error("createTip error:", error); return false; }
  return true;
}

export async function updateTip(id: string, updates: Partial<EyeCareTip>): Promise<boolean> {
  const { error } = await supabase
    .from("eye_care_tips")
    .update(updates)
    .eq("id", id);
  if (error) { console.error("updateTip error:", error); return false; }
  return true;
}

export async function deleteTip(id: string): Promise<boolean> {
  const { error } = await supabase
    .from("eye_care_tips")
    .delete()
    .eq("id", id);
  if (error) { console.error("deleteTip error:", error); return false; }
  return true;
}

export async function getSystemConfig(): Promise<Record<string, string | number>> {
  const { data, error } = await supabase
    .from("system_config")
    .select("*");
  if (error || !data) return {};
  const config: Record<string, string | number> = {};
  for (const row of data as SystemConfig[]) {
    config[row.key] = row.value;
  }
  return config;
}

export async function updateSystemConfig(key: string, value: string | number): Promise<boolean> {
  const { error } = await supabase
    .from("system_config")
    .upsert({ key, value: value as unknown as string, updated_at: new Date().toISOString() });
  if (error) { console.error("updateSystemConfig error:", error); return false; }
  return true;
}

export async function updateUserRole(userId: string, role: string): Promise<boolean> {
  const { error } = await supabase
    .from("profiles")
    .update({ role })
    .eq("id", userId);
  if (error) { console.error("updateUserRole error:", error); return false; }
  return true;
}
