import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

/** Clever Cloud PostgreSQL add-on or any Postgres (DATABASE_URL). */
export function resolveDatabaseUrl(): string | null {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return direct;

  const host = process.env.POSTGRESQL_ADDON_HOST;
  const user = process.env.POSTGRESQL_ADDON_USER;
  const password = process.env.POSTGRESQL_ADDON_PASSWORD;
  const database = process.env.POSTGRESQL_ADDON_DB;
  const port = process.env.POSTGRESQL_ADDON_PORT || "5432";
  if (host && user && password && database) {
    const u = encodeURIComponent(user);
    const p = encodeURIComponent(password);
    let url = `postgresql://${u}:${p}@${host}:${port}/${database}`;
    if (!url.includes("sslmode=") && !host.includes("localhost")) {
      url += (url.includes("?") ? "&" : "?") + "sslmode=require";
    }
    return url;
  }
  return null;
}

export function isDbConfigured(): boolean {
  return resolveDatabaseUrl() !== null;
}

function logDbTarget(connectionString: string): void {
  try {
    const forUrl = connectionString.replace(/^postgres(ql)?:\/\//i, "http://");
    const u = new URL(forUrl);
    const db = u.pathname.replace(/^\//, "").split("?")[0] || "(none)";
    const port = u.port || "5432";
    console.log(
      `PostgreSQL: connecting as ${u.username || "(no user)"} @ ${u.hostname}:${port} / ${db}`,
    );
  } catch {
    console.warn("PostgreSQL: could not parse DATABASE_URL for diagnostics.");
  }
}

export async function initDb(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url) {
    console.warn("PostgreSQL not configured (no DATABASE_URL / POSTGRESQL_ADDON_*): admin cannot collect chats to DB.");
    return;
  }

  logDbTarget(url);

  const ssl =
    url.includes("localhost") || url.includes("127.0.0.1")
      ? undefined
      : { rejectUnauthorized: false };

  pool = new Pool({ connectionString: url, ssl });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS archived_chats (
      id SERIAL PRIMARY KEY,
      room_id VARCHAR(64) NOT NULL,
      treatment VARCHAR(32) NOT NULL,
      label TEXT,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      messages JSONB NOT NULL,
      p1_voluntary_exit_ms BIGINT,
      p2_voluntary_exit_ms BIGINT,
      p1_connected_at_archive BOOLEAN NOT NULL DEFAULT FALSE,
      p2_connected_at_archive BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  console.log("PostgreSQL: archived_chats table ready.");
}

export type ArchivePayload = {
  roomId: string;
  treatment: string;
  label: string | null;
  messages: unknown;
  p1VoluntaryExitMs: number | null;
  p2VoluntaryExitMs: number | null;
  p1Connected: boolean;
  p2Connected: boolean;
};

export async function insertArchivedChat(row: ArchivePayload): Promise<number> {
  if (!pool) throw new Error("Database not initialized");

  const r = await pool.query<{ id: number }>(
    `INSERT INTO archived_chats (
      room_id, treatment, label, messages,
      p1_voluntary_exit_ms, p2_voluntary_exit_ms,
      p1_connected_at_archive, p2_connected_at_archive
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
    RETURNING id`,
    [
      row.roomId,
      row.treatment,
      row.label,
      JSON.stringify(row.messages),
      row.p1VoluntaryExitMs,
      row.p2VoluntaryExitMs,
      row.p1Connected,
      row.p2Connected,
    ],
  );
  return r.rows[0]?.id ?? 0;
}

export async function listArchivedChats(limit = 50): Promise<
  Array<{
    id: number;
    room_id: string;
    treatment: string;
    label: string | null;
    archived_at: string;
    message_count: number;
  }>
> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT id, room_id, treatment, label, archived_at,
            jsonb_array_length(messages) AS message_count
     FROM archived_chats
     ORDER BY archived_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows as Array<{
    id: number;
    room_id: string;
    treatment: string;
    label: string | null;
    archived_at: string;
    message_count: number;
  }>;
}

export type ArchivedChatFull = {
  id: number;
  room_id: string;
  treatment: string;
  label: string | null;
  /** `pg` may return a `Date` for `TIMESTAMPTZ`. */
  archived_at: string | Date;
  messages: unknown;
  p1_voluntary_exit_ms: number | null;
  p2_voluntary_exit_ms: number | null;
  p1_connected_at_archive: boolean;
  p2_connected_at_archive: boolean;
};

export async function getArchivedChatById(id: number): Promise<ArchivedChatFull | null> {
  if (!pool || !Number.isFinite(id) || id < 1) return null;
  const r = await pool.query(
    `SELECT id, room_id, treatment, label, archived_at, messages,
            p1_voluntary_exit_ms, p2_voluntary_exit_ms,
            p1_connected_at_archive, p2_connected_at_archive
     FROM archived_chats WHERE id = $1`,
    [id],
  );
  const row = r.rows[0] as ArchivedChatFull | undefined;
  return row ?? null;
}
