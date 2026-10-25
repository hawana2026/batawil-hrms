import { api } from "./core.js";
import { endSession } from "./state.js";

export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // The local session is cleared even if the server call could not be completed.
  }
  endSession();
}

export async function logoutEverywhere() {
  await api("/api/auth/logout-all", { method: "POST" });
  endSession("تم إنهاء جميع الجلسات. سجّل الدخول من جديد.");
}
