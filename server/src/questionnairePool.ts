export type QuestionnaireItem = {
  id: string;
  prompt: string;
  options?: string[];
};

/** Fixed pre-chat questions (ids q1–q5) for every participant. */
export const STATIC_QUESTIONNAIRE: QuestionnaireItem[] = [
  {
    id: "q1",
    prompt: "How clear did you find the instructions for this study?",
    options: ["Very unclear", "Somewhat unclear", "Neutral", "Somewhat clear", "Very clear"],
  },
  {
    id: "q2",
    prompt: "How often do you participate in online research studies?",
    options: ["Never", "Rarely", "Sometimes", "Often", "Very often"],
  },
  {
    id: "q3",
    prompt: "What device are you using right now?",
    options: ["Desktop / laptop", "Tablet", "Smartphone", "Other"],
  },
  {
    id: "q4",
    prompt: "In one sentence, what do you expect from the upcoming task?",
  },
  {
    id: "q5",
    prompt: "Is there anything you want the researchers to know before you continue? (If nothing, write “none”.)",
  },
];

export const STATIC_QUESTION_IDS = STATIC_QUESTIONNAIRE.map((q) => q.id);

const POOL_BY_ID = new Map(STATIC_QUESTIONNAIRE.map((q) => [q.id, q]));

export function questionFromPool(id: string): QuestionnaireItem | undefined {
  return POOL_BY_ID.get(id);
}

export function getStaticQuestionnaire(): QuestionnaireItem[] {
  return [...STATIC_QUESTIONNAIRE];
}
