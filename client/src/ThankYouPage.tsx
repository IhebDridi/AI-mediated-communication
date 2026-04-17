import { useSearchParams } from "react-router-dom";
import { useSessionPresenceReport } from "./useSessionPresenceReport";

export function ThankYouPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session")?.trim().toLowerCase() || "";

  useSessionPresenceReport({
    sessionId: sessionId || null,
    phase: "thank_you",
    enabled: !!sessionId,
  });

  return (
    <div className="card" style={{ marginTop: "2rem", textAlign: "center" }}>
      <h1 style={{ marginBottom: "0.75rem" }}>Thank you</h1>
      <p className="lead" style={{ margin: 0 }}>
        Thank you for taking part. You can close this window.
      </p>
    </div>
  );
}
