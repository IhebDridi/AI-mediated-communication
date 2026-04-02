import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import { MessageBody } from "./MessageBody";

type Treatment = "human_only" | "llm_enabled";
type ParticipantSlot = "p1" | "p2";

type ChatMessage = {
  id: string;
  slot: ParticipantSlot | "llm";
  authorLabel: string;
  text: string;
  ts: number;
};

function formatTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

type PreJoinRoomFetch =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; occupantCount: number }
  | { status: "missing" }
  | { status: "error" };

export function ParticipantApp() {
  const [searchParams] = useSearchParams();
  const roomFromUrl = searchParams.get("room")?.trim().toLowerCase() || "";

  const [roomId, setRoomId] = useState(roomFromUrl);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [joined, setJoined] = useState(false);
  const [slot, setSlot] = useState<ParticipantSlot | null>(null);
  const [treatment, setTreatment] = useState<Treatment | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [peerPresent, setPeerPresent] = useState(false);
  const [llmTyping, setLlmTyping] = useState(false);
  const [preJoinRoom, setPreJoinRoom] = useState<PreJoinRoomFetch>({ status: "idle" });

  useEffect(() => {
    if (roomFromUrl) setRoomId(roomFromUrl);
  }, [roomFromUrl]);

  const listRef = useRef<HTMLDivElement | null>(null);

  const socket = useMemo(() => {
    return io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      autoConnect: false,
    });
  }, []);

  useEffect(() => {
    return () => {
      socket.disconnect();
    };
  }, [socket]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, llmTyping]);

  useEffect(() => {
    if (joined) return;
    const id = roomId.trim().toLowerCase();
    if (!id) {
      setPreJoinRoom({ status: "idle" });
      return;
    }
    setPreJoinRoom({ status: "loading" });
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      fetch(`/api/rooms/${encodeURIComponent(id)}`, { signal: ac.signal })
        .then((r) => {
          if (r.status === 404) return null;
          if (!r.ok) throw new Error("bad response");
          return r.json() as Promise<{ occupantCount?: number }>;
        })
        .then((data) => {
          if (data === null) setPreJoinRoom({ status: "missing" });
          else if (typeof data.occupantCount === "number")
            setPreJoinRoom({ status: "ok", occupantCount: data.occupantCount });
          else setPreJoinRoom({ status: "error" });
        })
        .catch(() => {
          if (!ac.signal.aborted) setPreJoinRoom({ status: "error" });
        });
    }, 350);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [roomId, joined]);

  const connectSocket = useCallback(() => {
    if (!socket.connected) socket.connect();
  }, [socket]);

  const joinRoom = useCallback(() => {
    setError(null);
    connectSocket();
    const id = roomId.trim().toLowerCase();
    if (!id) {
      setError("Enter a room code.");
      return;
    }
    socket.emit(
      "join",
      { roomId: id, displayName: displayName.trim() || undefined },
      (ack: {
        ok: boolean;
        error?: string;
        slot?: ParticipantSlot;
        treatment?: Treatment;
        messages?: ChatMessage[];
        peerConnected?: boolean;
      }) => {
        if (!ack?.ok) {
          setError(ack?.error || "Could not join.");
          return;
        }
        setJoined(true);
        setActiveRoomId(id);
        setSlot(ack.slot ?? null);
        setTreatment(ack.treatment ?? null);
        setMessages(ack.messages ?? []);
        setPeerPresent(!!ack.peerConnected);
      },
    );
  }, [connectSocket, displayName, roomId, socket]);

  useEffect(() => {
    const onMessage = (m: ChatMessage) => {
      setMessages((prev) => [...prev, m]);
    };
    const onPeerJoined = () => setPeerPresent(true);
    const onPeerLeft = () => setPeerPresent(false);
    const onTyping = (p: { typing: boolean }) => setLlmTyping(!!p?.typing);

    socket.on("message", onMessage);
    socket.on("peer_joined", onPeerJoined);
    socket.on("peer_left", onPeerLeft);
    socket.on("llm_typing", onTyping);

    return () => {
      socket.off("message", onMessage);
      socket.off("peer_joined", onPeerJoined);
      socket.off("peer_left", onPeerLeft);
      socket.off("llm_typing", onTyping);
    };
  }, [socket]);

  const send = useCallback(() => {
    const t = draft.trim();
    if (!t) return;
    socket.emit("chat_message", t);
    setDraft("");
  }, [draft, socket]);

  /** In-app copy only — no reference to alternate study conditions. */
  const sessionHintEl =
    treatment === "llm_enabled" ? (
      <>
        To request help, start your message with <strong>@LLM</strong>. Each request includes the full conversation so
        far.
      </>
    ) : (
      <>Use the chat box to talk with your partner.</>
    );

  const youStripLabel = displayName.trim()
    ? displayName.trim()
    : slot === "p1"
      ? "Participant 1"
      : slot === "p2"
        ? "Participant 2"
        : "You";

  const preJoinPeopleLine = () => {
    if (preJoinRoom.status === "idle") return null;
    if (preJoinRoom.status === "loading") return "Checking room…";
    if (preJoinRoom.status === "missing")
      return "That code was not found. Check the link or code you were given.";
    if (preJoinRoom.status === "error") return "Could not load room status.";
    const n = preJoinRoom.occupantCount;
    if (n === 0) return "No one else is connected yet — your partner can use the same code.";
    if (n === 1) return "One other person is already in this room.";
    return "This room may already be full (two people).";
  };

  if (!joined) {
    return (
      <>
        <h1>Study chat</h1>
        <p className="lead">Enter the room code you were given, then join. Wait until your partner connects.</p>

        {roomId.trim() ? (
          <div className="session-strip" aria-live="polite">
            <div className="session-strip-row">
              <span className="session-strip-label">Room code</span>
              <span className="session-strip-value">{roomId.trim().toLowerCase()}</span>
            </div>
            <div className="session-strip-row">
              <span className="session-strip-label">People inside</span>
              <span className="session-strip-people">{preJoinPeopleLine()}</span>
            </div>
          </div>
        ) : null}

        <div className="card">
          <label htmlFor="room">Room code</label>
          <input
            id="room"
            type="text"
            autoComplete="off"
            placeholder="e.g. abcd-efgh"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <div style={{ height: "0.75rem" }} />
          <label htmlFor="name">Display name (optional)</label>
          <input
            id="name"
            type="text"
            autoComplete="off"
            placeholder="Defaults to Participant 1 / 2"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <div style={{ marginTop: "0.75rem" }}>
            <button type="button" onClick={joinRoom}>
              Join room
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Study chat</h1>
      {activeRoomId ? (
        <div className="session-strip" aria-live="polite">
          <div className="session-strip-row">
            <span className="session-strip-label">Room code</span>
            <span className="session-strip-value">{activeRoomId}</span>
          </div>
          <div className="session-strip-row">
            <span className="session-strip-label">People</span>
            <span className="session-strip-people">
              <span>
                <span className="dot on" aria-hidden />
                You ({youStripLabel})
              </span>
              <span style={{ marginLeft: "0.75rem" }}>
                <span className={`dot ${peerPresent ? "on" : "off"}`} aria-hidden />
                Partner {peerPresent ? "(connected)" : "(not here yet)"}
              </span>
              <span style={{ marginLeft: "0.75rem", color: "var(--muted)" }}>
                {peerPresent ? 2 : 1}/2
              </span>
            </span>
          </div>
        </div>
      ) : null}
      <p className="lead">{peerPresent ? "Partner connected." : "Waiting for partner…"}</p>
      <p className="hint" style={{ marginBottom: "1rem" }}>
        {sessionHintEl}
      </p>

      <div className="card">
        <div className="messages" ref={listRef} aria-live="polite">
          {messages.map((m) => (
            <div key={m.id} className={`msg${m.slot === "llm" ? " llm" : ""}`}>
              <div className="msg-meta">
                {m.authorLabel}
                {m.slot === slot ? " (you)" : ""} · {formatTime(m.ts)}
              </div>
              <MessageBody text={m.text} />
            </div>
          ))}
          {llmTyping && <div className="typing">Assistant is typing…</div>}
        </div>

        <div className="composer">
          <input
            type="text"
            aria-label="Message"
            placeholder={
              treatment === "llm_enabled"
                ? "Message… start with @LLM to request help"
                : "Type your message…"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="button" onClick={send} disabled={!draft.trim()}>
            Send
          </button>
        </div>
      </div>
    </>
  );
}
