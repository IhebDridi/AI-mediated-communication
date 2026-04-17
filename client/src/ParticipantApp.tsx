import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import { MessageBody } from "./MessageBody";
import { SessionPreChatSteps } from "./SessionPreChatSteps";
import { useSessionPresenceReport } from "./useSessionPresenceReport";

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

function messageBubbleClass(m: ChatMessage, mySlot: ParticipantSlot | null) {
  if (m.slot === "llm") return "msg llm";
  if (mySlot && m.slot === mySlot) return "msg msg-self";
  return "msg msg-peer";
}

export function ParticipantApp() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const roomFromUrl = searchParams.get("room")?.trim().toLowerCase() || "";
  const sessionFromUrl = searchParams.get("session")?.trim().toLowerCase() || "";

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
  const [partnerFinished, setPartnerFinished] = useState(false);
  const [matchWaiting, setMatchWaiting] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [queueTicket, setQueueTicket] = useState<string | null>(null);
  /** null = loading; true/false once we know */
  const [sessionPairingEnabled, setSessionPairingEnabled] = useState<boolean | null>(null);
  const [sessionFetchState, setSessionFetchState] = useState<"idle" | "ok" | "notfound">("idle");

  useEffect(() => {
    if (roomFromUrl) setRoomId(roomFromUrl);
  }, [roomFromUrl]);

  useEffect(() => {
    if (!sessionFromUrl) return;
    try {
      const saved = sessionStorage.getItem(`margarita.session.${sessionFromUrl}.displayName`);
      if (saved) setDisplayName((prev) => prev || saved);
    } catch {
      /* ignore */
    }
  }, [sessionFromUrl]);

  useEffect(() => {
    if (!sessionFromUrl || joined) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionFromUrl)}`);
        if (cancelled) return;
        if (r.status === 404) {
          setSessionFetchState("notfound");
          setSessionPairingEnabled(false);
          return;
        }
        if (!r.ok) return;
        const j = (await r.json()) as { pairingEnabled?: boolean };
        if (cancelled) return;
        setSessionFetchState("ok");
        setSessionPairingEnabled(!!j.pairingEnabled);
      } catch {
        /* transient errors: keep last known session state */
      }
    };
    setSessionPairingEnabled(null);
    setSessionFetchState("idle");
    void tick();
    const id = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionFromUrl, joined]);

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

  const joinRoom = useCallback(
    (explicitRoomId?: string) => {
      setError(null);
      const name = displayName.trim();
      if (!name) {
        setError("Enter your name.");
        return;
      }
      if (name.length > 80) {
        setError("Name must be at most 80 characters.");
        return;
      }
      connectSocket();
      const id = (explicitRoomId ?? roomId).trim().toLowerCase();
      if (!id) {
        setError("Enter a room code.");
        return;
      }
      let participantPublicId: string | undefined;
      if (sessionFromUrl) {
        try {
          participantPublicId =
            sessionStorage.getItem(`margarita.session.${sessionFromUrl}.participantId`) ?? undefined;
        } catch {
          participantPublicId = undefined;
        }
      }
      socket.emit(
        "join",
        {
          roomId: id,
          displayName: name,
          ...(participantPublicId ? { participantPublicId } : {}),
        },
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
    },
    [connectSocket, displayName, roomId, sessionFromUrl, socket],
  );

  const startMatchmaking = useCallback(async () => {
    if (!sessionFromUrl) {
      setMatchError("Missing session in your link. Use the study URL you were given.");
      return;
    }
    const name = displayName.trim();
    if (!name) {
      setMatchError("Enter your name before joining the queue.");
      return;
    }
    if (name.length > 80) {
      setMatchError("Name must be at most 80 characters.");
      return;
    }
    setMatchError(null);
    setMatchWaiting(true);
    setQueueTicket(null);
    try {
      let participantPublicId: string | undefined;
      try {
        participantPublicId =
          sessionStorage.getItem(`margarita.session.${sessionFromUrl}.participantId`) ?? undefined;
      } catch {
        participantPublicId = undefined;
      }
      const res = await fetch("/api/match/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionFromUrl,
          displayName: name,
          ...(participantPublicId ? { participantPublicId } : {}),
        }),
      });
      if (res.status === 403) {
        throw new Error("Matching has not started yet. Please wait for the researcher.");
      }
      if (res.status === 404) {
        throw new Error("This study session was not found. Check your link.");
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Could not start matching.");
      }
      const data = (await res.json()) as {
        ticket: string;
        matched: boolean;
        roomId?: string;
      };
      if (data.matched && data.roomId) {
        setQueueTicket(null);
        setMatchWaiting(false);
        setRoomId(data.roomId);
        joinRoom(data.roomId);
      } else {
        setQueueTicket(data.ticket);
      }
    } catch (e) {
      setMatchWaiting(false);
      setQueueTicket(null);
      setMatchError(e instanceof Error ? e.message : "Matching failed.");
    }
  }, [joinRoom, sessionFromUrl, displayName]);

  useEffect(() => {
    if (!queueTicket || joined) return;
    const intervalId = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/match/status?ticket=${encodeURIComponent(queueTicket)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { matched: boolean; roomId?: string };
        if (data.matched && data.roomId) {
          window.clearInterval(intervalId);
          setMatchWaiting(false);
          setQueueTicket(null);
          setRoomId(data.roomId);
          joinRoom(data.roomId);
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => window.clearInterval(intervalId);
  }, [queueTicket, joined, joinRoom]);

  useEffect(() => {
    const onMessage = (m: ChatMessage) => {
      setMessages((prev) => [...prev, m]);
    };
    const onPeerJoined = () => setPeerPresent(true);
    const onPeerLeft = (p?: { voluntary?: boolean }) => {
      setPeerPresent(false);
      if (p?.voluntary) setPartnerFinished(true);
    };
    const onVoluntaryExit = (p: { slot: ParticipantSlot }) => {
      if (!slot || p.slot === slot) return;
      setPartnerFinished(true);
    };
    const onTyping = (p: { typing: boolean }) => setLlmTyping(!!p?.typing);

    socket.on("message", onMessage);
    socket.on("peer_joined", onPeerJoined);
    socket.on("peer_left", onPeerLeft);
    socket.on("voluntary_exit", onVoluntaryExit);
    socket.on("llm_typing", onTyping);

    return () => {
      socket.off("message", onMessage);
      socket.off("peer_joined", onPeerJoined);
      socket.off("peer_left", onPeerLeft);
      socket.off("voluntary_exit", onVoluntaryExit);
      socket.off("llm_typing", onTyping);
    };
  }, [socket, slot]);

  useSessionPresenceReport({
    sessionId: sessionFromUrl || null,
    phase: "chat",
    displayName,
    enabled: !!sessionFromUrl && joined,
  });

  const send = useCallback(() => {
    const t = draft.trim();
    if (!t) return;
    socket.emit("chat_message", t);
    setDraft("");
  }, [draft, socket]);

  const finishAndLeave = useCallback(() => {
    if (socket.connected) {
      socket.emit("exit_chat");
      socket.disconnect();
    }
    if (sessionFromUrl) {
      navigate(`/study/afterchat?session=${encodeURIComponent(sessionFromUrl)}`);
    } else {
      navigate("/thankyou");
    }
  }, [navigate, sessionFromUrl, socket]);

  /** In-app copy only - no reference to alternate study conditions. */
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
    if (n === 0) return "No one else is connected yet - your partner can use the same code.";
    if (n === 1) return "One other person is already in this room.";
    return "This room may already be full (two people).";
  };

  if (!joined) {
    if (sessionFromUrl) {
      return (
        <SessionPreChatSteps
          sessionId={sessionFromUrl}
          sessionPairingEnabled={sessionPairingEnabled}
          sessionFetchState={sessionFetchState}
          displayName={displayName}
          setDisplayName={setDisplayName}
          matchWaiting={matchWaiting}
          queueTicket={queueTicket}
          matchError={matchError}
          startMatchmaking={startMatchmaking}
          manualRoom={{
            roomId,
            setRoomId,
            roomFromUrl,
            preJoinRoom,
            joinRoom,
            joinError: error,
          }}
        />
      );
    }

    return (
      <>
        <h1>Study chat</h1>
        <p className="lead">
          {roomFromUrl
            ? "Enter the room code you were given, then join. Wait until your partner connects."
            : "Use the link from your instructions. If you only have a room code, enter it below."}
        </p>

        <div className="card" style={{ marginBottom: "1rem" }}>
          <label htmlFor="name">Your name (required)</label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            maxLength={80}
            placeholder="Enter the name shown to the researcher"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <p className="hint" style={{ marginBottom: 0 }}>
            This name appears in the researcher dashboard and next to your messages in chat.
          </p>
        </div>

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
          {!roomFromUrl ? (
            <p className="hint" style={{ marginTop: 0, marginBottom: "0.65rem", fontWeight: 600 }}>
              {sessionFromUrl ? "Or join with a direct room code" : "Join with a room code"}
            </p>
          ) : null}
          <label htmlFor="room">Room code</label>
          <input
            id="room"
            type="text"
            autoComplete="off"
            placeholder="e.g. abcd-efgh"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <div style={{ marginTop: "0.75rem" }}>
            <button type="button" disabled={!displayName.trim()} onClick={() => joinRoom()}>
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

      {partnerFinished ? (
        <p className="hint" style={{ marginBottom: "0.75rem", color: "var(--muted)", fontWeight: 600 }}>
          Your partner has finished and left the study chat.
        </p>
      ) : null}

      <div className="card">
        <div className="messages" ref={listRef} aria-live="polite">
          {messages.map((m) => (
            <div key={m.id} className={messageBubbleClass(m, slot)}>
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
        <div style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
          <button type="button" className="secondary" onClick={finishAndLeave}>
            Finish and leave
          </button>
          <p className="hint" style={{ marginTop: "0.45rem", marginBottom: 0 }}>
            When you are done, you can leave and go to a short thank-you screen.
          </p>
        </div>
      </div>
    </>
  );
}
