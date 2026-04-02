import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

const STORAGE_KEY = "margarita_admin_secret";

type Treatment = "human_only" | "llm_enabled";

type RoomRow = {
  roomId: string;
  treatment: Treatment;
  label: string | null;
  occupantCount: number;
  messageCount: number;
};

function participantJoinUrl(roomId: string): string {
  const u = new URL(window.location.href);
  const path = u.pathname.replace(/\/admin\/?$/, "") || "/";
  u.pathname = path;
  u.search = "";
  u.hash = "";
  u.searchParams.set("room", roomId);
  return u.toString();
}

export function AdminApp() {
  const [secret, setSecret] = useState(() => sessionStorage.getItem(STORAGE_KEY) || "");
  const [secretInput, setSecretInput] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [treatment, setTreatment] = useState<Treatment>("human_only");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const authHeaders = useCallback((): HeadersInit => {
    const s = secret.trim();
    return s ? { Authorization: `Bearer ${s}` } : {};
  }, [secret]);

  const refreshRooms = useCallback(async () => {
    setLoadError(null);
    const res = await fetch("/api/admin/rooms", { headers: authHeaders() });
    if (res.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      setSecret("");
      setAuthorized(false);
      setLoadError("Invalid or missing admin secret.");
      return;
    }
    if (!res.ok) {
      setLoadError("Could not load rooms.");
      return;
    }
    const data = (await res.json()) as { rooms?: RoomRow[] };
    setRooms(data.rooms ?? []);
    setAuthorized(true);
    sessionStorage.setItem(STORAGE_KEY, secret.trim());
  }, [authHeaders, secret]);

  useEffect(() => {
    if (secret.trim()) {
      void refreshRooms();
    }
  }, []);

  const login = async () => {
    const s = secretInput.trim();
    setSecret(s);
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
    sessionStorage.setItem(STORAGE_KEY, s);
    setSecret(s);
    const data = (await res.json()) as { rooms?: RoomRow[] };
    setRooms(data.rooms ?? []);
    setAuthorized(true);
  };

  const logout = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSecret("");
    setSecretInput("");
    setAuthorized(false);
    setRooms([]);
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
      await refreshRooms();
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copy:", text);
    }
  };

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
        Each row is one pair: send <strong>the same link</strong> to both participants. Use labels to track your design
        (only you see them).
      </p>

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
        {loadError && <p className="error">{loadError}</p>}
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="secondary small" onClick={() => void refreshRooms()}>
            Refresh list
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
                <th>People</th>
                <th>Messages</th>
                <th>Join link</th>
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
                    {r.occupantCount}/2
                  </td>
                  <td>{r.messageCount}</td>
                  <td>
                    <button type="button" className="small secondary" onClick={() => void copy(participantJoinUrl(r.roomId))}>
                      Copy link
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
