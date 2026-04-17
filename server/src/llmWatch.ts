import { nanoid } from "nanoid";
import { Mistral } from "@mistralai/mistralai";
import type { Server } from "socket.io";

export type ParticipantSlot = "p1" | "p2";

export type ChatMessage = {
  id: string;
  slot: ParticipantSlot | "llm";
  authorLabel: string;
  text: string;
  ts: number;
};

export type Room = {
  treatment: "human_only" | "llm_enabled";
  messages: ChatMessage[];
  slots: Partial<Record<ParticipantSlot, string>>;
  /** Optional researcher note (admin only, not shown to participants). */
  label?: string;
  /** Set for rooms created from a pairing session (admin export). */
  sessionId?: string;
  /** Names from join (admin dashboard). */
  participantNames?: Partial<Record<ParticipantSlot, string>>;
  /** Client-generated ids from session flow (pairing session). */
  participantPublicIds?: Partial<Record<ParticipantSlot, string>>;
  llmTail: Promise<void>;
  /** When each participant clicked “Finish and leave” (ms since epoch). */
  voluntaryExit: Partial<Record<ParticipantSlot, number>>;
};

const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";

const SYSTEM_PROMPT = `You are a neutral assistant present in a two-person research chat. You only speak when someone tags you with @LLM at the start of their message.
You see the full conversation so far (participant messages are labeled). Help with whatever they ask: translation, summaries, explanations, structuring ideas, light moderation suggestions, etc.
Keep answers concise unless they ask for detail. Do not pretend to be either participant. If the request is unclear, ask a brief clarifying question.`;

export const LLM_TAG = /^\s*@LLM\b/i;

export function stripLlmTag(text: string): string {
  return text.replace(/^\s*@LLM\s*/i, "").trim();
}

function toMistralMessages(history: ChatMessage[]) {
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const m of history) {
    if (m.slot === "llm") {
      out.push({ role: "assistant", content: m.text });
    } else {
      out.push({ role: "user", content: `${m.authorLabel}: ${m.text}` });
    }
  }
  return out;
}

function mistralAuthFailureMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b401\b/.test(msg) || /Unauthorized/i.test(msg)) {
    return "[Assistant unavailable: the AI service rejected the server key. Ask the researcher to check MISTRAL_API_KEY in server/.env and restart the server.]";
  }
  return null;
}

export async function runMistral(historyIncludingTrigger: ChatMessage[]): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) {
    return "[Assistant unavailable: set MISTRAL_API_KEY on the server.]";
  }
  const mistral = new Mistral({ apiKey });
  const messages = toMistralMessages(historyIncludingTrigger);
  try {
    const res = await mistral.chat.complete({
      model: MISTRAL_MODEL,
      messages,
      temperature: 0.5,
    });
    const choice = res.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => ("text" in c ? c.text : ""))
        .join("")
        .trim();
    }
    return "";
  } catch (e) {
    const friendly = mistralAuthFailureMessage(e);
    if (friendly) {
      console.error("Mistral API unauthorized (check MISTRAL_API_KEY):", e);
      return friendly;
    }
    throw e;
  }
}

export function scheduleRoomLlm(room: Room, job: () => Promise<void>): void {
  room.llmTail = room.llmTail.then(job).catch((e) => console.error("room LLM job", e));
}

/** Display name for assistant messages in the transcript (participant-facing). */
export const ASSISTANT_LABEL = "Assistant";

export async function handleTaggedLlm(room: Room, io: Server, roomId: string): Promise<void> {
  io.to(roomId).emit("llm_typing", { typing: true });
  try {
    const replyText = await runMistral(room.messages);
    const llmMsg: ChatMessage = {
      id: nanoid(),
      slot: "llm",
      authorLabel: ASSISTANT_LABEL,
      text: replyText || "(empty model response)",
      ts: Date.now(),
    };
    room.messages.push(llmMsg);
    io.to(roomId).emit("message", llmMsg);
  } catch (e) {
    const errMsg: ChatMessage = {
      id: nanoid(),
      slot: "llm",
      authorLabel: ASSISTANT_LABEL,
      text: `[Error: ${e instanceof Error ? e.message : String(e)}]`,
      ts: Date.now(),
    };
    room.messages.push(errMsg);
    io.to(roomId).emit("message", errMsg);
  } finally {
    io.to(roomId).emit("llm_typing", { typing: false });
  }
}
