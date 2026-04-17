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
    // Do not append sslmode=require: Node 20+ / pg 8+ treat it like verify-full and reject
    // managed-Postgres certs (e.g. Clever Cloud). TLS is enabled via Pool `ssl` below.
    return `postgresql://${u}:${p}@${host}:${port}/${database}`;
  }
  return null;
}

/** Remove ssl query params so Pool `ssl: { rejectUnauthorized: false }` is not overridden. */
function stripPgSslQueryParams(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const base = url.slice(0, q);
  const rest = url.slice(q + 1);
  const params = rest
    .split("&")
    .filter((p) => p.length > 0 && !/^sslmode=/i.test(p) && !/^uselibpqcompat=/i.test(p));
  return params.length ? `${base}?${params.join("&")}` : base;
}

/** True only after a successful pool init + schema (env vars alone are not enough). */
export function isDbConfigured(): boolean {
  return pool !== null;
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
  const rawUrl = resolveDatabaseUrl();
  if (!rawUrl) {
    console.warn("PostgreSQL not configured (no DATABASE_URL / POSTGRESQL_ADDON_*): admin cannot collect chats to DB.");
    return;
  }

  const isLocal =
    rawUrl.includes("localhost") ||
    rawUrl.includes("127.0.0.1") ||
    /@[^/?]*localhost/i.test(rawUrl);
  const url = isLocal ? rawUrl : stripPgSslQueryParams(rawUrl);

  logDbTarget(url);

  const ssl = isLocal ? undefined : { rejectUnauthorized: false };

  try {
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

    await pool.query(`
    CREATE TABLE IF NOT EXISTS session_questionnaire_responses (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      participant_public_id VARCHAR(64) NOT NULL,
      display_name VARCHAR(80) NOT NULL,
      answers JSONB NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, participant_public_id)
    );
  `);

    await pool.query(`
      ALTER TABLE archived_chats ADD COLUMN IF NOT EXISTS session_id VARCHAR(64);
    `);
    await pool.query(`
      ALTER TABLE archived_chats ADD COLUMN IF NOT EXISTS p1_participant_public_id VARCHAR(64);
    `);
    await pool.query(`
      ALTER TABLE archived_chats ADD COLUMN IF NOT EXISTS p2_participant_public_id VARCHAR(64);
    `);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS session_exit_surveys (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      participant_public_id VARCHAR(64) NOT NULL,
      display_name VARCHAR(80) NOT NULL,
      age TEXT NOT NULL,
      work TEXT NOT NULL,
      feedback TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, participant_public_id)
    );
  `);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS collected_sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      session_label TEXT,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      snapshot JSONB NOT NULL
    );
  `);

    console.log(
      "PostgreSQL: archived_chats + session_questionnaire_responses + session_exit_surveys + collected_sessions ready.",
    );
  } catch (e) {
    console.error("PostgreSQL: connection or migration failed - app will run without DB until this is fixed.");
    console.error(e);
    try {
      await pool?.end();
    } catch {
      /* ignore */
    }
    pool = null;
  }
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
  sessionId?: string | null;
  p1ParticipantPublicId?: string | null;
  p2ParticipantPublicId?: string | null;
};

