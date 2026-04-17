import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { MessageBody } from "./MessageBody";

const STORAGE_KEY = "margarita_admin_secret";

type Treatment = "human_only" | "llm_enabled";
type PairingMode = "normal" | "region";

type RoomRow = {
  roomId: string;
  treatment: Treatment;
  label: string | null;
  sessionId: string | null;
  occupantCount: number;
  messageCount: number;
  p1Active: boolean;
  p2Active: boolean;
  p1DisplayName: string | null;
  p2DisplayName: string | null;
  p1VoluntaryExitAt: number | null;
  p2VoluntaryExitAt: number | null;
};

type SessionRow = {
  sessionId: string;
  label: string | null;
  pairingEnabled: boolean;
  pairingMode?: PairingMode;
  waitingCount: number;
  participantCount?: number;
  waitingParticipants: {
    displayName: string;
    waitingSince: number;
    ticket: string;
    participantPublicId: string | null;
    region?: string | null;
  }[];
  createdAt: number;
};

type ChatMessage = {
  id: string;
  slot: "p1" | "p2" | "llm";
  authorLabel: string;
  text: string;
  ts: number;
};

type SessionDetailParticipant = {
  participantPublicId: string | null;
  displayName: string;
  region?: string | null;
  phase: string | null;
  lastSeenMs: number | null;
  presenceStale: boolean;
  waitingForPair: boolean;
  matchTicket: string | null;
  roomId: string | null;
  slot: "p1" | "p2" | null;
  socketConnected: boolean;
  questionnaire: Record<string, string>;
  exitSurvey: { age: string; work: string; feedback: string } | null;
  liveChatMessages: ChatMessage[];
  archivedChats: Array<{
    archiveId: number;
    roomId: string;
    messageCount: number;
    transcript: string;
    messages: ChatMessage[];
  }>;
};

type SessionDetailGroup = {
  groupId: string;
  roomId: string;
  archiveId: number | null;
  status: "active" | "archived";
  treatment: string | null;
  p1ParticipantPublicId: string | null;
  p2ParticipantPublicId: string | null;
  p1DisplayName: string;
  p2DisplayName: string;
  messages: ChatMessage[];
  transcript: string;
};

type SessionDetailPayload = {
  sessionId: string;
  sessionLabel: string | null;
  pairingEnabled: boolean;
  pairingMode?: PairingMode;
  liveSession: boolean;
  liveHint: string | null;
  questionPrompts: Record<string, string>;
  participants: SessionDetailParticipant[];
  groups: SessionDetailGroup[];
};

type CollectedSessionSummary = {
  id: number;
  sessionId: string;
  sessionLabel: string | null;
  savedAt: string;
  participantCount: number;
  groupCount: number;
};

type SessionSnapshotPayload = {
  version: number;
  sessionId: string;
  sessionLabel: string | null;
  questionPrompts: Record<string, string>;
  participants: SessionDetailParticipant[];
  groups: SessionDetailGroup[];
  savedAt?: string;
  exportParticipants?: unknown[];
  detailMeta?: { liveSession: boolean; pairingEnabled: boolean; pairingMode?: PairingMode; liveHint: string | null };
};

function snapshotToSessionDetail(snap: SessionSnapshotPayload, savedAtIso: string): SessionDetailPayload {
  return {
    sessionId: snap.sessionId,
    sessionLabel: snap.sessionLabel,
    pairingEnabled: snap.detailMeta?.pairingEnabled ?? false,
    pairingMode: snap.detailMeta?.pairingMode ?? "normal",
    liveSession: false,
    liveHint: `Saved session snapshot from ${formatShort(new Date(savedAtIso).getTime())}.`,
    questionPrompts: snap.questionPrompts,
    participants: Array.isArray(snap.participants) ? snap.participants : [],
    groups: Array.isArray(snap.groups) ? snap.groups : [],
  };
}

function participantJoinUrl(roomId: string): string {
  const u = new URL(window.location.href);
  u.pathname = "/study";
  u.search = "";
  u.hash = "";
  u.searchParams.set("room", roomId);
  return u.toString();
}

function participantSessionUrl(sessionId: string): string {
  const u = new URL(window.location.href);
  u.pathname = "/study";
  u.search = "";
  u.hash = "";
  u.searchParams.set("session", sessionId);
  return u.toString();
}

function formatShort(ts: number) {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return String(ts);
  }
}

function formatTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

const PHASE_LABELS: Record<string, string> = {
  intro: "Intro / name",
  questions: "Pre-chat questionnaire",
  instructions: "Instructions (before queue)",
  queue: "In match queue",
  chat: "In chat room",
  after_chat: "Post-chat survey",
  thank_you: "Thank-you page",
};

function participantStatusSummary(p: SessionDetailParticipant): string {
  if (p.waitingForPair) return "Waiting for a partner (in queue)";
  if (p.roomId && p.phase === "chat") return "In chat room";
  if (p.phase && PHASE_LABELS[p.phase]) return PHASE_LABELS[p.phase];
  if (p.phase) return p.phase;
  return "No recent page signal (tab closed or not yet started)";
}

function participantRowKey(p: SessionDetailParticipant, idx: number): string {
  if (p.participantPublicId?.trim()) return p.participantPublicId.trim();
  if (p.matchTicket) return `anon:${p.matchTicket}`;
  return `row:${idx}`;
}

function findParticipantByKey(detail: SessionDetailPayload, key: string): SessionDetailParticipant | undefined {
  return detail.participants.find((p, i) => participantRowKey(p, i) === key);
}

