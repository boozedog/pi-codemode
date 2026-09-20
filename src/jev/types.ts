// types.ts — Guest-facing Jev question/answer shapes aligned with the System One wire format.

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
  confidence?: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  confidence?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export type JevQuestionsInput = Record<string, JevQuestion> | JevQuestion[];

export interface JevAsk {
  ask(state: unknown, questions: JevQuestionsInput, signal?: AbortSignal): Promise<JevAnswers>;
}

/** TypeScript declarations injected into the guest sandbox when Jev is armed. */
export function generateJevTypeDefs(): string {
  return `\
interface JevNoulAnswer { type: "noul"; noul: number; confidence?: number; }
interface JevChoiceAnswer { type: "choice"; choice: string; confidence?: number; probabilities: Record<string, number>; }
interface JevScoreAnswer { type: "score"; score: number; confidence?: number; legend?: Record<string, string>; probabilities?: Record<string, number>; }
type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
type JevAnswers = Record<string, JevAnswer>;

interface JevNoulQuestion { type: "noul"; instructions: string; }
interface JevChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string>; }
interface JevScoreQuestion { type: "score"; instructions: string; criteria: string[]; }
type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

/** TypeSafe System One classifier (noul / choice / score). Available when a TypeSafe API key is configured. */
declare const jev: {
  ask(
    state: unknown,
    questions: Record<string, JevQuestion> | JevQuestion[],
  ): Promise<JevAnswers>;
};
`;
}
