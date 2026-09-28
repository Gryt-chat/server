import { consola } from "consola";

import type { WriteProbeResult } from "../db/sqlite/connection";

export type DatabaseHealth =
  | { healthy: true }
  | { healthy: false; detail: "starting" | "init failed" | "not writable" };

/** /health is public and polled, so the write probe runs at most this often. */
export const WRITE_PROBE_INTERVAL_MS = 30_000;

export function createDatabaseHealth(
  probe: () => WriteProbeResult,
  now: () => number = Date.now,
) {
  let state: "starting" | "open" | "failed" = "starting";
  let probedAt = -Infinity;
  let writable = true;

  return {
    opened(): void {
      state = "open";
    },
    failed(): void {
      state = "failed";
    },
    check(): DatabaseHealth {
      if (state === "starting") return { healthy: false, detail: "starting" };
      if (state === "failed") return { healthy: false, detail: "init failed" };

      if (now() - probedAt >= WRITE_PROBE_INTERVAL_MS) {
        probedAt = now();
        let result: WriteProbeResult;
        try {
          result = probe();
        } catch {
          result = "failed";
        }
        // Busy means another process is writing, so the file works; keep the last answer.
        if (result !== "busy") {
          const was = writable;
          writable = result === "ok";
          if (was && !writable) {
            consola.error(
              "SQLite database can't be written. Check that the data folder and gryt.db " +
                "belong to the user the server runs as.",
            );
          } else if (!was && writable) {
            consola.success("SQLite database is writable again");
          }
        }
      }

      return writable ? { healthy: true } : { healthy: false, detail: "not writable" };
    },
  };
}
