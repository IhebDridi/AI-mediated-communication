import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __envDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.join(__envDir, "../.env"),
  override: true,
});
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server, type Socket } from "socket.io";
import { nanoid } from "nanoid";
import {
  type ChatMessage,
  type Room,
  LLM_TAG,
  stripLlmTag,
  scheduleRoomLlm,
  handleTaggedLlm,
  ASSISTANT_LABEL,
} from "./llmWatch.js";
import {
  initDb,
  insertArchivedChat,
  isDbConfigured,
  listArchivedChats,
  getArchivedChatById,
  upsertSessionQuestionnaire,
  listSessionQuestionnaires,
  upsertSessionExitSurvey,
  listSessionExitSurveys,
  listArchivedChatsBySession,
  insertCollectedSession,
  listCollectedSessionSummaries,
  getCollectedSessionById,
} from "./db.js";
import {
  getStaticQuestionnaire,
  questionFromPool,
  STATIC_QUESTION_IDS,
  STATIC_QUESTIONNAIRE,
} from "./questionnairePool.js";

const __dirname = __envDir;

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const ADMIN_SECRET = process.env.ADMIN_SECRET?.trim() || "";
let adminSecretMissingLogged = false;

type Treatment = "human_only" | "llm_enabled";
type ParticipantSlot = "p1" | "p2";
type PairingMode = "normal" | "region";

const rooms = new Map<string, Room>();

/**
 * Admin-created pairing session: one participant link (?session=…); FIFO pairing into dyadic chat rooms
 * after the researcher starts matching. Random treatment per pair.
 */
type MatchTicketEntry = {
  createdAt: number;
  sessionId: string;
  displayName: string;
  roomId?: string;
  treatment?: Treatment;
  participantPublicId?: string;
  region?: string;
};

type PairingSession = {
  label?: string;
  createdAt: number;
  pairingEnabled: boolean;
  pairingMode: PairingMode;
  queue: string[];
};

const pairingSessions = new Map<string, PairingSession>();
const matchTickets = new Map<string, MatchTicketEntry>();
const MATCH_TICKET_TTL_MS = 30 * 60 * 1000;

const PRESENCE_PHASES = new Set([
  "intro",
  "questions",
  "instructions",
  "queue",
  "chat",
  "after_chat",
  "thank_you",
]);
const PRESENCE_PRUNE_MS = 10 * 60 * 1000;

type SessionPresenceRow = {
  displayName: string;
  phase: string;
  matchTicket: string | null;
  region: string | null;
  updatedAt: number;
};

/** Key: `${sessionId}:${participantPublicId}` — last-known UI step for admin dashboard. */
const sessionPresence = new Map<string, SessionPresenceRow>();

function sessionPresenceKey(sessionId: string, participantPublicId: string) {
  return `${sessionId}:${participantPublicId}`;
}

function pruneStaleSessionPresence() {
  const now = Date.now();
  for (const [k, v] of sessionPresence) {
    if (now - v.updatedAt > PRESENCE_PRUNE_MS) sessionPresence.delete(k);
  }
}

function cleanupStaleMatchTickets() {
  const now = Date.now();
  for (const [ticket, entry] of matchTickets) {
    if (entry.roomId) continue;
    if (now - entry.createdAt <= MATCH_TICKET_TTL_MS) continue;
    matchTickets.delete(ticket);
    const sess = pairingSessions.get(entry.sessionId);
    if (sess) {
      const i = sess.queue.indexOf(ticket);
      if (i >= 0) sess.queue.splice(i, 1);
    }
  }
}

/** Distinct participants tied to this pairing session (presence, queue, and active paired rooms). */
function countPairingSessionParticipants(sessionId: string, s: PairingSession): number {
  pruneStaleSessionPresence();
  const seen = new Set<string>();
  const prefix = `${sessionId}:`;
  for (const key of sessionPresence.keys()) {
    if (!key.startsWith(prefix)) continue;
    const pid = key.slice(prefix.length);
    if (pid) seen.add(pid);
  }
  for (const ticket of s.queue) {
    const e = matchTickets.get(ticket);
    const pp = e?.participantPublicId?.trim();
    if (pp) seen.add(pp);
    else seen.add(`ticket:${ticket}`);
  }
  for (const [, room] of rooms) {
    const sid = (room.sessionId ?? "").trim().toLowerCase();
    if (sid !== sessionId) continue;
    const pids = room.participantPublicIds ?? {};
    if (pids.p1?.trim()) seen.add(pids.p1.trim());
    if (pids.p2?.trim()) seen.add(pids.p2.trim());
  }
  return seen.size;
}

function pairingSessionRow(sessionId: string, s: PairingSession) {
  const waitingParticipants = s.queue.map((ticket) => {
    const e = matchTickets.get(ticket);
    return {
      displayName: e?.displayName ?? "(unknown)",
      waitingSince: e?.createdAt ?? 0,
      ticket,
      participantPublicId: e?.participantPublicId?.trim() || null,
      region: e?.region?.trim() || null,
    };
  });
  return {
    sessionId,
    label: s.label ?? null,
    pairingEnabled: s.pairingEnabled,
    pairingMode: s.pairingMode,
    waitingCount: s.queue.length,
    waitingParticipants,
    participantCount: countPairingSessionParticipants(sessionId, s),
    createdAt: s.createdAt,
  };
}

const DISPLAY_NAME_MAX = 80;

/** Labels used on pairing-session rooms (`Session <id>` or custom admin label) for DB fallback when `session_id` was missing on older rows. */
function archiveLabelCandidatesForSession(sessionId: string, customLabel?: string | null): string[] {
  return [...new Set([customLabel?.trim(), `Session ${sessionId}`].filter((x): x is string => Boolean(x)))];
}

function normalizeDisplayName(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > DISPLAY_NAME_MAX) return null;
  return s;
}

function normalizeRegion(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 64) return null;
  return s;
}

function regionKey(region: string | null | undefined): string {
  return (region ?? "").trim().toLowerCase() || "unknown";
}

function roomCode(): string {
  const part = () => nanoid(4).toLowerCase();
  return `${part()}-${part()}`;
}

