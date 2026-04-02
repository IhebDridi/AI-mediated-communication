import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server, type Socket } from "socket.io";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  type ChatMessage,
  type Room,
  LLM_TAG,
  stripLlmTag,
  scheduleRoomLlm,
  handleTaggedLlm,
  ASSISTANT_LABEL,
} from "./llmWatch.js";

const PORT = Number(process.env.PORT) || 3001;
/** Public browser origin(s) for CORS + Socket.IO. On Clever Cloud use your https://*.cleverapps.io URL. */
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

function releaseSlot(roomId: string, socketId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.slots.p1 === socketId) delete room.slots.p1;
  if (room.slots.p2 === socketId) delete room.slots.p2;
  if (!room.slots.p1 && !room.slots.p2) {
    rooms.delete(roomId);
  }
}

function findRoomIdBySocket(socketId: string): string | undefined {
  for (const [id, room] of rooms) {
    if (room.slots.p1 === socketId || room.slots.p2 === socketId) return id;
  }
  return undefined;
}

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());

/** Participant polling: occupancy only (no treatment — blinding). */
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
  const list = [...rooms.entries()].map(([roomId, room]) => ({
    roomId,
    treatment: room.treatment,
    label: room.label ?? null,
    occupantCount: (room.slots.p1 ? 1 : 0) + (room.slots.p2 ? 1 : 0),
    messageCount: room.messages.length,
  }));
  res.json({ rooms: list });
});

/** Production: serve Vite build from same host (Clever Cloud single Node app). */
const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist) && fs.existsSync(path.join(clientDist, "index.html"))) {
  const spaIndex = path.join(clientDist, "index.html");
  const sendSpa = (_req: express.Request, res: express.Response) => {
    res.sendFile(spaIndex);
  };
  app.use(express.static(clientDist, { index: false }));
  app.get("/", sendSpa);
  app.get(/^\/admin(\/.*)?$/i, sendSpa);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
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
    io.to(roomId).emit("peer_left", {});
    releaseSlot(roomId, socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on 0.0.0.0:${PORT} (CORS / Socket.IO origin: ${CLIENT_ORIGIN})`);
});
