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
} from "./db.js";

const __dirname = __envDir;

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const ADMIN_SECRET = process.env.ADMIN_SECRET?.trim() || "";

type Treatment = "human_only" | "llm_enabled";
type ParticipantSlot = "p1" | "p2";

const rooms = new Map<string, Room>();

function roomCode(): string {
  const part = () => nanoid(4).toLowerCase();
  return `${part()}-${part()}`;
}

function getOrCreateRoom(roomId: string, treatment: Treatment, label?: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      treatment,
      messages: [],
      slots: {},
      llmTail: Promise.resolve(),
      voluntaryExit: {},
      ...(label ? { label } : {}),
    };
    rooms.set(roomId, room);
  }
  return room;
}

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ADMIN_SECRET) {
    console.warn("ADMIN_SECRET is not set: admin API is open (set ADMIN_SECRET for production).");
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
  return {
    roomId,
    treatment: room.treatment,
    label: room.label ?? null,
    occupantCount: (p1Active ? 1 : 0) + (p2Active ? 1 : 0),
    messageCount: room.messages.length,
    p1Active,
    p2Active,
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

app.post("/api/admin/rooms", adminAuth, (req, res) => {
  const treatment = req.body?.treatment as Treatment | undefined;
  if (treatment !== "human_only" && treatment !== "llm_enabled") {
    res.status(400).json({ error: "treatment must be human_only or llm_enabled" });
    return;
  }
  const label = typeof req.body?.label === "string" ? req.body.label.trim() || undefined : undefined;
  const roomId = roomCode();
  getOrCreateRoom(roomId, treatment, label);
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
    const archiveId = await insertArchivedChat({
      roomId,
      treatment: room.treatment,
      label: room.label ?? null,
      messages: room.messages,
      p1VoluntaryExitMs: room.voluntaryExit.p1 ?? null,
      p2VoluntaryExitMs: room.voluntaryExit.p2 ?? null,
      p1Connected: !!room.slots.p1,
      p2Connected: !!room.slots.p2,
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
      payload: { roomId: string; displayName?: string },
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
      const hadOtherParticipant =
        (room.slots.p1 !== undefined && room.slots.p1 !== socket.id) ||
        (room.slots.p2 !== undefined && room.slots.p2 !== socket.id);
      const slot = assignSlot(room, socket.id);
      if (!slot) {
        ack?.({ ok: false, error: "room full" });
        return;
      }
      await socket.join(roomId);
      const authorLabel =
        payload.displayName?.trim() ||
        (slot === "p1" ? "Participant 1" : "Participant 2");
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