function getOrCreateRoom(
  roomId: string,
  treatment: Treatment,
  opts?: { label?: string; sessionId?: string },
): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      treatment,
      messages: [],
      slots: {},
      llmTail: Promise.resolve(),
      voluntaryExit: {},
      ...(opts?.label ? { label: opts.label } : {}),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    };
    rooms.set(roomId, room);
  }
  return room;
}

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ADMIN_SECRET) {
    if (!adminSecretMissingLogged) {
      adminSecretMissingLogged = true;
      console.warn("ADMIN_SECRET is not set: admin API is open (set ADMIN_SECRET for production).");
    }
    return next();
  }
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerSecret = (req.headers["x-admin-secret"] as string | undefined)?.trim() || "";
  if (bearer === ADMIN_SECRET || headerSecret === ADMIN_SECRET) {
    return next();
  }
  res.status(401).json({ error: "unauthorized" });
}

function assignSlot(room: Room, socketId: string): ParticipantSlot | null {
  if (!room.slots.p1) {
    room.slots.p1 = socketId;
    return "p1";
  }
  if (!room.slots.p2) {
    room.slots.p2 = socketId;
    return "p2";
  }
  return null;
}

/** Release socket slot but keep room (and messages) until admin collects to PostgreSQL. */
function releaseSlot(roomId: string, socketId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.slots.p1 === socketId) delete room.slots.p1;
  if (room.slots.p2 === socketId) delete room.slots.p2;
}

function findRoomIdBySocket(socketId: string): string | undefined {
  for (const [id, room] of rooms) {
    if (room.slots.p1 === socketId || room.slots.p2 === socketId) return id;
  }
  return undefined;
}

function roomToAdminRow(roomId: string, room: Room) {
  const p1Active = !!room.slots.p1;
  const p2Active = !!room.slots.p2;
  const names = room.participantNames ?? {};
  return {
    roomId,
    treatment: room.treatment,
    label: room.label ?? null,
    sessionId: room.sessionId ?? null,
    occupantCount: (p1Active ? 1 : 0) + (p2Active ? 1 : 0),
    messageCount: room.messages.length,
    p1Active,
    p2Active,
    p1DisplayName: names.p1 ?? null,
    p2DisplayName: names.p2 ?? null,
    p1VoluntaryExitAt: room.voluntaryExit.p1 ?? null,
    p2VoluntaryExitAt: room.voluntaryExit.p2 ?? null,
  };
}

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());

app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId.toLowerCase());
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  res.json({
    occupantCount: (room.slots.p1 ? 1 : 0) + (room.slots.p2 ? 1 : 0),
  });
});

app.get("/api/sessions/:sessionId", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const s = pairingSessions.get(sessionId);
  if (!s) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ pairingEnabled: s.pairingEnabled, pairingMode: s.pairingMode });
});

const PARTICIPANT_PUBLIC_ID_MAX = 64;
const ANSWER_MAX_LEN = 2000;

function normalizeParticipantPublicId(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > PARTICIPANT_PUBLIC_ID_MAX) return null;
  return s;
}

app.post("/api/sessions/:sessionId/presence", async (req, res) => {
  pruneStaleSessionPresence();
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(400).json({ error: "missing session" });
    return;
  }
  const sessionOk =
    pairingSessions.has(sessionId) || (isDbConfigured() && (await sessionHasAnyRecord(sessionId)));
  if (!sessionOk) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const participantPublicId = normalizeParticipantPublicId(req.body?.participantPublicId);
  if (!participantPublicId) {
    res.status(400).json({ error: "participantPublicId is required" });
    return;
  }
  const phaseRaw = typeof req.body?.phase === "string" ? req.body.phase.trim() : "";
  if (!PRESENCE_PHASES.has(phaseRaw)) {
    res.status(400).json({ error: "invalid phase" });
    return;
  }
  const incomingName = normalizeDisplayName(req.body?.displayName);
  const incomingRegion = normalizeRegion(req.body?.region);
  const matchTicketRaw = typeof req.body?.matchTicket === "string" ? req.body.matchTicket.trim() : "";
  const matchTicket = matchTicketRaw || null;
  const key = sessionPresenceKey(sessionId, participantPublicId);
  const prev = sessionPresence.get(key);
  sessionPresence.set(key, {
    displayName: incomingName ?? prev?.displayName ?? "",
    phase: phaseRaw,
    matchTicket: matchTicket ?? prev?.matchTicket ?? null,
    region: incomingRegion ?? prev?.region ?? null,
    updatedAt: Date.now(),
  });
  res.json({ ok: true });
});

app.get("/api/sessions/:sessionId/questionnaire", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId || !pairingSessions.has(sessionId)) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({ questions: getStaticQuestionnaire() });
});

app.post("/api/sessions/:sessionId/questionnaire", async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured. Questionnaires cannot be saved." });
    return;
  }
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId || !pairingSessions.has(sessionId)) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const participantPublicId = normalizeParticipantPublicId(req.body?.participantPublicId);
  if (!participantPublicId) {
    res.status(400).json({ error: "participantPublicId is required" });
    return;
  }
  const displayName = normalizeDisplayName(req.body?.displayName);
  if (!displayName) {
    res.status(400).json({ error: `displayName is required (1–${DISPLAY_NAME_MAX} characters)` });
    return;
  }
  const answersRaw = req.body?.answers;
  if (!answersRaw || typeof answersRaw !== "object" || Array.isArray(answersRaw)) {
    res.status(400).json({ error: "answers must be an object keyed by question id" });
    return;
  }
  const o = answersRaw as Record<string, unknown>;
  const rows: { questionId: string; prompt: string; answer: string }[] = [];
  for (const qid of STATIC_QUESTION_IDS) {
    const v = o[qid];
    if (typeof v !== "string") {
      res.status(400).json({ error: "missing answer for a question" });
      return;
    }
    const ans = v.trim();
    if (!ans) {
      res.status(400).json({ error: "empty answer" });
      return;
    }
    if (ans.length > ANSWER_MAX_LEN) {
      res.status(400).json({ error: "answer too long" });
      return;
    }
    const q = questionFromPool(qid);
    if (!q) {
      res.status(400).json({ error: "invalid question set" });
      return;
    }
    if (q.options && !q.options.includes(ans)) {
      res.status(400).json({ error: "invalid option for a question" });
      return;
    }
    rows.push({ questionId: qid, prompt: q.prompt, answer: ans });
  }
  for (const k of Object.keys(o)) {
    if (!STATIC_QUESTION_IDS.includes(k)) {
      res.status(400).json({ error: "unexpected answer key" });
      return;
    }
  }
  try {
    await upsertSessionQuestionnaire({
      sessionId,
      participantPublicId,
      displayName,
      answers: rows,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("questionnaire save", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "save failed" });
  }
});

