import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MessageBody } from "./MessageBody";

const STORAGE_KEY = "margarita_admin_secret";

type Treatment = "human_only" | "llm_enabled";

type RoomRow = {
  roomId: string;
  treatment: Treatment;
  label: string | null;
  occupantCount: number;
  messageCount: number;
  p1Active: boolean;
  p2Active: boolean;
  p1VoluntaryExitAt: number | null;
  p2VoluntaryExitAt: number | null;
};

type ArchiveRow = {
  id: number;
  room_id: string;
  treatment: string;
  label: string | null;
  archived_at: string;
  message_count: number;
};

type ChatMessage = {
  id: string;
  slot: "p1" | "p2" | "llm";
  authorLabel: string;
  text: string;
  ts: number;
};

type ArchiveDetail = {
  id: number;
  room_id: string;
  treatment: string;
  label: string | null;
  archived_at: string;
  messages: unknown;
  p1_voluntary_exit_ms: number | null;
  p2_voluntary_exit_ms: number | null;
  p1_connected_at_archive: boolean;
  p2_connected_at_archive: boolean;
};

function normalizeArchiveMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    const slot = o.slot === "p1" || o.slot === "p2" || o.slot === "llm" ? o.slot : "p1";
    out.push({
      id: typeof o.id === "string" ? o.id : "",
      slot,
      authorLabel: typeof o.authorLabel === "string" ? o.authorLabel : "",
      text: o.text,
      ts: typeof o.ts === "number" ? o.ts : 0,
    });
  }
  return out;
}

