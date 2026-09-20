// client.ts — In-tree TypeSafe System One HTTP client for guest jev.ask.

import type { JevAnswers, JevAsk, JevQuestionsInput } from "./types.js";

export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 8_000;
export const DEFAULT_STATE_MAX_CHARS = 12_000;
const TRUNCATION_SUFFIX = "…[truncated]";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export interface CreateJevAskOptions {
  apiKey: string;
  fetch?: FetchLike;
  model?: string;
  timeoutMs?: number;
  stateMaxChars?: number;
  retryDelayMs?: number;
}

export function truncateJevState(state: unknown, maxChars: number): unknown {
  if (maxChars <= TRUNCATION_SUFFIX.length) {
    return TRUNCATION_SUFFIX.slice(0, maxChars);
  }
  const budget = maxChars - TRUNCATION_SUFFIX.length;
  if (typeof state === "string") {
    return state.length <= maxChars ? state : state.slice(0, budget) + TRUNCATION_SUFFIX;
  }
  const serialized = JSON.stringify(state);
  if (serialized.length <= maxChars) return state;
  return serialized.slice(0, budget) + TRUNCATION_SUFFIX;
}

function normalizeQuestions(questions: JevQuestionsInput): Record<string, unknown> {
  if (Array.isArray(questions)) {
    const mapped: Record<string, unknown> = {};
    for (let index = 0; index < questions.length; index += 1) {
      mapped[String(index)] = questions[index];
    }
    return mapped;
  }
  return questions;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529;
}

function mergeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted) return aborted;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of signals) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

function cancellationError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    if (reason.name === "AbortError" || /aborted/i.test(reason.message)) {
      return new Error("Execution cancelled");
    }
    return reason;
  }
  if (typeof reason === "string" && reason.trim()) return new Error(reason);
  return new Error("Execution cancelled");
}

export function createJevAsk(options: CreateJevAskOptions): JevAsk {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  const stateMaxChars = options.stateMaxChars ?? DEFAULT_STATE_MAX_CHARS;
  const retryDelayMs = options.retryDelayMs ?? 250;

  async function postOnce(body: string, signal: AbortSignal) {
    return fetchFn(SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal,
    });
  }

  async function fetchWithTimeout(body: string, cancelSignal?: AbortSignal) {
    if (cancelSignal?.aborted) {
      throw cancellationError(cancelSignal);
    }

    const timeoutController = new AbortController();
    const requestSignal = mergeAbortSignals(
      timeoutController.signal,
      ...(cancelSignal ? [cancelSignal] : []),
    );
    const inFlight = postOnce(body, requestSignal);
    void inFlight.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    let cancelListener: (() => void) | undefined;
    try {
      return await Promise.race([
        inFlight,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timeoutController.abort();
            reject(new Error(`Jev request timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (cancelSignal) {
            cancelListener = () => reject(cancellationError(cancelSignal));
            cancelSignal.addEventListener("abort", cancelListener, { once: true });
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (cancelSignal && cancelListener) {
        cancelSignal.removeEventListener("abort", cancelListener);
      }
    }
  }

  async function postWithRetry(body: string, cancelSignal?: AbortSignal): Promise<JevAnswers> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(body, cancelSignal);
        if (response.ok) {
          const payload = (await response.json?.()) as { answers?: JevAnswers } | undefined;
          if (!payload?.answers || typeof payload.answers !== "object") {
            throw new Error("Jev response missing answers");
          }
          return payload.answers;
        }
        const detail = (await response.text?.())?.trim() || `HTTP ${response.status}`;
        if (isRetryableStatus(response.status) && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        throw new Error(`Jev request failed (${response.status}): ${detail}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.message.includes("timed out") || lastError.message.includes("cancelled")) {
          throw lastError;
        }
        if (attempt === 0 && /429|529/.test(lastError.message)) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error("Jev request failed");
  }

  return {
    async ask(
      state: unknown,
      questions: JevQuestionsInput,
      signal?: AbortSignal,
    ): Promise<JevAnswers> {
      if (signal?.aborted) {
        throw cancellationError(signal);
      }
      const payload = {
        model,
        state: truncateJevState(state, stateMaxChars),
        questions: normalizeQuestions(questions),
      };
      return postWithRetry(JSON.stringify(payload), signal);
    },
  };
}
