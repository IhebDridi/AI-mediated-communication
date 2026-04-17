import { useEffect, useRef } from "react";

const INTERVAL_MS = 4000;

/**
 * Periodically reports the participant's current UI step to the server (for the researcher dashboard).
 * No-ops until `margarita.session.<id>.participantId` exists in sessionStorage.
 */
export function useSessionPresenceReport(opts: {
  sessionId: string | null | undefined;
  phase: string;
  displayName?: string;
  region?: string;
  matchTicket?: string | null;
  enabled?: boolean;
}) {
  const { sessionId, phase, displayName = "", region = "", matchTicket = null, enabled = true } = opts;
  const pidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    try {
      pidRef.current = sessionStorage.getItem(`margarita.session.${sessionId}.participantId`);
    } catch {
      pidRef.current = null;
    }
  }, [sessionId, enabled, phase]);

  useEffect(() => {
    if (!sessionId || !enabled) return;

    const run = () => {
      let participantPublicId = pidRef.current;
      if (!participantPublicId) {
        try {
          participantPublicId = sessionStorage.getItem(`margarita.session.${sessionId}.participantId`);
          pidRef.current = participantPublicId;
        } catch {
          return;
        }
      }
      if (!participantPublicId) return;

      let name = displayName.trim();
      if (!name) {
        try {
          name = sessionStorage.getItem(`margarita.session.${sessionId}.displayName`)?.trim() ?? "";
        } catch {
          /* ignore */
        }
      }

      let regionValue = region.trim();
      if (!regionValue) {
        try {
          regionValue = sessionStorage.getItem(`margarita.session.${sessionId}.region`)?.trim() ?? "";
        } catch {
          /* ignore */
        }
      }

      void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantPublicId,
          phase,
          displayName: name || undefined,
          region: regionValue || undefined,
          matchTicket: matchTicket || undefined,
        }),
      }).catch(() => {});
    };

    run();
    const id = window.setInterval(run, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [sessionId, phase, displayName, region, matchTicket, enabled]);
}