const EXIT_FIELD_MAX = 2000;

async function sessionHasAnyRecord(sessionId: string): Promise<boolean> {
  if (pairingSessions.has(sessionId)) return true;
  if (!isDbConfigured()) return false;
  const labelCandidates = archiveLabelCandidatesForSession(sessionId, pairingSessions.get(sessionId)?.label);
  const [q, a, e] = await Promise.all([
    listSessionQuestionnaires(sessionId),
    listArchivedChatsBySession(sessionId, { labelCandidates }),
    listSessionExitSurveys(sessionId),
  ]);
  return q.length > 0 || a.length > 0 || e.length > 0;
}

app.post("/api/sessions/:sessionId/exit-survey", async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(400).json({ error: "missing session" });
    return;
  }
  if (!(await sessionHasAnyRecord(sessionId))) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const participantPublicId = normalizeParticipantPublicId(req.body?.participantPublicId);
  if (!participantPublicId) {
    res.status(400).json({ error: "participantPublicId is required" });
    return;
  }
  const displayName = normalizeDisplayName(req.body?.displayName);
  if (!displayName) {
    res.status(400).json({ error: `displayName is required (1–${DISPLAY_NAME_MAX} characters)` });
    return;
  }
  const age = typeof req.body?.age === "string" ? req.body.age.trim() : "";
  const work = typeof req.body?.work === "string" ? req.body.work.trim() : "";
  const feedbackRaw = typeof req.body?.feedback === "string" ? req.body.feedback.trim() : "";
  if (!age || !work) {
    res.status(400).json({ error: "age and work are required" });
    return;
  }
  const feedback = feedbackRaw || "(none)";
  if (age.length > 64 || work.length > EXIT_FIELD_MAX || feedback.length > EXIT_FIELD_MAX) {
    res.status(400).json({ error: "field too long" });
    return;
  }
  try {
    await upsertSessionExitSurvey({
      sessionId,
      participantPublicId,
      displayName,
      age,
      work,
      feedback,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("exit survey", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "save failed" });
  }
});

app.post("/api/match/enqueue", (req, res) => {
  cleanupStaleMatchTickets();
  const sessionId = String(req.body?.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  const session = pairingSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  if (!session.pairingEnabled) {
    res.status(403).json({ error: "pairing has not started yet" });
    return;
  }

  const displayName = normalizeDisplayName(req.body?.displayName);
  if (!displayName) {
    res.status(400).json({ error: `displayName is required (1–${DISPLAY_NAME_MAX} characters)` });
    return;
  }

  const participantPublicId = normalizeParticipantPublicId(req.body?.participantPublicId);
  const region = normalizeRegion(req.body?.region);

  const ticket = nanoid(16);
  matchTickets.set(ticket, {
    createdAt: Date.now(),
    sessionId,
    displayName,
    ...(region ? { region } : {}),
    ...(participantPublicId ? { participantPublicId } : {}),
  });

  const roomLabelBase = session.label?.trim() || `Session ${sessionId}`;

  const myRegionKey = regionKey(region);
  const peerIndex = session.queue.findIndex((peerTicket) => {
    const peer = matchTickets.get(peerTicket);
    if (!peer || peer.roomId || peer.sessionId !== sessionId) return false;
    if (session.pairingMode === "normal") return true;
    return regionKey(peer.region) === myRegionKey;
  });
  if (peerIndex >= 0) {
    const [peerTicket] = session.queue.splice(peerIndex, 1);
    const peer = matchTickets.get(peerTicket);
    if (!peer || peer.roomId || peer.sessionId !== sessionId) {
      session.queue.push(ticket);
      res.json({ ticket, matched: false });
      return;
    }

    const roomId = roomCode();
    const treatment: Treatment = Math.random() < 0.5 ? "human_only" : "llm_enabled";
    getOrCreateRoom(roomId, treatment, { label: roomLabelBase, sessionId });

    peer.roomId = roomId;
    peer.treatment = treatment;
    const mine = matchTickets.get(ticket)!;
    mine.roomId = roomId;
    mine.treatment = treatment;

    res.json({
      ticket,
      matched: true,
      roomId,
      treatment,
    });
    return;
  }

  session.queue.push(ticket);
  res.json({ ticket, matched: false });
});

app.get("/api/match/status", (req, res) => {
  cleanupStaleMatchTickets();
  const ticket = String(req.query.ticket || "").trim();
  if (!ticket || !matchTickets.has(ticket)) {
    res.status(404).json({ error: "unknown ticket" });
    return;
  }
  const entry = matchTickets.get(ticket)!;
  if (entry.roomId) {
    res.json({
      matched: true,
      roomId: entry.roomId,
      treatment: entry.treatment,
    });
    return;
  }
  res.json({ matched: false });
});

app.post("/api/admin/sessions", adminAuth, (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label.trim() || undefined : undefined;
  const sessionId = roomCode();
  pairingSessions.set(sessionId, {
    label,
    createdAt: Date.now(),
    pairingEnabled: false,
    pairingMode: "normal",
    queue: [],
  });
  res.json({ sessionId, label: label ?? null, pairingEnabled: false, pairingMode: "normal" });
});

app.get("/api/admin/sessions", adminAuth, (_req, res) => {
  const sessions = [...pairingSessions.entries()].map(([id, s]) => pairingSessionRow(id, s));
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ sessions });
});

