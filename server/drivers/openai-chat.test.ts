// Stream-termination contract of the shared chat-completions runtime, driven
// through the openai-compat driver. MiniMax's api.minimax.io/v1 closes the
// connection after the finish_reason chunk without ever sending `data: [DONE]`,
// and reports account failures as HTTP 200 with a JSON `base_resp` body.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { MinimaxDriver } from "./minimax.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => vi.unstubAllGlobals());

async function runTurn(body: string, driver: "openai-compat" | "minimax" = "openai-compat") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
  const instance = driver === "minimax"
    ? await MinimaxDriver.create({
        instanceId: "minimax", displayName: "MiniMax", enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      })
    : await OpenAICompatDriver.create({
        instanceId: "minimax", displayName: "MiniMax", enabled: true,
        config: OpenAICompatDriver.decodeConfig({ url: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", model: "MiniMax-M3" }),
        environment: { MINIMAX_API_KEY: "secret" },
      });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
  await vi.waitFor(() => {
    if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
  });
  await instance.dispose();
  return events;
}

describe("createOpenAIChatRuntime stream termination", () => {
  it("treats EOF after a finish_reason chunk as a clean completion when [DONE] never arrives", async () => {
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"content":"<think>\\nuser said hi\\n</think>Hello!"}}]}\n\n' +
        'data: {"choices":[{"index":0,"finish_reason":"stop","delta":{"content":" How can I help?"}}],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
    );
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({
      text: "<think>\nuser said hi\n</think>Hello! How can I help?",
    });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });

  it("parses a final finish_reason+usage frame with no trailing newline before the socket closes", async () => {
    // No trailing \n\n after the last frame -- the connection just closes,
    // the way it does against several real OpenAI-compatible local servers.
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}',
    );
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello" });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });

  it("splits a final unterminated frame across two stream chunks", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const instance = await OpenAICompatDriver.create({
      instanceId: "minimax", displayName: "MiniMax", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", model: "MiniMax-M3" }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    // The final frame's closing brace and its usage object arrive in a
    // second chunk, after the first chunk already delivered a complete
    // earlier frame -- proves the leftover-buffer flush on EOF works
    // whether the split content arrived in one decoder.decode() call or
    // accumulated across several.
    controller!.enqueue(
      encoder.encode(
        'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"comple',
      ),
    );
    controller!.enqueue(encoder.encode('tion_tokens":9}}'));
    controller!.close();
    await vi.waitFor(() => {
      if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
    });
    await instance.dispose();
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello" });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });

  it("does not misfire on an empty final flush when the stream ends cleanly on a newline", async () => {
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
    );
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "hi" });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 1, output: 1 } });
  });

  it("still honors data: [DONE]", async () => {
    const events = await runTurn('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "hi" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("surfaces an HTTP 200 whose body is a MiniMax base_resp error instead of finishing silently", async () => {
    const events = await runTurn('{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}');
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: "provider returned a completion error: upstream error 1008: insufficient balance",
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
  });

  it("surfaces an OpenAI-style error object returned with HTTP 200", async () => {
    const events = await runTurn('{"error":{"message":"token is unusable (1004)","type":"authorized_error"}}');
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: "provider returned a completion error: token is unusable (1004)",
    });
  });

  it("reports a stream truncated before finish_reason as an error, not an interrupt", async () => {
    const events = await runTurn('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n');
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: "Stream ended before completion",
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
  });

  it("lets the MiniMax driver finish a [DONE]-less reasoning_split stream and stream its reasoning", async () => {
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"user said hi"}}]}\n\n' +
        'data: {"choices":[{"index":0,"finish_reason":"stop","delta":{"content":"Hello!"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
      "minimax",
    );
    expect(events.filter((event) => event.type === "content.delta").map((event) => event.streamKind))
      .toEqual(["reasoning_text", "assistant_text"]);
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello!" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });
});
