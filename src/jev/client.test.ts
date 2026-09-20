import { afterEach, describe, expect, test, vi } from "vitest";
import { createJevAsk, truncateJevState, type FetchLike } from "./client.js";

type MockResponse = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function mockFetch(impl: (...args: Parameters<FetchLike>) => Promise<MockResponse>): FetchLike {
  return vi.fn<FetchLike>(impl);
}

function firstFetchCall(fetch: FetchLike): [
  string,
  {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
] {
  const call = vi.mocked(fetch).mock.calls[0];
  if (!call) throw new Error("fetch was not called");
  return [call[0], call[1] ?? {}];
}

describe("truncateJevState", () => {
  test("caps long strings with a truncation marker", () => {
    const input = "x".repeat(100);
    const out = truncateJevState(input, 40);
    expect(typeof out).toBe("string");
    expect((out as string).length).toBe(40);
    expect((out as string).endsWith("…[truncated]")).toBe(true);
  });

  test("serializes objects before truncating", () => {
    const out = truncateJevState({ title: "a".repeat(200) }, 50);
    expect(typeof out).toBe("string");
    expect((out as string).endsWith("…[truncated]")).toBe(true);
  });
});

describe("createJevAsk", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("posts state and questions to System One and returns answers", async () => {
    const fetch = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "jev-1.13.0",
        answers: { urgent: { type: "noul", noul: 0.9 } },
      }),
    }));
    const ask = createJevAsk({ apiKey: "test-key", fetch, timeoutMs: 5_000 });
    const answers = await ask.ask("Customer is angry", {
      urgent: { type: "noul", instructions: "Escalate?" },
    });

    expect(answers).toEqual({ urgent: { type: "noul", noul: 0.9 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = firstFetchCall(fetch);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(init.body)) as {
      model: string;
      state: string;
      questions: Record<string, unknown>;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.state).toBe("Customer is angry");
    expect(body.questions.urgent).toEqual({
      type: "noul",
      instructions: "Escalate?",
    });
  });

  test("converts question arrays to keyed maps", async () => {
    const fetch = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-latest", answers: { "0": { type: "noul", noul: 1 } } }),
    }));
    const ask = createJevAsk({ apiKey: "k", fetch });
    await ask.ask("state", [{ type: "noul", instructions: "Yes?" }]);
    const body = JSON.parse(String(firstFetchCall(fetch)[1].body));
    expect(body.questions).toEqual({ "0": { type: "noul", instructions: "Yes?" } });
  });

  test("truncates oversized state before send", async () => {
    const fetch = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-latest", answers: {} }),
    }));
    const ask = createJevAsk({ apiKey: "k", fetch, stateMaxChars: 30 });
    await ask.ask("x".repeat(500), {});
    const body = JSON.parse(String(firstFetchCall(fetch)[1].body));
    expect(body.state).toHaveLength(30);
    expect(body.state.endsWith("…[truncated]")).toBe(true);
  });

  test("retries once on 429 then succeeds", async () => {
    const fetch = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.5 } } }),
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.5 } } }),
      });
    const ask = createJevAsk({ apiKey: "k", fetch, retryDelayMs: 1 });
    const answers = await ask.ask("s", { q: { type: "noul", instructions: "?" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(answers.q).toEqual({ type: "noul", noul: 0.5 });
  });

  test("throws after a failed retry on 429", async () => {
    const fetch = mockFetch(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    const ask = createJevAsk({ apiKey: "k", fetch, retryDelayMs: 1 });
    await expect(ask.ask("s", {})).rejects.toThrow(/429/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("times out slow responses", async () => {
    const fetch = mockFetch(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );
    const ask = createJevAsk({ apiKey: "k", fetch, timeoutMs: 30 });
    await expect(ask.ask("s", {})).rejects.toThrow(/timed out after 30ms/i);
  });

  test("does not surface an unhandled rejection when timing out", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const fetch = mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const ask = createJevAsk({ apiKey: "k", fetch, timeoutMs: 20 });
    try {
      await expect(ask.ask("s", {})).rejects.toThrow(/timed out after 20ms/i);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("aborts in-flight fetch when the guest signal is aborted", async () => {
    const controller = new AbortController();
    const fetch = mockFetch(
      (_url, init) =>
        new Promise(() => {
          init?.signal?.addEventListener("abort", () => {
            /* fetch mock waits for abort */
          });
        }),
    );
    const ask = createJevAsk({ apiKey: "k", fetch, timeoutMs: 8_000 });
    const pending = ask.ask("s", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(init?.signal?.aborted).toBe(true);
  });
});