app.post("/api/admin/sessions/:sessionId/start-pairing", adminAuth, (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  const s = pairingSessions.get(sessionId);
  if (!s) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const modeRaw = typeof req.body?.pairingMode === "string" ? req.body.pairingMode.trim() : "";
  const pairingMode: PairingMode = modeRaw === "region" ? "region" : "normal";
  s.pairingMode = pairingMode;
  s.pairingEnabled = true;
  res.json({ ok: true, sessionId, pairingEnabled: true, pairingMode });
});

app.post("/api/admin/rooms", adminAuth, (req, res) => {
  const treatment = req.body?.treatment as Treatment | undefined;
  if (treatment !== "human_only" && treatment !== "llm_enabled") {
    res.status(400).json({ error: "treatment must be human_only or llm_enabled" });
    return;
  }
  const label = typeof req.body?.label === "string" ? req.body.label.trim() || undefined : undefined;
  const roomId = roomCode();
  getOrCreateRoom(roomId, treatment, { label });
  res.json({ roomId, treatment, label: label ?? null });
});

app.get("/api/admin/rooms", adminAuth, (_req, res) => {
  const list = [...rooms.entries()].map(([roomId, room]) => roomToAdminRow(roomId, room));
  res.json({ rooms: list, dbConfigured: isDbConfigured() });
});

const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist) && fs.existsSync(path.join(clientDist, "index.html"))) {
  const spaIndex = path.join(clientDist, "index.html");
  const sendSpa = (_req: express.Request, res: express.Response) => {
    res.sendFile(spaIndex);
  };
  app.use(express.static(clientDist, { index: false }));
  app.get("/", sendSpa);
  app.get(/^\/admin(\/.*)?$/i, sendSpa);
  app.get(/^\/study(\/.*)?$/i, sendSpa);
  app.get(/^\/thankyou\/?$/i, sendSpa);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
});

app.post("/api/admin/rooms/:roomId/collect", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured. Add Clever PostgreSQL add-on or DATABASE_URL." });
    return;
  }
  const roomId = req.params.roomId?.trim().toLowerCase();
  if (!roomId) {
    res.status(400).json({ error: "missing roomId" });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }

  try {
    const pids = room.participantPublicIds ?? {};
    const archiveId = await insertArchivedChat({
      roomId,
      treatment: room.treatment,
      label: room.label ?? null,
      messages: room.messages,
      p1VoluntaryExitMs: room.voluntaryExit.p1 ?? null,
      p2VoluntaryExitMs: room.voluntaryExit.p2 ?? null,
      p1Connected: !!room.slots.p1,
      p2Connected: !!room.slots.p2,
      sessionId: room.sessionId ?? null,
      p1ParticipantPublicId: pids.p1 ?? null,
      p2ParticipantPublicId: pids.p2 ?? null,
    });

    io.in(roomId).disconnectSockets(true);
    rooms.delete(roomId);

    res.json({ ok: true, archiveId });
  } catch (e) {
    console.error("collect chat", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "archive failed" });
  }
});

app.get("/api/admin/archives", adminAuth, async (_req, res) => {
  if (!isDbConfigured()) {
    res.json({ archives: [], dbConfigured: false });
    return;
  }
  try {
    const archives = await listArchivedChats(100);
    res.json({ archives, dbConfigured: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "list failed" });
  }
});

function csvEscapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

app.get("/api/admin/sessions/:sessionId/questionnaire.csv", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).send("Database not configured");
    return;
  }
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(400).send("Missing session id");
    return;
  }
  try {
    const dbRows = await listSessionQuestionnaires(sessionId);
    const header = [
      "session_id",
      "participant_public_id",
      "display_name",
      "submitted_at_iso",
      "question_id",
      "question_prompt",
      "answer",
    ];
    const lines = [header.map(csvEscapeCell).join(",")];
    const submittedIso = (d: Date | string) => {
      try {
        return new Date(d).toISOString();
      } catch {
        return "";
      }
    };
    for (const row of dbRows) {
      const answers = Array.isArray(row.answers)
        ? (row.answers as Array<{ questionId?: string; prompt?: string; answer?: string }>)
        : [];
      const iso = submittedIso(row.submitted_at);
      if (answers.length === 0) {
        lines.push(
          [row.session_id, row.participant_public_id, row.display_name, iso, "", "", ""]
            .map((c) => csvEscapeCell(String(c)))
            .join(","),
        );
        continue;
      }
      for (const a of answers) {
        lines.push(
          [
            row.session_id,
            row.participant_public_id,
            row.display_name,
            iso,
            a.questionId ?? "",
            a.prompt ?? "",
            a.answer ?? "",
          ]
            .map((c) => csvEscapeCell(String(c)))
            .join(","),
        );
      }
    }
    const body = "\uFEFF" + lines.join("\r\n");
    const safeFile = `margarita-session-${sessionId}-questionnaires.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"`);
    res.send(body);
  } catch (e) {
    console.error("questionnaire csv", e);
    res.status(500).send(e instanceof Error ? e.message : "export failed");
  }
});

function archivedMessagesForCsv(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    out.push({
      id: typeof o.id === "string" ? o.id : "",
      slot: o.slot === "p1" || o.slot === "p2" || o.slot === "llm" ? o.slot : "p1",
      authorLabel: typeof o.authorLabel === "string" ? o.authorLabel : "",
      text: o.text,
      ts: typeof o.ts === "number" ? o.ts : 0,
    });
  }
  return out;
}

function formatChatTranscript(messages: unknown): string {
  const msgs = archivedMessagesForCsv(messages);
  return msgs
    .map((m) => {
      const iso = m.ts ? new Date(m.ts).toISOString() : "";
      return `[${iso}] ${m.authorLabel}: ${m.text}`;
    })
    .join("\n\n");
}

function firstAuthorForSlot(messages: unknown, slot: "p1" | "p2"): string {
  const msgs = archivedMessagesForCsv(messages);
  const m = msgs.find((x) => x.slot === slot);
  return m?.authorLabel ?? "";
}