function participantJoinUrl(roomId: string): string {
  const u = new URL(window.location.href);
  const path = u.pathname.replace(/\/admin\/?$/, "") || "/";
  u.pathname = path;
  u.search = "";
  u.hash = "";
  u.searchParams.set("room", roomId);
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

function ArchiveTranscriptBody({ archive }: { archive: ArchiveDetail }) {
  const archivedMsgs = normalizeArchiveMessages(archive.messages);
  return (
    <>
      <p className="hint" style={{ marginTop: 0, marginBottom: "0.75rem" }}>
        P1 voluntary exit:{" "}
        {archive.p1_voluntary_exit_ms ? formatShort(archive.p1_voluntary_exit_ms) : "—"} · P2:{" "}
        {archive.p2_voluntary_exit_ms ? formatShort(archive.p2_voluntary_exit_ms) : "—"} · Connected at collect: P1{" "}
        {archive.p1_connected_at_archive ? "yes" : "no"}, P2 {archive.p2_connected_at_archive ? "yes" : "no"}
      </p>
      <div className="messages" aria-live="polite">
        {archivedMsgs.length === 0 ? (
          <p className="hint">No messages in this archive.</p>
        ) : (
          archivedMsgs.map((m, i) => (
            <div
              key={m.id || `arch-msg-${i}`}
              className={`msg${m.slot === "llm" ? " llm" : ""}`}
            >
              <div className="msg-meta">
                {m.authorLabel} · {formatTime(m.ts)}
              </div>
              <MessageBody text={m.text} />
            </div>
          ))
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
  const [archives, setArchives] = useState<ArchiveRow[]>([]);
  const [dbConfigured, setDbConfigured] = useState(false);
  const [treatment, setTreatment] = useState<Treatment>("human_only");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [viewArchiveId, setViewArchiveId] = useState<number | null>(null);
  const [archiveDetail, setArchiveDetail] = useState<ArchiveDetail | null>(null);
  const [archiveDetailLoading, setArchiveDetailLoading] = useState(false);
  const [archiveDetailError, setArchiveDetailError] = useState<string | null>(null);
  const [csvExportingId, setCsvExportingId] = useState<number | null>(null);

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
      const [resRooms, resArch] = await Promise.all([
        fetch("/api/admin/rooms", { headers }),
        fetch("/api/admin/archives", { headers }),
      ]);
    if (resRooms.status === 401) {
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
    const dataRooms = (await resRooms.json()) as { rooms?: RoomRow[]; dbConfigured?: boolean };
    setRooms(dataRooms.rooms ?? []);
    setDbConfigured(!!dataRooms.dbConfigured);
    setAuthorized(true);
    const store = (tokenOverride ?? secret).trim();
    if (store) sessionStorage.setItem(STORAGE_KEY, store);

    if (resArch.ok) {
      const dataArch = (await resArch.json()) as { archives?: ArchiveRow[] };
      setArchives(dataArch.archives ?? []);
    }
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
    setArchives([]);
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

  const closeArchiveModal = useCallback(() => {
    setViewArchiveId(null);
    setArchiveDetail(null);
    setArchiveDetailError(null);
    setArchiveDetailLoading(false);
  }, []);

  const openArchiveModal = useCallback(
    async (id: number) => {
      setViewArchiveId(id);
      setArchiveDetail(null);
      setArchiveDetailError(null);
      setArchiveDetailLoading(true);
      try {
        const res = await fetch(`/api/admin/archives/${id}`, { headers: authHeaders() });
        if (res.status === 401) {
          closeArchiveModal();
          setAuthorized(false);
          setLoadError("Invalid or missing admin secret.");
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setArchiveDetailError(j.error || "Could not load transcript.");
          return;
        }
        const data = (await res.json()) as { archive?: ArchiveDetail };
        if (!data.archive) {
          setArchiveDetailError("Invalid response.");
          return;
        }
        setArchiveDetail(data.archive);
      } catch {
        setArchiveDetailError("Network error.");
      } finally {
        setArchiveDetailLoading(false);
      }
    },
    [authHeaders, closeArchiveModal],
  );

  const downloadArchiveCsv = useCallback(
    async (id: number) => {
      setCsvExportingId(id);
      setLoadError(null);
      try {
        const res = await fetch(`/api/admin/archives/${id}/csv`, { headers: authHeaders() });
        if (res.status === 401) {
          setAuthorized(false);
          setLoadError("Invalid or missing admin secret.");
          return;
        }
        if (!res.ok) {
          const t = await res.text();
          setLoadError(t || "CSV export failed.");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `margarita-archive-${id}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setLoadError("CSV export failed.");
      } finally {
        setCsvExportingId(null);
      }
    },
    [authHeaders],
  );

  useEffect(() => {
    if (viewArchiveId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeArchiveModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewArchiveId, closeArchiveModal]);

  if (!authorized) {
    return (
      <div className="admin-page">
        <h1>Researcher admin</h1>
        <p className="lead">Create chat rooms and copy join links for each pair. This page is not shown to participants.</p>
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
          <Link to="/">Back to participant chat</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <h1>Researcher admin</h1>
      <p className="lead">
        Each row is one pair: send <strong>the same link</strong> to both participants. The list refreshes every few seconds so
        you can see who is connected and who used <strong>Finish and leave</strong>. When a session is done, use{" "}
        <strong>Collect chat</strong> to save the full transcript to the database (Clever PostgreSQL); that closes the room.
      </p>

      {!dbConfigured ? (
        <p className="error" style={{ marginBottom: "1rem" }}>
          Database not configured: set <code>DATABASE_URL</code> or link the Clever PostgreSQL add-on. Collect chat will not work
          until then.
        </p>
      ) : null}

      {loadError && <p className="error">{loadError}</p>}

      <div className="card admin-toolbar">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 2, minWidth: 200 }}>
            <label htmlFor="new-label">Pair label (optional, private)</label>
            <input
              id="new-label"
              type="text"
              placeholder="e.g. Pair 12 — condition A"
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
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="secondary small" onClick={() => void refreshData()}>
            Refresh now
          </button>
          <button type="button" className="secondary small" onClick={logout}>
            Sign out
          </button>
          <Link to="/" className="hint" style={{ alignSelf: "center" }}>
            Participant page
          </Link>
        </div>
      </div>

      <div className="card admin-table-wrap">
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Active rooms</h2>
        {rooms.length === 0 ? (
          <p className="hint">No rooms yet. Create one above.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Type</th>
                <th>Code</th>
                <th>P1</th>
                <th>P2</th>
                <th>Msgs</th>
                <th>Join link</th>
                <th>Collect</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.roomId}>
                  <td>{r.label || "—"}</td>
                  <td>{r.treatment === "llm_enabled" ? "Chat + @LLM" : "Human only"}</td>
                  <td>
                    <code>{r.roomId}</code>
                  </td>
                  <td>
                    <SlotStatus active={r.p1Active} voluntaryAt={r.p1VoluntaryExitAt} />
                  </td>
                  <td>
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

      <div className="card admin-table-wrap" style={{ marginTop: "1rem" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Collected transcripts (database)</h2>
        {archives.length === 0 ? (
          <p className="hint">No rows yet. Collected chats appear here.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Room</th>
                <th>Label</th>
                <th>Type</th>
                <th>Messages</th>
                <th>Archived</th>
                <th>Transcript</th>
              </tr>
            </thead>
            <tbody>
              {archives.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>
                    <code>{a.room_id}</code>
                  </td>
                  <td>{a.label || "—"}</td>
                  <td>{a.treatment === "llm_enabled" ? "Chat + @LLM" : "Human only"}</td>
                  <td>{a.message_count}</td>
                  <td>{formatShort(new Date(a.archived_at).getTime())}</td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                      <button
                        type="button"
                        className="small secondary"
                        onClick={() => void openArchiveModal(a.id)}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="small secondary"
                        disabled={csvExportingId === a.id}
                        onClick={() => void downloadArchiveCsv(a.id)}
                      >
                        {csvExportingId === a.id ? "CSV…" : "CSV"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewArchiveId !== null ? (
        <div
          className="admin-modal-backdrop"
          onClick={closeArchiveModal}
          role="presentation"
          aria-hidden={false}
        >
          <div
            className="admin-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-header">
              <div>
                <h3 id="archive-modal-title">Collected transcript</h3>
                {archiveDetail ? (
                  <p className="admin-modal-meta">
                    <code>{archiveDetail.room_id}</code>
                    {archiveDetail.label ? ` · ${archiveDetail.label}` : ""} ·{" "}
                    {archiveDetail.treatment === "llm_enabled" ? "Chat + @LLM" : "Human only"} ·{" "}
                    {formatShort(new Date(archiveDetail.archived_at).getTime())}
                  </p>
                ) : (
                  <p className="admin-modal-meta">Archive #{viewArchiveId}</p>
                )}
              </div>
              <button type="button" className="small secondary" onClick={closeArchiveModal}>
                Close
              </button>
            </div>
            <div className="admin-modal-actions">
              <button
                type="button"
                className="small secondary"
                disabled={csvExportingId === viewArchiveId}
                onClick={() => void downloadArchiveCsv(viewArchiveId)}
              >
                {csvExportingId === viewArchiveId ? "Downloading…" : "Download CSV"}
              </button>
            </div>
            <div className="admin-modal-body">
              {archiveDetailLoading ? <p className="hint">Loading…</p> : null}
              {archiveDetailError ? <p className="error">{archiveDetailError}</p> : null}
              {archiveDetail && !archiveDetailLoading ? (
                <ArchiveTranscriptBody archive={archiveDetail} />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