function resolveGroupSlotToParticipantKey(
  detail: SessionDetailPayload,
  g: SessionDetailGroup,
  slot: "p1" | "p2",
): string | null {
  const pid = slot === "p1" ? g.p1ParticipantPublicId : g.p2ParticipantPublicId;
  if (pid?.trim()) return pid.trim();
  const name = (slot === "p1" ? g.p1DisplayName : g.p2DisplayName).trim().toLowerCase();
  if (!name || name === "—") return null;
  const idx = detail.participants.findIndex((x) => x.displayName.trim().toLowerCase() === name);
  if (idx >= 0) return participantRowKey(detail.participants[idx], idx);
  return null;
}

function adminMessageBubbleClass(slot: ChatMessage["slot"]): string {
  if (slot === "llm") return "msg llm";
  if (slot === "p1") return "msg msg-self";
  return "msg msg-peer";
}

function AdminColoredTranscript({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="messages admin-live-transcript" aria-live="polite">
      {messages.length === 0 ? (
        <p className="hint">No messages.</p>
      ) : (
        messages.map((m, i) => (
          <div key={m.id || `adm-${i}`} className={adminMessageBubbleClass(m.slot)}>
            <div className="msg-meta">
              {m.authorLabel} · {formatTime(m.ts)} · {m.slot}
            </div>
            <MessageBody text={m.text} />
          </div>
        ))
      )}
    </div>
  );
}