function answersArrayToMap(answers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(answers)) return out;
  for (const a of answers) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.questionId === "string" && typeof o.answer === "string") {
      out[o.questionId] = o.answer;
    }
  }
  return out;
}

type SessionExportParticipant = {
  participantPublicId: string;
  displayName: string;
  pairedWith: string | null;
  roomId: string | null;
  archiveId: number | null;
  q1: string;
  q2: string;
  q3: string;
  q4: string;
  q5: string;
  age: string | null;
  work: string | null;
  feedback: string | null;
  chat: string | null;
};

async function buildSessionExportPayload(sessionId: string) {
  const sess = pairingSessions.get(sessionId);
  const questionPrompts: Record<string, string> = {};
  for (const q of STATIC_QUESTIONNAIRE) {
    questionPrompts[q.id] = q.prompt;
  }

  const labelCandidates = archiveLabelCandidatesForSession(sessionId, sess?.label);
  const questionnaires = await listSessionQuestionnaires(sessionId);
  const exits = await listSessionExitSurveys(sessionId);
  const archives = await listArchivedChatsBySession(sessionId, { labelCandidates });

  let sessionLabel = sess?.label ?? null;
  if (!sessionLabel && archives.length > 0) {
    const labs = new Set(
      archives.map((a) => (typeof a.label === "string" ? a.label.trim() : "")).filter(Boolean),
    );
    if (labs.size === 1) sessionLabel = [...labs][0] ?? null;
  }

  function emptyPart(pid: string, name: string): SessionExportParticipant {
    return {
      participantPublicId: pid,
      displayName: name,
      pairedWith: null,
      roomId: null,
      archiveId: null,
      q1: "",
      q2: "",
      q3: "",
      q4: "",
      q5: "",
      age: null,
      work: null,
      feedback: null,
      chat: null,
    };
  }

  const byPid = new Map<string, SessionExportParticipant>();

  function ensure(pid: string, name: string): SessionExportParticipant {
    let p = byPid.get(pid);
    if (!p) {
      p = emptyPart(pid, name);
      byPid.set(pid, p);
    }
    if (name.trim()) p.displayName = name;
    return p;
  }

  function findPidByDisplayName(name: string): string | null {
    const n = name.trim().toLowerCase();
    const row = questionnaires.find((x) => x.display_name.trim().toLowerCase() === n);
    return row?.participant_public_id ?? null;
  }

  function mergeChatIntoParticipants(
    roomId: string,
    archiveId: number | null,
    messages: unknown,
    p1PidHint?: string | null,
    p2PidHint?: string | null,
    fallbackNames?: Partial<Record<ParticipantSlot, string>>,
  ) {
    const transcript = formatChatTranscript(messages);
    let p1Pid = p1PidHint?.trim() || null;
    let p2Pid = p2PidHint?.trim() || null;
    const p1Name =
      firstAuthorForSlot(messages, "p1") || (fallbackNames?.p1 ? String(fallbackNames.p1).trim() : "");
    const p2Name =
      firstAuthorForSlot(messages, "p2") || (fallbackNames?.p2 ? String(fallbackNames.p2).trim() : "");
    if (!p1Pid && p1Name) p1Pid = findPidByDisplayName(p1Name);
    if (!p2Pid && p2Name) p2Pid = findPidByDisplayName(p2Name);

    if (p1Pid) {
      const p = ensure(p1Pid, p1Name || "Participant 1");
      p.pairedWith = p2Name || null;
      p.roomId = roomId;
      p.archiveId = archiveId;
      p.chat = transcript;
    }
    if (p2Pid) {
      const p = ensure(p2Pid, p2Name || "Participant 2");
      p.pairedWith = p1Name || null;
      p.roomId = roomId;
      p.archiveId = archiveId;
      p.chat = transcript;
    }
  }

  for (const q of questionnaires) {
    const p = ensure(q.participant_public_id, q.display_name);
    const amap = answersArrayToMap(q.answers);
    p.q1 = amap.q1 ?? "";
    p.q2 = amap.q2 ?? "";
    p.q3 = amap.q3 ?? "";
    p.q4 = amap.q4 ?? "";
    p.q5 = amap.q5 ?? "";
  }

  for (const ex of exits) {
    const p = ensure(ex.participant_public_id, ex.display_name);
    p.age = ex.age;
    p.work = ex.work;
    p.feedback = ex.feedback;
  }

  for (const arch of archives) {
    mergeChatIntoParticipants(
      arch.room_id,
      arch.id,
      arch.messages,
      arch.p1_participant_public_id,
      arch.p2_participant_public_id,
    );
  }

  for (const [roomId, room] of rooms) {
    const sid = (room.sessionId ?? "").trim().toLowerCase();
    if (sid !== sessionId) continue;
    const pids = room.participantPublicIds ?? {};
    mergeChatIntoParticipants(roomId, null, room.messages, pids.p1 ?? null, pids.p2 ?? null, room.participantNames);
  }

  return {
    sessionId,
    sessionLabel,
    exportedAt: new Date().toISOString(),
    questionPrompts,
    participants: [...byPid.values()],
  };
}

const PRESENCE_STALE_MS = 45_000;

