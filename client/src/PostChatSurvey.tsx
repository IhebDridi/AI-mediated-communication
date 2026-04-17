import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSessionPresenceReport } from "./useSessionPresenceReport";

export function PostChatSurvey() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session")?.trim().toLowerCase() || "";
  const navigate = useNavigate();
  const [age, setAge] = useState("");
  const [work, setWork] = useState("");
  const [feedback, setFeedback] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useSessionPresenceReport({
    sessionId: sessionId || null,
    phase: "after_chat",
    enabled: !!sessionId,
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!sessionId) {
      setErr("Missing session.");
      return;
    }
    let pid: string | null = null;
    let name: string | null = null;
    try {
      pid = sessionStorage.getItem(`margarita.session.${sessionId}.participantId`);
      name = sessionStorage.getItem(`margarita.session.${sessionId}.displayName`);
    } catch {
      setErr("Could not read saved session data.");
      return;
    }
    if (!pid || !name?.trim()) {
      setErr("Session data missing. Close this window and open your study link again from the start.");
      return;
    }
    if (!age.trim() || !work.trim()) {
      setErr("Please enter your age and work / occupation.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/exit-survey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantPublicId: pid,
          displayName: name.trim(),
          age: age.trim(),
          work: work.trim(),
          feedback: feedback.trim() || "(none)",
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Could not save your responses.");
      }
      navigate(`/thankyou?session=${encodeURIComponent(sessionId)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  if (!sessionId) {
    return (
      <div className="card" style={{ marginTop: "1rem" }}>
        <h1>Study</h1>
        <p className="error">This page needs a valid session link. Please use the URL you were given.</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h1>Almost done</h1>
      <p className="lead">Please answer a few final questions. Your responses are saved for the research team.</p>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label htmlFor="post-age">Age</label>
        <input
          id="post-age"
          type="text"
          autoComplete="bday-year"
          maxLength={64}
          placeholder="e.g. 32"
          value={age}
          onChange={(e) => setAge(e.target.value)}
        />
        <div style={{ height: "0.75rem" }} />
        <label htmlFor="post-work">Work or occupation</label>
        <input
          id="post-work"
          type="text"
          maxLength={2000}
          placeholder="Brief description"
          value={work}
          onChange={(e) => setWork(e.target.value)}
        />
        <div style={{ height: "0.75rem" }} />
        <label htmlFor="post-feedback">Feedback (optional)</label>
        <textarea
          id="post-feedback"
          rows={4}
          maxLength={2000}
          placeholder="Your feedback…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          style={{
            width: "100%",
            font: "inherit",
            padding: "0.55rem 0.65rem",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            resize: "vertical",
          }}
        />
        {err ? <p className="error">{err}</p> : null}
        <div style={{ marginTop: "0.75rem" }}>
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Submit and finish"}
          </button>
        </div>
      </form>
    </div>
  );
}
