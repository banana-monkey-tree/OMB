import { describe, expect, it } from "vitest";

import {
  DELTA_MAX_BYTES,
  DELTA_MAX_MESSAGES,
  buildDeltaTurnText,
  clipMessageText,
  renderDeltaBlock,
  selectUnseenMessages,
  type DeltaSourceMessage,
} from "./delta-context.ts";

const msg = (id: string, role: "user" | "assistant", text: string): DeltaSourceMessage => ({ id, role, text });

describe("selectUnseenMessages", () => {
  const messages = [msg("m1", "user", "hi"), msg("m2", "assistant", "hello"), msg("m3", "assistant", "report A"), msg("m4", "assistant", "report B")];

  it("returns nothing when there is no recorded watermark — matches pre-U1 behaviour for tasks that never dispatched under this mechanism", () => {
    expect(selectUnseenMessages(messages, undefined)).toEqual([]);
  });

  it("returns everything after the watermark message", () => {
    expect(selectUnseenMessages(messages, "m2")).toEqual([msg("m3", "assistant", "report A"), msg("m4", "assistant", "report B")]);
  });

  it("returns nothing when the watermark is the newest message", () => {
    expect(selectUnseenMessages(messages, "m4")).toEqual([]);
  });

  it("returns nothing (not everything) when the watermark id is no longer on the active branch — the rewind path replaces this one entirely", () => {
    expect(selectUnseenMessages(messages, "long-gone")).toEqual([]);
  });
});

describe("renderDeltaBlock", () => {
  it("renders nothing for an empty list", () => {
    expect(renderDeltaBlock([])).toBe("");
  });

  it("renders oldest-first in the block despite capping newest-first", () => {
    const block = renderDeltaBlock([msg("1", "assistant", "first"), msg("2", "assistant", "second")]);
    expect(block.indexOf("Assistant: first")).toBeLessThan(block.indexOf("Assistant: second"));
    expect(block).not.toContain("omitted");
  });

  it("clips a long message body", () => {
    const long = "x".repeat(1000);
    const block = renderDeltaBlock([msg("1", "user", long)]);
    expect(block).toContain(`${"x".repeat(600)}…`);
    expect(block).not.toContain("x".repeat(601));
  });

  it("caps message count at DELTA_MAX_MESSAGES, keeping the newest and reporting how many were omitted", () => {
    const total = DELTA_MAX_MESSAGES + 5;
    const many = Array.from({ length: total }, (_, i) => msg(`m${i}`, "assistant", `msg ${i}`));
    const block = renderDeltaBlock(many);
    expect(block).toContain("(5 older omitted)");
    // the newest DELTA_MAX_MESSAGES (indices 5..16) are kept, oldest-first
    for (let i = total - DELTA_MAX_MESSAGES; i < total; i++) expect(block).toContain(`msg ${i}`);
    for (let i = 0; i < total - DELTA_MAX_MESSAGES; i++) expect(block).not.toContain(`msg ${i}\n`);
  });

  it("can cap on total bytes before reaching the message-count cap, always keeping at least the newest message", () => {
    // Each clipped message is well under DELTA_MAX_BYTES alone (clipping
    // bounds a single message to DELTA_CLIP_CHARS), so the byte cap here
    // comes from many messages together, not one huge one.
    const filler = "z".repeat(580);
    const many = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, "assistant", `${filler}-${i}`));
    const perMessageBytes = Buffer.byteLength(`${filler}-0`, "utf8");
    const expectedKept = Math.floor(DELTA_MAX_BYTES / perMessageBytes);
    expect(expectedKept).toBeLessThan(10); // the byte cap binds before DELTA_MAX_MESSAGES would
    const block = renderDeltaBlock(many);
    expect(block).toContain(`(${10 - expectedKept} older omitted)`);
    expect(block).toContain(`${filler}-9`); // newest always kept
    expect(block).not.toContain(`${filler}-0`); // oldest dropped
  });

  it("never drops the single newest message even if the block would otherwise be empty", () => {
    const huge = msg("huge", "assistant", "y".repeat(DELTA_MAX_BYTES * 2));
    const block = renderDeltaBlock([huge]);
    expect(block).toContain(clipMessageText(huge.text));
    expect(block).not.toContain("omitted");
  });
});

describe("buildDeltaTurnText", () => {
  it("is a no-op for an empty block", () => {
    expect(buildDeltaTurnText("hi", "")).toBe("hi");
  });

  it("prepends the block ahead of the turn text", () => {
    const out = buildDeltaTurnText("what did they find?", "[block]\n\nUser: x");
    expect(out.startsWith("[block]")).toBe(true);
    expect(out.endsWith("what did they find?")).toBe(true);
  });
});
