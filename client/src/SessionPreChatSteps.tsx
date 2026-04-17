import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useSessionPresenceReport } from "./useSessionPresenceReport";

export type SessionStep = "intro" | "questions" | "instructions";

type QuestionnaireItem = {
  id: string;
  prompt: string;
  options?: string[];
};

function storageKey(sessionId: string, part: string) {
  return `margarita.session.${sessionId}.${part}`;
}

function readStep(sessionId: string): SessionStep {
  const raw = sessionStorage.getItem(storageKey(sessionId, "step"));
  if (raw === "questions" || raw === "instructions") {
    const pid = sessionStorage.getItem(storageKey(sessionId, "participantId"));
    if (!pid) return "intro";
    return raw;
  }
  return "intro";
}

const INSTRUCTION_PARAGRAPHS = [
  "You will chat with another participant in real time. Please be respectful and follow any rules given by your panel or the researchers.",
  "Your messages may be saved for research. Do not share personal information you are not comfortable having recorded.",
  "When you are ready to find a partner, use the button below. You will be matched with someone else who is also ready at that moment.",
];

type PreJoinRoomFetch =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; occupantCount: number }
  | { status: "missing" }
  | { status: "error" };

type ManualRoomProps = {
  roomId: string;
  setRoomId: (v: string) => void;
  roomFromUrl: string;
  preJoinRoom: PreJoinRoomFetch;
  joinRoom: (explicitRoomId?: string) => void;
  joinError: string | null;
};

type Props = {
  sessionId: string;
  sessionPairingEnabled: boolean | null;
  sessionFetchState: "idle" | "ok" | "notfound";
  displayName: string;
  setDisplayName: Dispatch<SetStateAction<string>>;
  region: string;
  setRegion: Dispatch<SetStateAction<string>>;
  matchWaiting: boolean;
  queueTicket: string | null;
  matchError: string | null;
  startMatchmaking: (region: string) => void | Promise<void>;
  manualRoom: ManualRoomProps;
};

function preJoinPeopleLine(preJoinRoom: PreJoinRoomFetch) {
  if (preJoinRoom.status === "idle") return null;
  if (preJoinRoom.status === "loading") return "Checking room…";
  if (preJoinRoom.status === "missing")
    return "That code was not found. Check the link or code you were given.";
  if (preJoinRoom.status === "error") return "Could not load room status.";
  const n = preJoinRoom.occupantCount;
  if (n === 0) return "No one else is connected yet - your partner can use the same code.";
  if (n === 1) return "One other person is already in this room.";
  return "This room may already be full (two people).";
}

