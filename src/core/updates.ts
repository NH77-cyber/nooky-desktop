// Self-update from GitHub Releases (tauri-plugin-updater, signed packages) and
// relaunch (tauri-plugin-process). Nooky Desktop — original code.

import { IS_TAURI, USE_MOCK } from "./bridge";

export interface PendingUpdate {
  version: string;
  notes: string;
  /** Downloads, installs and relaunches. `progress` gets 0…1, or null when the size is unknown. */
  install(progress: (p: number | null) => void): Promise<void>;
}

export type CheckResult = { ok: true; update: PendingUpdate | null } | { ok: false; error: string };

export const Updates = {
  current: "",
  pending: null as PendingUpdate | null,
  /** "idle" | "installing" | "error" */
  status: "idle" as "idle" | "installing" | "error",
  progress: null as number | null,
  error: null as string | null,
};

export async function checkForUpdate(): Promise<CheckResult> {
  if (!IS_TAURI) {
    if (USE_MOCK && location.hash === "#update") {
      return {
        ok: true,
        update: {
          version: "0.3.1",
          notes: "",
          install: async (p) => {
            for (let i = 1; i <= 10; i++) {
              await new Promise((r) => setTimeout(r, 120));
              p(i / 10);
            }
          },
        },
      };
    }
    return { ok: true, update: null };
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    if (!u) return { ok: true, update: null };
    return {
      ok: true,
      update: {
        version: u.version,
        notes: u.body ?? "",
        install: async (progress) => {
          let total = 0;
          let done = 0;
          await u.downloadAndInstall((ev) => {
            if (ev.event === "Started") {
              total = ev.data.contentLength ?? 0;
              progress(total ? 0 : null);
            } else if (ev.event === "Progress") {
              done += ev.data.chunkLength;
              progress(total ? Math.min(1, done / total) : null);
            } else if (ev.event === "Finished") {
              progress(1);
            }
          });
          // On Windows the installer has already closed Nooky by now.
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        },
      },
    };
  } catch (err) {
    return { ok: false, error: String(err).replace(/^Error:\s*/, "") };
  }
}