export async function insertArchivedChat(row: ArchivePayload): Promise<number> {
  if (!pool) throw new Error("Database not initialized");

  const r = await pool.query<{ id: number }>(
    `INSERT INTO archived_chats (
      room_id, treatment, label, messages,
      p1_voluntary_exit_ms, p2_voluntary_exit_ms,
      p1_connected_at_archive, p2_connected_at_archive,
      session_id, p1_participant_public_id, p2_participant_public_id
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
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
      row.sessionId ?? null,
      row.p1ParticipantPublicId ?? null,
      row.p2ParticipantPublicId ?? null,
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

export type QuestionnaireAnswerRow = { questionId: string; prompt: string; answer: string };

export type SessionQuestionnairePayload = {
  sessionId: string;
  participantPublicId: string;
  displayName: string;
  answers: QuestionnaireAnswerRow[];
};

export async function upsertSessionQuestionnaire(row: SessionQuestionnairePayload): Promise<void> {
  if (!pool) throw new Error("Database not initialized");
  await pool.query(
    `INSERT INTO session_questionnaire_responses (session_id, participant_public_id, display_name, answers)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (session_id, participant_public_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, answers = EXCLUDED.answers, submitted_at = NOW()`,
    [row.sessionId, row.participantPublicId, row.displayName, JSON.stringify(row.answers)],
  );
}

export type SessionQuestionnaireDbRow = {
  session_id: string;
  participant_public_id: string;
  display_name: string;
  answers: unknown;
  submitted_at: Date | string;
};

export async function listSessionQuestionnaires(sessionId: string): Promise<SessionQuestionnaireDbRow[]> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT session_id, participant_public_id, display_name, answers, submitted_at
     FROM session_questionnaire_responses
     WHERE session_id = $1
     ORDER BY submitted_at ASC`,
    [sessionId],
  );
  return r.rows as SessionQuestionnaireDbRow[];
}

export type ArchivedChatRowWithSession = ArchivedChatFull & {
  session_id?: string | null;
  p1_participant_public_id?: string | null;
  p2_participant_public_id?: string | null;
};

export async function listArchivedChatsBySession(
  sessionId: string,
  opts?: { labelCandidates?: string[] },
): Promise<ArchivedChatRowWithSession[]> {
  if (!pool) return [];
  const labels = [...new Set((opts?.labelCandidates ?? []).map((s) => s.trim()).filter(Boolean))];
  const r = await pool.query(
    `SELECT id, room_id, treatment, label, archived_at, messages,
            p1_voluntary_exit_ms, p2_voluntary_exit_ms,
            p1_connected_at_archive, p2_connected_at_archive,
            session_id, p1_participant_public_id, p2_participant_public_id
     FROM archived_chats
     WHERE session_id = $1
        OR (
          cardinality($2::text[]) > 0
          AND TRIM(COALESCE(label, '')) = ANY($2::text[])
        )
     ORDER BY archived_at ASC`,
    [sessionId, labels],
  );
  return r.rows as ArchivedChatRowWithSession[];
}

export type SessionExitSurveyRow = {
  session_id: string;
  participant_public_id: string;
  display_name: string;
  age: string;
  work: string;
  feedback: string;
  submitted_at: Date | string;
};

export async function upsertSessionExitSurvey(row: {
  sessionId: string;
  participantPublicId: string;
  displayName: string;
  age: string;
  work: string;
  feedback: string;
}): Promise<void> {
  if (!pool) throw new Error("Database not initialized");
  await pool.query(
    `INSERT INTO session_exit_surveys (session_id, participant_public_id, display_name, age, work, feedback)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id, participant_public_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, age = EXCLUDED.age, work = EXCLUDED.work,
                   feedback = EXCLUDED.feedback, submitted_at = NOW()`,
    [row.sessionId, row.participantPublicId, row.displayName, row.age, row.work, row.feedback],
  );
}

export async function listSessionExitSurveys(sessionId: string): Promise<SessionExitSurveyRow[]> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT session_id, participant_public_id, display_name, age, work, feedback, submitted_at
     FROM session_exit_surveys
     WHERE session_id = $1
     ORDER BY submitted_at ASC`,
    [sessionId],
  );
  return r.rows as SessionExitSurveyRow[];
}

export type CollectedSessionSummaryRow = {
  id: number;
  session_id: string;
  session_label: string | null;
  saved_at: Date | string;
  participant_count: number;
  group_count: number;
};

export async function insertCollectedSession(row: {
  sessionId: string;
  sessionLabel: string | null;
  snapshot: unknown;
}): Promise<number> {
  if (!pool) throw new Error("Database not initialized");
  const r = await pool.query<{ id: number }>(
    `INSERT INTO collected_sessions (session_id, session_label, snapshot)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [row.sessionId, row.sessionLabel ?? null, JSON.stringify(row.snapshot)],
  );
  return r.rows[0]?.id ?? 0;
}

export async function listCollectedSessionSummaries(limit = 150): Promise<CollectedSessionSummaryRow[]> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT id, session_id, session_label, saved_at,
            COALESCE(jsonb_array_length(COALESCE(snapshot->'participants', '[]'::jsonb)), 0)::int AS participant_count,
            COALESCE(jsonb_array_length(COALESCE(snapshot->'groups', '[]'::jsonb)), 0)::int AS group_count
     FROM collected_sessions
     ORDER BY saved_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows as CollectedSessionSummaryRow[];
}

export type CollectedSessionFullRow = {
  id: number;
  session_id: string;
  session_label: string | null;
  saved_at: Date | string;
  snapshot: unknown;
};

export async function getCollectedSessionById(id: number): Promise<CollectedSessionFullRow | null> {
  if (!pool || !Number.isFinite(id) || id < 1) return null;
  const r = await pool.query(
    `SELECT id, session_id, session_label, saved_at, snapshot
     FROM collected_sessions WHERE id = $1`,
    [id],
  );
  const row = r.rows[0] as CollectedSessionFullRow | undefined;
  return row ?? null;
}