export function SessionPreChatSteps({
  sessionId,
  sessionPairingEnabled,
  sessionFetchState,
  displayName,
  setDisplayName,
  region,
  setRegion,
  matchWaiting,
  queueTicket,
  matchError,
  startMatchmaking,
  manualRoom,
}: Props) {
  const [step, setStep] = useState<SessionStep>(() => readStep(sessionId));
  const [questions, setQuestions] = useState<QuestionnaireItem[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const presencePhase = useMemo(() => {
    if (step === "intro") return "intro";
    if (step === "questions") return "questions";
    if (matchWaiting || queueTicket) return "queue";
    return "instructions";
  }, [step, matchWaiting, queueTicket]);

  useSessionPresenceReport({
    sessionId,
    phase: presencePhase,
    displayName,
    region,
    matchTicket: queueTicket,
    enabled: true,
  });

  useEffect(() => {
    const savedName = sessionStorage.getItem(storageKey(sessionId, "displayName"));
    if (savedName) setDisplayName((d) => (d.trim() ? d : savedName));
    const savedRegion = sessionStorage.getItem(storageKey(sessionId, "region"));
    if (savedRegion) setRegion((r) => (r.trim() ? r : savedRegion));
  }, [sessionId, setDisplayName, setRegion]);

  useEffect(() => {
    setStep(readStep(sessionId));
  }, [sessionId]);

  const ensureParticipantId = useCallback(() => {
    const key = storageKey(sessionId, "participantId");
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  }, [sessionId]);

  const onConfirmIntro = useCallback(() => {
    const name = displayName.trim();
    if (!name) return;
    if (name.length > 80) return;
    ensureParticipantId();
    sessionStorage.setItem(storageKey(sessionId, "displayName"), name);
    sessionStorage.setItem(storageKey(sessionId, "step"), "questions");
    setStep("questions");
  }, [displayName, ensureParticipantId, sessionId]);

  useEffect(() => {
    if (step !== "questions") return;
    const participantPublicId = sessionStorage.getItem(storageKey(sessionId, "participantId"));
    if (!participantPublicId) {
      setQuestionsError("Session expired. Please refresh and enter your name again.");
      return;
    }
    let cancelled = false;
    setQuestionsLoading(true);
    setQuestionsError(null);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questionnaire`)
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || "Could not load questions.");
        }
        return r.json() as Promise<{ questions?: QuestionnaireItem[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        const qs = data.questions ?? [];
        setQuestions(qs);
        const init: Record<string, string> = {};
        for (const q of qs) init[q.id] = "";
        setAnswers(init);
      })
      .catch((e: unknown) => {
        if (!cancelled) setQuestionsError(e instanceof Error ? e.message : "Load failed.");
      })
      .finally(() => {
        if (!cancelled) setQuestionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, sessionId]);

  useEffect(() => {
    if (step !== "instructions") return;
    const n = sessionStorage.getItem(storageKey(sessionId, "displayName"));
    if (n) setDisplayName(n);
  }, [step, sessionId, setDisplayName]);

  const onSubmitQuestions = useCallback(async () => {
    const participantPublicId = sessionStorage.getItem(storageKey(sessionId, "participantId"));
    const name = (sessionStorage.getItem(storageKey(sessionId, "displayName")) || displayName).trim();
    if (!participantPublicId || !name) {
      setSubmitError("Session data missing. Go back and confirm your name.");
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questionnaire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantPublicId,
          displayName: name,
          answers,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Could not save answers.");
      }
      sessionStorage.setItem(storageKey(sessionId, "step"), "instructions");
      setStep("instructions");
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSubmitting(false);
    }
  }, [answers, displayName, sessionId]);

  const sessionStrip = (
    <div className="session-strip" style={{ marginBottom: "1rem" }} aria-live="polite">
      <div className="session-strip-row">
        <span className="session-strip-label">Study session</span>
        <span className="session-strip-value">{sessionId}</span>
      </div>
      <div className="session-strip-row">
        <span className="session-strip-label">Matching</span>
        <span className="session-strip-people">
          {sessionFetchState === "notfound"
            ? "This session link is not valid."
            : sessionPairingEnabled === null
              ? "Checking…"
              : sessionPairingEnabled
                ? "Open — you can find a partner."
                : "Not open yet — please wait for the researcher."}
        </span>
      </div>
    </div>
  );

  if (step === "intro") {
    return (
      <>
        <h1>Study chat</h1>
        <p className="lead">
          Use the study link you opened: when matching is open, you can enter the queue for a partner. Keep this page open.
        </p>
        {sessionStrip}
        <div className="card" style={{ marginBottom: "1rem" }}>
          <label htmlFor="session-name">Your name (required)</label>
          <input
            id="session-name"
            type="text"
            autoComplete="name"
            maxLength={80}
            placeholder="Enter the name shown to the researcher"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <p className="hint" style={{ marginBottom: "0.75rem" }}>
            This name appears in the researcher dashboard and next to your messages in chat.
          </p>
          <button type="button" disabled={!displayName.trim()} onClick={onConfirmIntro}>
            Continue
          </button>
        </div>
      </>
    );
  }

  if (step === "questions") {
    return (
      <>
        <h1>Study chat</h1>
        <p className="lead">Please answer the following questions.</p>
        {sessionStrip}
        <div className="card">
          {questionsLoading ? <p className="hint">Loading questions…</p> : null}
          {questionsError ? <p className="error">{questionsError}</p> : null}
          {!questionsLoading && !questionsError && questions.length === 0 ? (
            <p className="error">No questions were returned.</p>
          ) : null}
          {questions.map((q) => (
            <div key={q.id} style={{ marginBottom: "1.1rem" }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: "0.35rem" }} htmlFor={`q-${q.id}`}>
                {q.prompt}
              </label>
              {q.options ? (
                <select
                  id={`q-${q.id}`}
                  style={{
                    width: "100%",
                    padding: "0.5rem 0.55rem",
                    borderRadius: "8px",
                    border: "1px solid var(--border)",
                    font: "inherit",
                  }}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                >
                  <option value="">Choose…</option>
                  {q.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`q-${q.id}`}
                  type="text"
                  maxLength={2000}
                  placeholder="Your answer"
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  style={{ width: "100%" }}
                />
              )}
            </div>
          ))}
          {submitError ? <p className="error">{submitError}</p> : null}
          <button
            type="button"
            style={{ marginTop: "0.5rem" }}
            disabled={
              submitting ||
              questionsLoading ||
              questions.some((q) => !(answers[q.id] ?? "").trim())
            }
            onClick={() => void onSubmitQuestions()}
          >
            {submitting ? "Saving…" : "Continue to instructions"}
          </button>
        </div>
      </>
    );
  }

  const { roomId, setRoomId, roomFromUrl, preJoinRoom, joinRoom, joinError } = manualRoom;

  return (
    <>
      <h1>Study chat</h1>
      <p className="lead">Please read the instructions below. When you are ready, you can join the chat queue.</p>
      {sessionStrip}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>Instructions</p>
        {INSTRUCTION_PARAGRAPHS.map((p, i) => (
          <p key={i} className="hint" style={{ marginTop: "0.5rem" }}>
            {p}
          </p>
        ))}
      </div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>Match with another participant</p>
        <label htmlFor="session-region">Region or country</label>
        <input
          id="session-region"
          type="text"
          maxLength={64}
          placeholder="e.g. USA, Germany"
          value={region}
          onChange={(e) => {
            const v = e.target.value;
            setRegion(v);
            sessionStorage.setItem(storageKey(sessionId, "region"), v);
          }}
          style={{ marginBottom: "0.5rem" }}
        />
        <p className="hint" style={{ marginTop: 0 }}>
          When someone else enters at the same time, you will be placed in a chat together (two people per room). You can
          open the chat as soon as you are ready; you do not need to wait for everyone else in the study.
        </p>
        {matchError ? <p className="error">{matchError}</p> : null}
        <div style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            disabled={
              matchWaiting ||
              sessionFetchState === "notfound" ||
              sessionPairingEnabled !== true ||
              !displayName.trim() ||
              !region.trim()
            }
            onClick={() => void startMatchmaking(region.trim())}
          >
            {matchWaiting ? (queueTicket ? "Waiting for partner…" : "Starting…") : "Enter chat queue"}
          </button>
        </div>
      </div>
      {roomId.trim() ? (
        <div className="session-strip" aria-live="polite" style={{ marginBottom: "1rem" }}>
          <div className="session-strip-row">
            <span className="session-strip-label">Room code</span>
            <span className="session-strip-value">{roomId.trim().toLowerCase()}</span>
          </div>
          <div className="session-strip-row">
            <span className="session-strip-label">People inside</span>
            <span className="session-strip-people">{preJoinPeopleLine(preJoinRoom)}</span>
          </div>
        </div>
      ) : null}
      <div className="card">
        {!roomFromUrl ? (
          <p className="hint" style={{ marginTop: 0, marginBottom: "0.65rem", fontWeight: 600 }}>
            Or join with a direct room code
          </p>
        ) : null}
        <label htmlFor="session-room">Room code</label>
        <input
          id="session-room"
          type="text"
          autoComplete="off"
          placeholder="e.g. abcd-efgh"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
        />
        {joinError ? <p className="error">{joinError}</p> : null}
        <div style={{ marginTop: "0.75rem" }}>
          <button type="button" disabled={!displayName.trim()} onClick={() => joinRoom()}>
            Join room
          </button>
        </div>
      </div>
    </>
  );
}