function SessionParticipantInspectorPanel({
  p,
  questionPrompts,
  onOpenThread,
}: {
  p: SessionDetailParticipant;
  questionPrompts: Record<string, string>;
  onOpenThread: (title: string, messages: ChatMessage[]) => void;
}) {
  return (
    <div className="admin-inspector-body">
      <div className="admin-inspector-title">{p.displayName || "(unnamed)"}</div>
      {p.participantPublicId ? (
        <code className="hint admin-inspector-sub">{p.participantPublicId}</code>
      ) : (
        <p className="hint admin-inspector-sub">No device id (queue-only or legacy client)</p>
      )}
      <p style={{ margin: "0.5rem 0", fontWeight: 600 }}>{participantStatusSummary(p)}</p>
      {p.waitingForPair ? (
        <p className="hint" style={{ marginTop: 0 }}>
          Waiting to be paired.
        </p>
      ) : null}
      <p className="hint" style={{ marginTop: "0.25rem" }}>
        Region: {p.region?.trim() || "Unknown (not detected)"}
      </p>
      {p.lastSeenMs != null ? (
        <p className="hint" style={{ marginTop: "0.25rem" }}>
          Last page signal: {formatShort(p.lastSeenMs)}
          {p.presenceStale ? " (stale — tab may be closed)" : ""}
        </p>
      ) : null}
      {p.roomId ? (
        <p className="hint" style={{ marginBottom: "0.65rem" }}>
          Room <code>{p.roomId}</code>
          {p.slot ? ` · slot ${p.slot}` : ""} · socket {p.socketConnected ? "connected" : "disconnected"}
        </p>
      ) : null}
      {Object.keys(p.questionnaire).length > 0 ? (
        <div style={{ marginTop: "0.65rem" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>Pre-chat answers</div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {Object.entries(p.questionnaire).map(([qid, ans]) => (
              <li key={qid} style={{ marginBottom: "0.35rem" }}>
                <span className="hint">{questionPrompts[qid] || qid}: </span>
                {ans || "—"}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="hint">No questionnaire saved yet.</p>
      )}
      {p.exitSurvey ? (
        <div style={{ marginTop: "0.65rem" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>Exit survey</div>
          <p className="hint" style={{ margin: "0.25rem 0" }}>
            Age: {p.exitSurvey.age} · Work: {p.exitSurvey.work}
          </p>
          <p className="hint" style={{ margin: 0 }}>
            Feedback: {p.exitSurvey.feedback}
          </p>
        </div>
      ) : null}
      <div style={{ marginTop: "0.85rem", display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
        {p.liveChatMessages.length > 0 ? (
          <button
            type="button"
            className="small secondary"
            onClick={() =>
              onOpenThread(`Live chat — ${p.displayName || "participant"}`, p.liveChatMessages)
            }
          >
            View live chat ({p.liveChatMessages.length})
          </button>
        ) : null}
        {p.archivedChats.map((ac) => (
          <button
            key={ac.archiveId}
            type="button"
            className="small secondary"
            onClick={() =>
              onOpenThread(
                `Collected transcript #${ac.archiveId} — ${p.displayName || "participant"}`,
                ac.messages ?? [],
              )
            }
          >
            View collected #{ac.archiveId} ({ac.messageCount} msgs)
          </button>
        ))}
      </div>
    </div>
  );
}

function SlotStatus({ active, voluntaryAt }: { active: boolean; voluntaryAt: number | null }) {
  if (active) {
    return <span style={{ color: "var(--accent)" }}>Connected</span>;
  }
  if (voluntaryAt) {
    return (
      <span>
        Finished <span className="hint" style={{ fontSize: "0.8rem" }}>({formatShort(voluntaryAt)})</span>
      </span>
    );
  }
  return <span style={{ color: "var(--muted)" }}>Offline</span>;
}

function AdminActiveRoomsTable({
  rooms: roomRows,
  emptyHint,
  dbConfigured,
  collectingId,
  collectChat,
  copy,
}: {
  rooms: RoomRow[];
  emptyHint: string;
  dbConfigured: boolean;
  collectingId: string | null;
  collectChat: (roomId: string) => void | Promise<void>;
  copy: (text: string) => void | Promise<void>;
}) {
  return (
    <div className="card admin-table-wrap">
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Active rooms</h2>
      {roomRows.length === 0 ? (
        <p className="hint">{emptyHint}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Type</th>
              <th>Code</th>
              <th>Participant 1</th>
              <th>Participant 2</th>
              <th>Msgs</th>
              <th>Join link</th>
              <th>Collect</th>
            </tr>
          </thead>
          <tbody>
            {roomRows.map((r) => (
              <tr key={r.roomId}>
                <td>{r.label || "-"}</td>
                <td>{r.treatment === "llm_enabled" ? "Chat + @LLM" : "Human only"}</td>
                <td>
                  <code>{r.roomId}</code>
                </td>
                <td>
                  <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{r.p1DisplayName ?? "—"}</div>
                  <SlotStatus active={r.p1Active} voluntaryAt={r.p1VoluntaryExitAt} />
                </td>
                <td>
                  <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{r.p2DisplayName ?? "—"}</div>
                  <SlotStatus active={r.p2Active} voluntaryAt={r.p2VoluntaryExitAt} />
                </td>
                <td>{r.messageCount}</td>
                <td>
                  <button type="button" className="small secondary" onClick={() => void copy(participantJoinUrl(r.roomId))}>
                    Copy link
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className="small"
                    disabled={!dbConfigured || collectingId === r.roomId}
                    onClick={() => void collectChat(r.roomId)}
                  >
                    {collectingId === r.roomId ? "Saving…" : "Collect chat"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SessionParticipantsAndGroupsExplorer({
  detail,
  snapshotMode,
  sessionInspector,
  setSessionInspector,
  setParticipantChatModal,
  dbConfigured,
  collectingId,
  collectChat,
  copy,
}: {
  detail: SessionDetailPayload;
  snapshotMode: boolean;
  sessionInspector: { view: "participant"; participantKey: string } | { view: "group"; groupId: string } | null;
  setSessionInspector: Dispatch<
    SetStateAction<{ view: "participant"; participantKey: string } | { view: "group"; groupId: string } | null>
  >;
  setParticipantChatModal: Dispatch<SetStateAction<{ title: string; messages: ChatMessage[] } | null>>;
  dbConfigured: boolean;
  collectingId: string | null;
  collectChat: (roomId: string) => void | Promise<void>;
  copy: (text: string) => void | Promise<void>;
}) {
  return (
    <>
      <div className="admin-session-split">
        <section className="admin-session-column">
          <h3 className="admin-session-column-title">Participants</h3>
          {detail.participants.length === 0 ? (
            <p className="hint">No rows yet. Data appears after names or questionnaires.</p>
          ) : (
            <ul className="admin-tile-list">
              {detail.participants.map((p, idx) => {
                const key = participantRowKey(p, idx);
                const sel = sessionInspector?.view === "participant" && sessionInspector.participantKey === key;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`admin-list-tile${sel ? " admin-list-tile-selected" : ""}`}
                      onClick={() => setSessionInspector({ view: "participant", participantKey: key })}
                    >
                      <span className="admin-list-tile-title">{p.displayName || "(unnamed)"}</span>
                      <span className="admin-list-tile-meta">{participantStatusSummary(p)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="admin-session-column">
          <h3 className="admin-session-column-title">Paired groups</h3>
          {(detail.groups ?? []).length === 0 ? (
            <p className="hint">No pairs yet. Groups appear after two people are matched or a chat is collected.</p>
          ) : (
            <ul className="admin-tile-list">
              {(detail.groups ?? []).map((g) => {
                const sel = sessionInspector?.view === "group" && sessionInspector.groupId === g.groupId;
                return (
                  <li key={g.groupId}>
                    <button
                      type="button"
                      className={`admin-list-tile${sel ? " admin-list-tile-selected" : ""}`}
                      onClick={() => setSessionInspector({ view: "group", groupId: g.groupId })}
                    >
                      <span className="admin-list-tile-title">
                        Group <code>{g.groupId}</code>
                      </span>
                      <span className="admin-list-tile-meta">
                        {g.p1DisplayName} ↔ {g.p2DisplayName} · {g.status === "active" ? "Active" : "Archived"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="admin-inspector card">
        {!sessionInspector ? (
          <p className="hint" style={{ margin: 0 }}>
            Select a participant or a paired group to see details here.
          </p>
        ) : sessionInspector.view === "participant" ? (
          (() => {
            const p = findParticipantByKey(detail, sessionInspector.participantKey);
            if (!p) {
              return <p className="error">That participant is no longer in this session snapshot.</p>;
            }
            return (
              <SessionParticipantInspectorPanel
                p={p}
                questionPrompts={detail.questionPrompts}
                onOpenThread={(title, messages) => setParticipantChatModal({ title, messages })}
              />
            );
          })()
        ) : (
          (() => {
            const g = (detail.groups ?? []).find((x) => x.groupId === sessionInspector.groupId);
            if (!g) {
              return <p className="error">Group not found.</p>;
            }
            const k1 = resolveGroupSlotToParticipantKey(detail, g, "p1");
            const k2 = resolveGroupSlotToParticipantKey(detail, g, "p2");
            return (
              <div className="admin-inspector-body">
                <div className="admin-inspector-title">
                  Group <code>{g.groupId}</code>
                </div>
                <p className="hint" style={{ marginTop: "0.35rem" }}>
                  {g.status === "active" ? (
                    <>Active room · {g.treatment === "llm_enabled" ? "Chat + @LLM" : "Human only"}</>
                  ) : (
                    <>
                      Collected archive #{g.archiveId} ·{" "}
                      {g.treatment === "llm_enabled" ? "Chat + @LLM" : "Human only"}
                    </>
                  )}
                </p>
                <div style={{ marginTop: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                  <button
                    type="button"
                    className="small secondary"
                    onClick={() =>
                      setParticipantChatModal({
                        title: `Group ${g.groupId} — chat`,
                        messages: g.messages,
                      })
                    }
                  >
                    View chat (colored)
                  </button>
                  {g.status === "active" && !snapshotMode ? (
                    <>
                      <button
                        type="button"
                        className="small secondary"
                        onClick={() => void copy(participantJoinUrl(g.roomId))}
                      >
                        Copy join link
                      </button>
                      <button
                        type="button"
                        className="small"
                        disabled={!dbConfigured || collectingId === g.roomId}
                        onClick={() => void collectChat(g.roomId)}
                      >
                        {collectingId === g.roomId ? "Saving…" : "Collect chat"}
                      </button>
                    </>
                  ) : null}
                </div>
                <h4 style={{ fontSize: "0.95rem", margin: "1.1rem 0 0.5rem" }}>People in this pair</h4>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <button
                    type="button"
                    className="secondary small"
                    disabled={!k1}
                    title={
                      k1
                        ? "Open this participant’s questionnaire and status"
                        : "No participant id — match manually from the Participants list"
                    }
                    onClick={() => {
                      if (k1) setSessionInspector({ view: "participant", participantKey: k1 });
                    }}
                  >
                    P1: {g.p1DisplayName}
                  </button>
                  <button
                    type="button"
                    className="secondary small"
                    disabled={!k2}
                    title={
                      k2
                        ? "Open this participant’s questionnaire and status"
                        : "No participant id — match manually from the Participants list"
                    }
                    onClick={() => {
                      if (k2) setSessionInspector({ view: "participant", participantKey: k2 });
                    }}
                  >
                    P2: {g.p2DisplayName}
                  </button>
                </div>
              </div>
            );
          })()
        )}
      </div>
    </>
  );
}

export function AdminApp() {
  const [secret, setSecret] = useState(() => sessionStorage.getItem(STORAGE_KEY) || "");
  const [secretInput, setSecretInput] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [collectedSessions, setCollectedSessions] = useState<CollectedSessionSummary[]>([]);
  const [dbConfigured, setDbConfigured] = useState(false);
  const [treatment, setTreatment] = useState<Treatment>("human_only");
  const [label, setLabel] = useState("");
  const [sessionLabel, setSessionLabel] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [startingSessionId, setStartingSessionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [questionnaireExportingSessionId, setQuestionnaireExportingSessionId] = useState<string | null>(null);
  const [sessionFullExportId, setSessionFullExportId] = useState<string | null>(null);
  const [savingSnapshotSessionId, setSavingSnapshotSessionId] = useState<string | null>(null);
  const [exportingCollectedId, setExportingCollectedId] = useState<number | null>(null);
  const [adminTab, setAdminTab] = useState<"sessions" | "manual" | "collected">("sessions");
  const [collectedReview, setCollectedReview] = useState<{
    id: number;
    savedAt: string;
    detail: SessionDetailPayload | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [showNewSessionForm, setShowNewSessionForm] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [sessionDetailError, setSessionDetailError] = useState<string | null>(null);
  const [pairingModeDraft, setPairingModeDraft] = useState<PairingMode>("normal");
  const [participantChatModal, setParticipantChatModal] = useState<{ title: string; messages: ChatMessage[] } | null>(
    null,
  );
  const [sessionInspector, setSessionInspector] = useState<
    | { view: "participant"; participantKey: string }
    | { view: "group"; groupId: string }
    | null
  >(null);

  const authHeaders = useCallback(
    (tokenOverride?: string): HeadersInit => {
      const s = (tokenOverride ?? secret).trim();
      return s ? { Authorization: `Bearer ${s}` } : {};
    },
    [secret],
  );

  const refreshData = useCallback(
    async (tokenOverride?: string) => {
      setLoadError(null);
      const headers = authHeaders(tokenOverride);
      const [resRooms, resSessions] = await Promise.all([
        fetch("/api/admin/rooms", { headers }),
        fetch("/api/admin/sessions", { headers }),
      ]);
    if (resRooms.status === 401 || resSessions.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      setSecret("");
      setAuthorized(false);
      setLoadError("Invalid or missing admin secret.");
      return;
    }
    if (!resRooms.ok) {
      setLoadError("Could not load rooms.");
      return;
    }
    if (!resSessions.ok) {
      setLoadError("Could not load pairing sessions.");
      return;
    }
    const dataRooms = (await resRooms.json()) as { rooms?: RoomRow[]; dbConfigured?: boolean };
    setRooms(dataRooms.rooms ?? []);
    setDbConfigured(!!dataRooms.dbConfigured);
    const dataSessions = (await resSessions.json()) as { sessions?: SessionRow[] };
    setSessions(dataSessions.sessions ?? []);
    setAuthorized(true);
    const store = (tokenOverride ?? secret).trim();
    if (store) sessionStorage.setItem(STORAGE_KEY, store);
  },
    [authHeaders, secret],
  );

  useEffect(() => {
    if (secret.trim()) {
      void refreshData();
    }
  }, []);

  useEffect(() => {
    if (!authorized) return;
    const id = window.setInterval(() => void refreshData(), 4000);
    return () => window.clearInterval(id);
  }, [authorized, refreshData]);

  const login = async () => {
    const s = secretInput.trim();
    setLoadError(null);
    const res = await fetch("/api/admin/rooms", { headers: { Authorization: `Bearer ${s}` } });
    if (res.status === 401) {
      setAuthorized(false);
      setLoadError("Invalid admin secret.");
      return;
    }
    if (!res.ok) {
      setLoadError("Could not reach server.");
      return;
    }
    setSecret(s);
    await refreshData(s);
  };

  const logout = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSecret("");
    setSecretInput("");
    setAuthorized(false);
    setRooms([]);
    setSessions([]);
    setCollectedSessions([]);
    setAdminTab("sessions");
    setShowNewSessionForm(false);
    setSelectedSessionId(null);
    setSessionDetail(null);
    setSessionDetailError(null);
    setParticipantChatModal(null);
    setSessionInspector(null);
    setCollectedReview(null);
  };

  useEffect(() => {
    setSessionInspector(null);
    setParticipantChatModal(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!sessionDetail) return;
    setPairingModeDraft(sessionDetail.pairingMode === "region" ? "region" : "normal");
  }, [sessionDetail?.sessionId, sessionDetail?.pairingMode]);

  const fetchCollectedSessions = useCallback(async () => {
    if (!authorized) return;
    try {
      const res = await fetch("/api/admin/collected-sessions", { headers: authHeaders() });
      if (res.status === 401) return;
      if (!res.ok) return;
      const data = (await res.json()) as { collectedSessions?: CollectedSessionSummary[] };
      setCollectedSessions(data.collectedSessions ?? []);
    } catch {
      /* ignore */
    }
  }, [authHeaders, authorized]);

  useEffect(() => {
    if (!authorized || adminTab !== "collected") return;
    void fetchCollectedSessions();
    const id = window.setInterval(() => void fetchCollectedSessions(), 8000);
    return () => window.clearInterval(id);
  }, [authorized, adminTab, fetchCollectedSessions]);

  useEffect(() => {
    if (!collectedReview?.loading || collectedReview.detail) return;
    const cid = collectedReview.id;
    const savedAt = collectedReview.savedAt;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/collected-sessions/${cid}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) {
          setCollectedReview(null);
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setCollectedReview((prev) =>
            prev && prev.id === cid
              ? { ...prev, loading: false, error: j.error || "Could not load session." }
              : prev,
          );
          return;
        }
        const data = (await res.json()) as { snapshot?: SessionSnapshotPayload; savedAt?: string };
        const snap = data.snapshot;
        if (!snap || typeof snap !== "object") {
          setCollectedReview((prev) =>
            prev && prev.id === cid ? { ...prev, loading: false, error: "Invalid snapshot." } : prev,
          );
          return;
        }
        const at = data.savedAt ?? savedAt;
        setCollectedReview((prev) =>
          prev && prev.id === cid
            ? { ...prev, loading: false, error: null, detail: snapshotToSessionDetail(snap, at) }
            : prev,
        );
        setSessionInspector(null);
      } catch {
        if (!cancelled) {
          setCollectedReview((prev) =>
            prev && prev.id === cid ? { ...prev, loading: false, error: "Network error." } : prev,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collectedReview?.id, collectedReview?.loading, collectedReview?.detail, authHeaders]);

  const createPairingSession = async () => {
    setCreatingSession(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          label: sessionLabel.trim() || undefined,
        }),
      });
      if (res.status === 401) {
        setAuthorized(false);
        setLoadError("Unauthorized.");
        return;
      }
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setLoadError(j.error || "Create session failed.");
        return;
      }
      setSessionLabel("");
      setShowNewSessionForm(false);
      await refreshData();
    } finally {
      setCreatingSession(false);
    }
  };

  const startSessionPairing = async (sessionId: string, pairingMode: PairingMode) => {
    setStartingSessionId(sessionId);
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/start-pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ pairingMode }),
      });
      if (res.status === 401) {
        setAuthorized(false);
        setLoadError("Unauthorized.");
        return;
      }
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setLoadError(j.error || "Could not start pairing.");
        return;
      }
      await refreshData();
    } finally {
      setStartingSessionId(null);
    }
  };

  const createRoom = async () => {
    setCreating(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          treatment,
          label: label.trim() || undefined,
        }),
      });
      if (res.status === 401) {
        setAuthorized(false);
        setLoadError("Unauthorized.");
        return;
      }
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setLoadError(j.error || "Create failed.");
        return;
      }
      setLabel("");
      await refreshData();
    } finally {
      setCreating(false);
    }
  };

  const collectChat = async (roomId: string) => {
    setCollectingId(roomId);
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(roomId)}/collect`, {
        method: "POST",
        headers: authHeaders(),
      });
      const j = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok) {
        setLoadError(j.error || "Collect failed.");
        return;
      }
      await refreshData();
    } finally {
      setCollectingId(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy:", text);
    }
  };

  const downloadSessionFullJson = useCallback(
    async (sessionId: string) => {
      setSessionFullExportId(sessionId);
      setLoadError(null);
      try {
        const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/export.json`, {
          headers: authHeaders(),
        });
        if (res.status === 401) {
          setAuthorized(false);
          setLoadError("Invalid or missing admin secret.");
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setLoadError(j.error || "Full export failed.");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `margarita-session-${sessionId}-export.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setLoadError("Full export failed.");
      } finally {
        setSessionFullExportId(null);
      }
    },
    [authHeaders],
  );

  const downloadSessionQuestionnaireCsv = useCallback(
    async (sessionId: string) => {
      setQuestionnaireExportingSessionId(sessionId);
      setLoadError(null);
      try {
        const res = await fetch(
          `/api/admin/sessions/${encodeURIComponent(sessionId)}/questionnaire.csv`,
          { headers: authHeaders() },
        );
        if (res.status === 401) {
          setAuthorized(false);
          setLoadError("Invalid or missing admin secret.");
          return;
        }
        if (!res.ok) {
          const t = await res.text();
          setLoadError(t || "Questionnaire export failed.");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `margarita-session-${sessionId}-questionnaires.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setLoadError("Questionnaire export failed.");
      } finally {
        setQuestionnaireExportingSessionId(null);
      }
    },
    [authHeaders],
  );

  const downloadCollectedSessionExport = useCallback(
    async (collectedId: number) => {
      setExportingCollectedId(collectedId);
      setLoadError(null);
      try {
        const res = await fetch(`/api/admin/collected-sessions/${collectedId}/export.json`, {
          headers: authHeaders(),
        });
        if (res.status === 401) {
          setAuthorized(false);
          setLoadError("Invalid or missing admin secret.");
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setLoadError(j.error || "Export failed.");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `margarita-collected-session-${collectedId}-export.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setLoadError("Export failed.");
      } finally {
        setExportingCollectedId(null);
      }
    },
    [authHeaders],
  );

  const saveSessionToDatabase = useCallback(
    async (sessionId: string) => {
      setSavingSnapshotSessionId(sessionId);
      setLoadError(null);
      try {
        const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/snapshot`, {
          method: "POST",
          headers: authHeaders(),
        });
        if (res.status === 401) {
          setAuthorized(false);
          setLoadError("Invalid or missing admin secret.");
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setLoadError(j.error || "Save session failed.");
          return;
        }
        await fetchCollectedSessions();
      } catch {
        setLoadError("Save session failed.");
      } finally {
        setSavingSnapshotSessionId(null);
      }
    },
    [authHeaders, fetchCollectedSessions],
  );

  const fetchSessionDetail = useCallback(
    async (sessionId: string, isPoll = false) => {
      setSessionDetailError(null);
      if (!isPoll) setSessionDetailLoading(true);
      try {
        const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/detail`, {
          headers: authHeaders(),
        });
        if (res.status === 401) {
          setAuthorized(false);
          setSessionDetail(null);
          setLoadError("Invalid or missing admin secret.");
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setSessionDetailError(j.error || "Could not load session.");
          setSessionDetail(null);
          return;
        }
        const data = (await res.json()) as SessionDetailPayload;
        setSessionDetail({ ...data, groups: data.groups ?? [] });
      } catch {
        setSessionDetailError("Network error.");
        setSessionDetail(null);
      } finally {
        if (!isPoll) setSessionDetailLoading(false);
      }
    },
    [authHeaders],
  );

  useEffect(() => {
    if (!authorized || !selectedSessionId || collectedReview) return;
    void fetchSessionDetail(selectedSessionId, false);
    const id = window.setInterval(() => void fetchSessionDetail(selectedSessionId, true), 4000);
    return () => window.clearInterval(id);
  }, [authorized, selectedSessionId, collectedReview, fetchSessionDetail]);

  useEffect(() => {
    if (participantChatModal === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setParticipantChatModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [participantChatModal]);

  if (!authorized) {
    return (
      <div className="admin-page">
        <h1>Researcher admin</h1>
        <p className="lead">
          Create pairing sessions (one link for many participants) or manual pair rooms. This page is not shown to
          participants.
        </p>
        <div className="card" style={{ maxWidth: 420 }}>
          <label htmlFor="admin-secret">Admin secret</label>
          <input
            id="admin-secret"
            type="password"
            autoComplete="off"
            placeholder="Same value as ADMIN_SECRET on the server"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void login()}
          />
          {loadError && <p className="error">{loadError}</p>}
          <div style={{ marginTop: "0.75rem" }}>
            <button type="button" onClick={() => void login()}>
              Sign in
            </button>
          </div>
        </div>
        <p className="hint" style={{ marginTop: "1rem" }}>
          <Link to="/study">Participant study page</Link>
        </p>
      </div>
    );
  }

  const pairingSessionRoomRows = rooms.filter((r) => Boolean(r.sessionId?.trim()));
  const manualRoomRows = rooms.filter((r) => !r.sessionId?.trim());
  const pairingEverStarted = sessions.some((s) => s.pairingEnabled);

  return (
    <div className="admin-page">
      <header className="admin-app-header">
        <div className="admin-app-header-top">
          <h1 className="admin-app-title">Researcher admin</h1>
          <div className="admin-app-header-meta">
            <button type="button" className="secondary small" onClick={() => void refreshData()}>
              Refresh
            </button>
            <button type="button" className="secondary small" onClick={logout}>
              Sign out
            </button>
            <Link to="/study" className="hint">
              Participant page
            </Link>
          </div>
        </div>
        <nav className="admin-app-nav" aria-label="Admin sections">
          <button
            type="button"
            className={adminTab === "sessions" ? "active" : ""}
            onClick={() => {
              setAdminTab("sessions");
              setCollectedReview(null);
            }}
          >
            Sessions
          </button>
          <button
            type="button"
            className={adminTab === "manual" ? "active" : ""}
            onClick={() => {
              setAdminTab("manual");
              setCollectedReview(null);
              setSelectedSessionId(null);
            }}
          >
            Manual pair room
          </button>
          <button
            type="button"
            className={adminTab === "collected" ? "active" : ""}
            onClick={() => {
              setAdminTab("collected");
              setCollectedReview(null);
              setSelectedSessionId(null);
            }}
          >
            Collected sessions (database)
          </button>
        </nav>
      </header>

      {adminTab === "sessions" ? (
        <p className="lead" style={{ marginTop: "0.75rem" }}>
          Pairing sessions use one participant link for many people. Lists refresh every few seconds. Click a session ID to
          open it, then use <strong>Start pairing</strong> when you are ready for matching. Use{" "}
          <strong>Save session to database</strong> to store a snapshot; use <strong>Collect chat</strong> on a finished
          pair to archive that room’s transcript into the session view. After matching has started, pairing rooms appear
          at the bottom of this page.
        </p>
      ) : adminTab === "manual" ? (
        <p className="lead" style={{ marginTop: "0.75rem" }}>
          Manual rooms are one link per pair: create a room, copy the join link for each participant, and collect the chat
          when the conversation is finished.
        </p>
      ) : (
        <p className="lead" style={{ marginTop: "0.75rem" }}>
          Saved session snapshots list what was stored when you used <strong>Save session to database</strong>. Open one
          to review participants and pairs like a live session, or export JSON.
        </p>
      )}

      {!dbConfigured ? (
        <p className="error" style={{ marginBottom: "1rem" }}>
          Database not configured: set <code>DATABASE_URL</code> or link the Clever PostgreSQL add-on. Saving sessions,
          collect chat, and questionnaire export will not work until then.
        </p>
      ) : null}

      {loadError && <p className="error">{loadError}</p>}

      {collectedReview ? (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
              alignItems: "center",
              marginBottom: "1rem",
            }}
          >
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setCollectedReview(null);
                setSessionInspector(null);
              }}
            >
              ← Collected sessions
            </button>
            <h2 style={{ fontSize: "1.1rem", margin: 0, flex: "1 1 12rem" }}>
              {collectedReview.detail?.sessionLabel?.trim() ||
                (collectedReview.detail ? `Session ${collectedReview.detail.sessionId}` : "Saved session")}
            </h2>
            <button
              type="button"
              className="small secondary"
              disabled={!dbConfigured || exportingCollectedId === collectedReview.id}
              onClick={() => void downloadCollectedSessionExport(collectedReview.id)}
            >
              {exportingCollectedId === collectedReview.id ? "…" : "Export JSON"}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Saved row #{collectedReview.id} · Saved {formatShort(new Date(collectedReview.savedAt).getTime())}
            {collectedReview.detail ? (
              <>
                {" "}
                · Session <code>{collectedReview.detail.sessionId}</code>
              </>
            ) : null}
          </p>
          {collectedReview.loading && !collectedReview.detail ? <p className="hint">Loading snapshot…</p> : null}
          {collectedReview.error ? <p className="error">{collectedReview.error}</p> : null}
          {collectedReview.detail ? (
            <SessionParticipantsAndGroupsExplorer
              detail={collectedReview.detail}
              snapshotMode
              sessionInspector={sessionInspector}
              setSessionInspector={setSessionInspector}
              setParticipantChatModal={setParticipantChatModal}
              dbConfigured={dbConfigured}
              collectingId={collectingId}
              collectChat={collectChat}
              copy={copy}
            />
          ) : null}
        </div>
      ) : adminTab === "collected" ? (
        <div className="card admin-table-wrap">
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Collected sessions (database)</h2>
          {collectedSessions.length === 0 ? (
            <p className="hint">No saved sessions yet. Open a live pairing session and use Save session to database.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Session ID</th>
                  <th>Label</th>
                  <th>Saved</th>
                  <th>Participants</th>
                  <th>Groups</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {collectedSessions.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>
                      <code>{row.sessionId}</code>
                    </td>
                    <td>{row.sessionLabel?.trim() || "—"}</td>
                    <td>{formatShort(new Date(row.savedAt).getTime())}</td>
                    <td>{row.participantCount}</td>
                    <td>{row.groupCount}</td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                        <button
                          type="button"
                          className="small"
                          onClick={() => {
                            setCollectedReview({
                              id: row.id,
                              savedAt: row.savedAt,
                              detail: null,
                              loading: true,
                              error: null,
                            });
                            setSessionInspector(null);
                          }}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="small secondary"
                          disabled={!dbConfigured || exportingCollectedId === row.id}
                          onClick={() => void downloadCollectedSessionExport(row.id)}
                        >
                          {exportingCollectedId === row.id ? "…" : "Export"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : adminTab === "sessions" && selectedSessionId ? (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
              alignItems: "center",
              marginBottom: "1rem",
            }}
          >
            <button type="button" className="secondary" onClick={() => setSelectedSessionId(null)}>
              ← Pairing sessions
            </button>
            <h2 style={{ fontSize: "1.1rem", margin: 0, flex: "1 1 12rem" }}>
              {sessionDetail?.sessionLabel?.trim() || `Session ${selectedSessionId}`}
            </h2>
            <button
              type="button"
              className="small secondary"
              onClick={() => void copy(participantSessionUrl(selectedSessionId))}
            >
              Copy participant link
            </button>
            <button
              type="button"
              className="small"
              disabled={
                !sessionDetail?.liveSession ||
                !!sessionDetail?.pairingEnabled ||
                startingSessionId === selectedSessionId
              }
              onClick={() => void startSessionPairing(selectedSessionId, pairingModeDraft)}
            >
              {!sessionDetail?.liveSession
                ? "—"
                : sessionDetail.pairingEnabled
                  ? "Matching started"
                  : startingSessionId === selectedSessionId
                    ? "Starting…"
                    : "Start pairing"}
            </button>
            {!sessionDetail?.pairingEnabled ? (
              <label
                className="small admin-pairing-rule-control"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              >
                Pairing rule
                <select
                  className="admin-select-control"
                  value={pairingModeDraft}
                  onChange={(e) => setPairingModeDraft(e.target.value === "region" ? "region" : "normal")}
                  style={{ minWidth: 180 }}
                >
                  <option value="normal">Normal (ignore region)</option>
                  <option value="region">Match by region</option>
                </select>
              </label>
            ) : (
              <span className="hint">
                Pairing rule: {sessionDetail?.pairingMode === "region" ? "Match by region" : "Normal"}
              </span>
            )}
            <button
              type="button"
              className="small secondary"
              disabled={!dbConfigured || questionnaireExportingSessionId === selectedSessionId}
              onClick={() => void downloadSessionQuestionnaireCsv(selectedSessionId)}
            >
              {questionnaireExportingSessionId === selectedSessionId ? "…" : "Questionnaires CSV"}
            </button>
            <button
              type="button"
              className="small secondary"
              disabled={!dbConfigured || sessionFullExportId === selectedSessionId}
              onClick={() => void downloadSessionFullJson(selectedSessionId)}
            >
              {sessionFullExportId === selectedSessionId ? "…" : "Full export JSON"}
            </button>
            <button
              type="button"
              className="small"
              disabled={!dbConfigured || savingSnapshotSessionId === selectedSessionId}
              onClick={() => void saveSessionToDatabase(selectedSessionId)}
            >
              {savingSnapshotSessionId === selectedSessionId ? "Saving…" : "Save session to database"}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Session ID: <code>{selectedSessionId}</code>
            {sessionDetail?.pairingEnabled ? " · Matching is open for participants." : " · Matching not started yet."}
          </p>
          {sessionDetail?.liveHint ? <p className="hint">{sessionDetail.liveHint}</p> : null}
          {sessionDetailLoading && !sessionDetail ? <p className="hint">Loading session…</p> : null}
          {sessionDetailError ? <p className="error">{sessionDetailError}</p> : null}
          {sessionDetail ? (
            <SessionParticipantsAndGroupsExplorer
              detail={sessionDetail}
              snapshotMode={false}
              sessionInspector={sessionInspector}
              setSessionInspector={setSessionInspector}
              setParticipantChatModal={setParticipantChatModal}
              dbConfigured={dbConfigured}
              collectingId={collectingId}
              collectChat={collectChat}
              copy={copy}
            />
          ) : null}
        </div>
      ) : adminTab === "manual" ? (
        <>
          <div className="card admin-toolbar" style={{ marginTop: "0.75rem" }}>
            <p style={{ margin: "0 0 0.65rem", fontWeight: 600 }}>Create manual pair room</p>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div style={{ flex: 2, minWidth: 200 }}>
                <label htmlFor="new-label">Pair label (optional, private)</label>
                <input
                  id="new-label"
                  type="text"
                  placeholder="e.g. Pair 12 - condition A"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <label htmlFor="new-treatment">Room type</label>
                <select
                  id="new-treatment"
                  value={treatment}
                  onChange={(e) => setTreatment(e.target.value as Treatment)}
                >
                  <option value="human_only">Human chat only</option>
                  <option value="llm_enabled">Chat + @LLM assistant</option>
                </select>
              </div>
              <button type="button" onClick={() => void createRoom()} disabled={creating}>
                {creating ? "Creating…" : "Create room"}
              </button>
            </div>
          </div>
          <AdminActiveRoomsTable
            rooms={manualRoomRows}
            emptyHint="No manual rooms yet. Create one above."
            dbConfigured={dbConfigured}
            collectingId={collectingId}
            collectChat={collectChat}
            copy={copy}
          />
        </>
      ) : (
        <>
          <div className="card admin-table-wrap" style={{ marginTop: "0.75rem" }}>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.75rem",
              }}
            >
              <h2 style={{ fontSize: "1rem", margin: 0 }}>Pairing sessions</h2>
              <button type="button" onClick={() => setShowNewSessionForm((v) => !v)}>
                {showNewSessionForm ? "Hide new session" : "New pairing session"}
              </button>
            </div>
            {showNewSessionForm ? (
              <div className="admin-new-session-block" style={{ marginBottom: "1rem" }}>
                <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>New pairing session</p>
                <p className="hint" style={{ marginTop: 0 }}>
                  Share the participant link with everyone. Wait until people are on the page if you like, then start
                  matching. Waiting = in queue for a partner (not yet placed in a chat room).
                </p>
                <div className="row" style={{ alignItems: "flex-end", marginTop: "0.5rem" }}>
                  <div style={{ flex: 2, minWidth: 200 }}>
                    <label htmlFor="session-label">Session label (optional, for your records)</label>
                    <input
                      id="session-label"
                      type="text"
                      placeholder="e.g. Lab batch April 10"
                      value={sessionLabel}
                      onChange={(e) => setSessionLabel(e.target.value)}
                    />
                  </div>
                  <button type="button" onClick={() => void createPairingSession()} disabled={creatingSession}>
                    {creatingSession ? "Creating…" : "Create"}
                  </button>
                </div>
              </div>
            ) : null}
            {sessions.length === 0 ? (
              <p className="hint">No sessions yet. Create one above to get a participant link.</p>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Session ID</th>
                    <th>Participants</th>
                    <th>Waiting to pair</th>
                    <th>Participant link</th>
                    <th>Full export</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td>{s.label || "-"}</td>
                      <td>
                        <button
                          type="button"
                          title="Open session"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            font: "inherit",
                            textAlign: "left",
                            color: "inherit",
                          }}
                          onClick={() => {
                            setCollectedReview(null);
                            setSelectedSessionId(s.sessionId);
                          }}
                        >
                          <code style={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>{s.sessionId}</code>
                        </button>
                      </td>
                      <td>{s.participantCount ?? "—"}</td>
                      <td>
                        {(s.waitingParticipants ?? []).length === 0 ? (
                          "—"
                        ) : (
                          <ul style={{ margin: 0, paddingLeft: "1.2rem", maxWidth: "14rem" }}>
                            {(s.waitingParticipants ?? []).map((w) => (
                              <li key={w.ticket}>
                                {w.displayName}
                                <span className="hint" style={{ fontSize: "0.78rem" }}>
                                  {" "}
                                  · {w.region?.trim() || "Unknown"}
                                </span>
                                <span className="hint" style={{ fontSize: "0.78rem" }}>
                                  {" "}
                                  · since {formatShort(w.waitingSince)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="small secondary"
                          onClick={() => void copy(participantSessionUrl(s.sessionId))}
                        >
                          Copy link
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="small secondary"
                          disabled={!dbConfigured || sessionFullExportId === s.sessionId}
                          onClick={() => void downloadSessionFullJson(s.sessionId)}
                          title="Names, pairing, q1–q5, chat transcripts, exit survey — JSON"
                        >
                          {sessionFullExportId === s.sessionId ? "…" : "JSON"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {pairingEverStarted ? (
            <AdminActiveRoomsTable
              rooms={pairingSessionRoomRows}
              emptyHint="No pairing rooms yet. They appear here when participants are matched into dyads."
              dbConfigured={dbConfigured}
              collectingId={collectingId}
              collectChat={collectChat}
              copy={copy}
            />
          ) : null}
        </>
      )}

      {participantChatModal ? (
        <div
          className="admin-modal-backdrop"
          onClick={() => setParticipantChatModal(null)}
          role="presentation"
          aria-hidden={false}
        >
          <div
            className="admin-modal admin-modal-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="participant-chat-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-header">
              <h3 id="participant-chat-modal-title">{participantChatModal.title}</h3>
              <button type="button" className="small secondary" onClick={() => setParticipantChatModal(null)}>
                Close
              </button>
            </div>
            <div className="admin-modal-body">
              <AdminColoredTranscript messages={participantChatModal.messages} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