async function buildSessionAdminDetail(sessionId: string) {
  pruneStaleSessionPresence();
  const sess = pairingSessions.get(sessionId);
  const now = Date.now();

  const questionPrompts: Record<string, string> = {};
  for (const q of STATIC_QUESTIONNAIRE) {
    questionPrompts[q.id] = q.prompt;
  }

  const labelCandidates = archiveLabelCandidatesForSession(sessionId, sess?.label);
  const questionnaires = isDbConfigured() ? await listSessionQuestionnaires(sessionId) : [];
  const exits = isDbConfigured() ? await listSessionExitSurveys(sessionId) : [];
  const archives = isDbConfigured() ? await listArchivedChatsBySession(sessionId, { labelCandidates }) : [];

  let sessionLabel = sess?.label ?? null;
  if (!sessionLabel && archives.length > 0) {
    const labs = new Set(
      archives.map((a) => (typeof a.label === "string" ? a.label.trim() : "")).filter(Boolean),
    );
    if (labs.size === 1) sessionLabel = [...labs][0] ?? null;
  }

  type AdminDetailPart = {
    participantPublicId: string | null;
    displayName: string;
    phase: string | null;
    lastSeenMs: number | null;
    presenceStale: boolean;
    waitingForPair: boolean;
    matchTicket: string | null;
    region: string | null;
    roomId: string | null;
    slot: ParticipantSlot | null;
    socketConnected: boolean;
    questionnaire: Record<string, string>;
    exitSurvey: { age: string; work: string; feedback: string } | null;
    liveChatMessages: ReturnType<typeof archivedMessagesForCsv>;
    archivedChats: Array<{
      archiveId: number;
      roomId: string;
      messageCount: number;
      transcript: string;
      messages: ReturnType<typeof archivedMessagesForCsv>;
    }>;
  };

  const byPid = new Map<string, AdminDetailPart>();

  function emptyPart(pid: string | null, name: string): AdminDetailPart {
    return {
      participantPublicId: pid,
      displayName: name,
      phase: null,
      lastSeenMs: null,
      presenceStale: true,
      waitingForPair: false,
      matchTicket: null,
      region: null,
      roomId: null,
      slot: null,
      socketConnected: false,
      questionnaire: {},
      exitSurvey: null,
      liveChatMessages: [],
      archivedChats: [],
    };
  }

  function ensurePid(pid: string, name = ""): AdminDetailPart {
    let p = byPid.get(pid);
    if (!p) {
      p = emptyPart(pid, name);
      byPid.set(pid, p);
    }
    if (name.trim()) p.displayName = name;
    return p;
  }

  for (const q of questionnaires) {
    const p = ensurePid(q.participant_public_id, q.display_name);
    p.questionnaire = answersArrayToMap(q.answers);
  }
  for (const ex of exits) {
    const p = ensurePid(ex.participant_public_id, ex.display_name);
    p.exitSurvey = { age: ex.age, work: ex.work, feedback: ex.feedback };
  }

  const prefix = `${sessionId}:`;
  for (const [key, pr] of sessionPresence) {
    if (!key.startsWith(prefix)) continue;
    const pid = key.slice(prefix.length);
    if (!pid) continue;
    const p = ensurePid(pid, pr.displayName);
    if (pr.displayName.trim()) p.displayName = pr.displayName;
    p.phase = pr.phase;
    p.lastSeenMs = pr.updatedAt;
    p.presenceStale = now - pr.updatedAt > PRESENCE_STALE_MS;
    if (pr.matchTicket) p.matchTicket = pr.matchTicket;
    if (pr.region?.trim()) p.region = pr.region.trim();
  }

  if (sess) {
    for (const ticket of sess.queue) {
      const e = matchTickets.get(ticket);
      if (!e || e.sessionId !== sessionId || e.roomId) continue;
      const pp = e.participantPublicId?.trim();
      if (pp) {
        const p = ensurePid(pp, e.displayName);
        p.waitingForPair = true;
        p.matchTicket = ticket;
        if (e.region?.trim()) p.region = e.region.trim();
        if (!p.phase || p.phase === "instructions") p.phase = "queue";
      }
    }
  }

  for (const [rid, room] of rooms) {
    if ((room.sessionId ?? "").trim().toLowerCase() !== sessionId) continue;
    const pids = room.participantPublicIds ?? {};
    const names = room.participantNames ?? {};
    for (const slot of ["p1", "p2"] as const) {
      const pid = pids[slot]?.trim();
      if (!pid) continue;
      const p = ensurePid(pid, names[slot] ?? "");
      p.roomId = rid;
      p.slot = slot;
      p.socketConnected = !!room.slots[slot];
      p.liveChatMessages = archivedMessagesForCsv(room.messages);
      if (!p.phase || p.phase === "queue" || p.phase === "instructions") p.phase = "chat";
    }
  }

  for (const arch of archives) {
    const transcript = formatChatTranscript(arch.messages);
    const mc = archivedMessagesForCsv(arch.messages).length;
    for (const pidRaw of [arch.p1_participant_public_id, arch.p2_participant_public_id] as const) {
      const pid = typeof pidRaw === "string" ? pidRaw.trim() : "";
      if (!pid) continue;
      const p = ensurePid(pid, "");
      p.archivedChats.push({
        archiveId: arch.id,
        roomId: arch.room_id,
        messageCount: mc,
        transcript,
        messages: archivedMessagesForCsv(arch.messages),
      });
    }
  }

  const anonymousWaiting: AdminDetailPart[] = [];
  if (sess) {
    for (const ticket of sess.queue) {
      const e = matchTickets.get(ticket);
      if (!e || e.sessionId !== sessionId || e.roomId) continue;
      if (e.participantPublicId?.trim()) continue;
      anonymousWaiting.push({
        ...emptyPart(null, e.displayName),
        waitingForPair: true,
        matchTicket: ticket,
        region: e.region?.trim() || null,
        phase: "queue",
        presenceStale: true,
        lastSeenMs: null,
      });
    }
  }

  type AdminDetailGroup = {
    groupId: string;
    roomId: string;
    archiveId: number | null;
    status: "active" | "archived";
    treatment: string | null;
    p1ParticipantPublicId: string | null;
    p2ParticipantPublicId: string | null;
    p1DisplayName: string;
    p2DisplayName: string;
    messages: ReturnType<typeof archivedMessagesForCsv>;
    transcript: string;
  };

  const groupsByRoom = new Map<string, AdminDetailGroup>();
  for (const [rid, room] of rooms) {
    if ((room.sessionId ?? "").trim().toLowerCase() !== sessionId) continue;
    const pids = room.participantPublicIds ?? {};
    const names = room.participantNames ?? {};
    const p1n = names.p1?.trim() || firstAuthorForSlot(room.messages, "p1") || "—";
    const p2n = names.p2?.trim() || firstAuthorForSlot(room.messages, "p2") || "—";
    groupsByRoom.set(rid, {
      groupId: rid,
      roomId: rid,
      archiveId: null,
      status: "active",
      treatment: room.treatment,
      p1ParticipantPublicId: pids.p1?.trim() || null,
      p2ParticipantPublicId: pids.p2?.trim() || null,
      p1DisplayName: p1n,
      p2DisplayName: p2n,
      messages: archivedMessagesForCsv(room.messages),
      transcript: formatChatTranscript(room.messages),
    });
  }
  for (const arch of archives) {
    const rid = arch.room_id;
    if (groupsByRoom.has(rid)) continue;
    const p1n = firstAuthorForSlot(arch.messages, "p1") || "—";
    const p2n = firstAuthorForSlot(arch.messages, "p2") || "—";
    groupsByRoom.set(rid, {
      groupId: rid,
      roomId: rid,
      archiveId: arch.id,
      status: "archived",
      treatment: arch.treatment,
      p1ParticipantPublicId: arch.p1_participant_public_id?.trim() || null,
      p2ParticipantPublicId: arch.p2_participant_public_id?.trim() || null,
      p1DisplayName: p1n,
      p2DisplayName: p2n,
      messages: archivedMessagesForCsv(arch.messages),
      transcript: formatChatTranscript(arch.messages),
    });
  }
  const groups = [...groupsByRoom.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.roomId.localeCompare(b.roomId);
  });

  return {
    sessionId,
    sessionLabel,
    pairingEnabled: sess?.pairingEnabled ?? false,
    pairingMode: sess?.pairingMode ?? "normal",
    liveSession: !!sess,
    liveHint: sess
      ? null
      : "Server restarted or this session is no longer in memory: live queue, presence, and active chats are unavailable. Saved questionnaire / archive data still appears when the database is configured.",
    questionPrompts,
    participants: [...byPid.values(), ...anonymousWaiting],
    groups,
  };
}

