import consola from "consola";
import type { DatabaseSync } from "node:sqlite";

/* Every member's access token leaked through server:clients until GRYT-1239, and
   a leaked token cannot be recalled. This retires them once on upgrade. */

/* The bump moves server_config.token_version, which requireAuth and token:refresh
   compare against. Refresh tokens are untouched, so a live client re-mints. */

export const TOKEN_REISSUE_MIGRATION_KEY = "access_token_reissue_gryt1239";

/**
 * Bumps `server_config.token_version` once, and only on a database that already
 * had members. Returns the new version, or null when nothing was bumped.
 */
export function reissueAccessTokensAfterLeak(d: DatabaseSync): number | null {
  const already = d.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(TOKEN_REISSUE_MIGRATION_KEY) as
    | { value: string }
    | undefined;
  if (already) return null;

  // Nobody ever joined, so no token was ever minted and nothing leaked. The
  // marker is still written below, so a later boot never re-checks a fresh DB.
  const members = d.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
  const now = new Date().toISOString();

  d.exec("BEGIN");
  try {
    let bumpedTo: number | null = null;
    if (members.n > 0) {
      d.prepare(`UPDATE server_config SET token_version = token_version + 1`).run();
      const row = d.prepare(`SELECT token_version FROM server_config`).get() as
        | { token_version: number }
        | undefined;
      bumpedTo = row?.token_version ?? null;
    }
    // In the same transaction as the bump, or a crash between them retires
    // tokens again on the next boot.
    d.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
    ).run(TOKEN_REISSUE_MIGRATION_KEY, now, now);
    d.exec("COMMIT");

    if (bumpedTo !== null) {
      consola.info(
        `[migration] GRYT-1239: retired access tokens minted before this version; ` +
        `server_config.token_version is now ${bumpedTo}. Live clients re-mint from their refresh token.`,
      );
    }
    return bumpedTo;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}