async function buildSessionSnapshotPayload(sessionId: string) {
  const detail = await buildSessionAdminDetail(sessionId);
  const exportPayload = await buildSessionExportPayload(sessionId);
  return {
    version: 2 as const,
    sessionId: detail.sessionId,
    sessionLabel: detail.sessionLabel,
    questionPrompts: detail.questionPrompts,
    participants: detail.participants,
    groups: detail.groups ?? [],
    exportParticipants: exportPayload.participants,
    detailMeta: {
      liveSession: detail.liveSession,
      pairingEnabled: detail.pairingEnabled,
      pairingMode: detail.pairingMode,
      liveHint: detail.liveHint,
    },
  };
}

app.post("/api/admin/sessions/:sessionId/snapshot", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(400).json({ error: "missing session id" });
    return;
  }
  try {
    if (!pairingSessions.has(sessionId) && !(await sessionHasAnyRecord(sessionId))) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const savedAt = new Date().toISOString();
    const core = await buildSessionSnapshotPayload(sessionId);
    const snapshot = { ...core, savedAt };
    const id = await insertCollectedSession({
      sessionId,
      sessionLabel: core.sessionLabel,
      snapshot,
    });
    res.json({ ok: true, id, sessionId, savedAt });
  } catch (e) {
    console.error("session snapshot", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "snapshot failed" });
  }
});

app.get("/api/admin/collected-sessions", adminAuth, async (_req, res) => {
  if (!isDbConfigured()) {
    res.json({ collectedSessions: [], dbConfigured: false });
    return;
  }
  try {
    const rows = await listCollectedSessionSummaries(150);
    const collectedSessions = rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      sessionLabel: r.session_label,
      savedAt: new Date(r.saved_at).toISOString(),
      participantCount: r.participant_count,
      groupCount: r.group_count,
    }));
    res.json({ collectedSessions, dbConfigured: true });
  } catch (e) {
    console.error("list collected sessions", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "list failed" });
  }
});

app.get("/api/admin/collected-sessions/:collectedId", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const id = Number.parseInt(String(req.params.collectedId), 10);
  if (!Number.isFinite(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    const row = await getCollectedSessionById(id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({
      id: row.id,
      sessionId: row.session_id,
      sessionLabel: row.session_label,
      savedAt: new Date(row.saved_at).toISOString(),
      snapshot: row.snapshot,
    });
  } catch (e) {
    console.error("get collected session", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "get failed" });
  }
});

app.get("/api/admin/collected-sessions/:collectedId/export.json", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const id = Number.parseInt(String(req.params.collectedId), 10);
  if (!Number.isFinite(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    const row = await getCollectedSessionById(id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const snap = row.snapshot as Record<string, unknown>;
    const exportParticipants = snap.exportParticipants;
    const payload = {
      sessionId: row.session_id,
      sessionLabel: row.session_label ?? snap.sessionLabel ?? null,
      exportedAt: new Date(row.saved_at).toISOString(),
      savedSnapshotId: row.id,
      questionPrompts: (snap.questionPrompts as Record<string, string>) ?? {},
      participants: Array.isArray(exportParticipants) ? exportParticipants : [],
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="margarita-collected-session-${row.id}-export.json"`,
    );
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("collected session export", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "export failed" });
  }
});

app.get("/api/admin/sessions/:sessionId/detail", adminAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(400).json({ error: "missing session id" });
    return;
  }
  try {
    if (!pairingSessions.has(sessionId) && !(await sessionHasAnyRecord(sessionId))) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const detail = await buildSessionAdminDetail(sessionId);
    res.json(detail);
  } catch (e) {
    console.error("session detail", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "detail failed" });
  }
});

app.get("/api/admin/sessions/:sessionId/export.json", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const sessionId = String(req.params.sessionId || "").trim().toLowerCase();
  if (!sessionId) {
    res.status(400).json({ error: "missing session id" });
    return;
  }
  try {
    if (!pairingSessions.has(sessionId) && !(await sessionHasAnyRecord(sessionId))) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const payload = await buildSessionExportPayload(sessionId);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="margarita-session-${sessionId}-export.json"`,
    );
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("session export", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "export failed" });
  }
});

app.get("/api/admin/archives/:archiveId/csv", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).send("Database not configured");
    return;
  }
  const id = Number.parseInt(String(req.params.archiveId), 10);
  if (!Number.isFinite(id) || id < 1) {
    res.status(400).send("Invalid archive id");
    return;
  }
  try {
    const row = await getArchivedChatById(id);
    if (!row) {
      res.status(404).send("Not found");
      return;
    }
    const msgs = archivedMessagesForCsv(row.messages);
    const archivedIso = new Date(row.archived_at).toISOString();
    const header = [
      "archive_id",
      "room_id",
      "treatment",
      "label",
      "archived_at",
      "message_index",
      "message_id",
      "slot",
      "author_label",
      "timestamp_ms",
      "timestamp_iso",
      "text",
    ];
    const lines = [header.map(csvEscapeCell).join(",")];
    msgs.forEach((m, i) => {
      const tsIso = m.ts ? new Date(m.ts).toISOString() : "";
      lines.push(
        [
          String(id),
          row.room_id,
          row.treatment,
          row.label ?? "",
          archivedIso,
          String(i),
          m.id,
          m.slot,
          m.authorLabel,
          String(m.ts),
          tsIso,
          m.text,
        ]
          .map((c) => csvEscapeCell(String(c)))
          .join(","),
      );
    });
    const body = "\uFEFF" + lines.join("\r\n");
    const safeFile = `margarita-archive-${id}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"`);
    res.send(body);
  } catch (e) {
    console.error("archive csv", e);
    res.status(500).send(e instanceof Error ? e.message : "export failed");
  }
});

app.get("/api/admin/archives/:archiveId", adminAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const id = Number.parseInt(String(req.params.archiveId), 10);
  if (!Number.isFinite(id) || id < 1) {
    res.status(400).json({ error: "Invalid archive id" });
    return;
  }
  try {
    const archive = await getArchivedChatById(id);
    if (!archive) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ archive });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "load failed" });
  }
});

io.on("connection", (socket: Socket) => {
  socket.on(
    "join",
    async (
      payload: { roomId: string; displayName?: string; participantPublicId?: string },
      ack?: (r: {
        ok: boolean;
        error?: string;
        slot?: ParticipantSlot;
        treatment?: Treatment;
        messages?: ChatMessage[];
        peerConnected?: boolean;
      }) => void,
    ) => {
      const roomId = payload.roomId?.trim().toLowerCase();
      if (!roomId) {
        ack?.({ ok: false, error: "missing roomId" });
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        ack?.({ ok: false, error: "room not found" });
        return;
      }
      const displayName = normalizeDisplayName(payload.displayName);
      if (!displayName) {
        ack?.({
          ok: false,
          error: `Enter your name (1–${DISPLAY_NAME_MAX} characters).`,
        });
        return;
      }
      const hadOtherParticipant =
        (room.slots.p1 !== undefined && room.slots.p1 !== socket.id) ||
        (room.slots.p2 !== undefined && room.slots.p2 !== socket.id);
      const slot = assignSlot(room, socket.id);
      if (!slot) {
        ack?.({ ok: false, error: "room full" });
        return;
      }
      await socket.join(roomId);
      const authorLabel = displayName;
      if (!room.participantNames) room.participantNames = {};
      room.participantNames[slot] = authorLabel;
      const ppid = normalizeParticipantPublicId(payload.participantPublicId);
      if (ppid) {
        if (!room.participantPublicIds) room.participantPublicIds = {};
        room.participantPublicIds[slot] = ppid;
      }
      (socket.data as { roomId: string; slot: ParticipantSlot; authorLabel: string }).roomId = roomId;
      (socket.data as { roomId: string; slot: ParticipantSlot; authorLabel: string }).slot = slot;
      (socket.data as { roomId: string; slot: ParticipantSlot; authorLabel: string }).authorLabel =
        authorLabel;

      ack?.({
        ok: true,
        slot,
        treatment: room.treatment,
        messages: room.messages,
        peerConnected: hadOtherParticipant,
      });
      socket.to(roomId).emit("peer_joined", { slot });
    },
  );

  socket.on("exit_chat", () => {
    const roomId = (socket.data as { roomId?: string }).roomId;
    const slot = (socket.data as { slot?: ParticipantSlot }).slot;
    if (!roomId || (slot !== "p1" && slot !== "p2")) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const ts = Date.now();
    room.voluntaryExit[slot] = ts;
    io.to(roomId).emit("voluntary_exit", { slot, at: ts });
    socket.leave(roomId);
    releaseSlot(roomId, socket.id);
    socket.to(roomId).emit("peer_left", { voluntary: true, slot });
  });

  socket.on("chat_message", async (text: string) => {
    const roomId = (socket.data as { roomId?: string }).roomId;
    const slot = (socket.data as { slot?: ParticipantSlot }).slot;
    const authorLabel = (socket.data as { authorLabel?: string }).authorLabel || "Participant";
    if (!roomId || (slot !== "p1" && slot !== "p2")) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return;

    const msg: ChatMessage = {
      id: nanoid(),
      slot,
      authorLabel,
      text: trimmed,
      ts: Date.now(),
    };
    room.messages.push(msg);
    io.to(roomId).emit("message", msg);

    if (room.treatment !== "llm_enabled") return;

    const wantsLlm = LLM_TAG.test(trimmed);
    if (!wantsLlm) return;

    const rest = stripLlmTag(trimmed);
    if (!rest) {
      const hint: ChatMessage = {
        id: nanoid(),
        slot: "llm",
        authorLabel: ASSISTANT_LABEL,
        text: "What would you like help with? Add your request on the same line after @LLM.",
        ts: Date.now(),
      };
      room.messages.push(hint);
      io.to(roomId).emit("message", hint);
      return;
    }

    scheduleRoomLlm(room, () => handleTaggedLlm(room, io, roomId));
  });

  socket.on("disconnect", () => {
    const roomId = findRoomIdBySocket(socket.id);
    if (!roomId) return;
    io.to(roomId).emit("peer_left", { voluntary: false });
    releaseSlot(roomId, socket.id);
  });
});

async function start() {
  await initDb();
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Listening on 0.0.0.0:${PORT} (CORS / Socket.IO origin: ${CLIENT_ORIGIN})`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
