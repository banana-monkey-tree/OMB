// U1 (upstreams.md): when a delegated/coordinated result returns to its
// source 1:1 thread, the source bot's provider session is still perfectly
// resumable — the old code just had no way to tell the model what an idle
// session missed, so it threw the session away instead: cleared
// resumeCursors, forced a fresh non-resumed launch, and replayed up to the
// last 40 active-branch messages inline (markTaskContextExternallyUpdated +
// buildTurnContext's externallyUpdated branch in earlier revisions). That
// cost ~10-18 KB per return turn (T20 baseline:
// measurements/baseline-v0.1.80.md) and, because the replay already
// includes teammate reports via teammateReportContext while the
// coordination brief (coordinationTurnText) repeated the same results as
// JSON, sent every result twice (U37, folded into this same patch).
//
// This module keeps the native session. server/index.ts tracks, per (task,
// provider instance), the id of the last active-branch message that
// instance has been "handed" — either because its own turn produced it, or
// because a prior turn's delta already carried it to the provider — and
// this module computes and renders only the messages appended since. The
// full inline replay in server/turn-context.ts is untouched for the cases
// where a session genuinely cannot be resumed at all: a rewind, a model
// switch (engineIsFresh), or a resume cursor the provider rejects at
// runtime (server/resume-recovery.ts). Those paths never consult this
// module — buildTurnContext only applies a delta block when it has already
// decided to resume.

export interface DeltaSourceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

// Same shape hive's task-thread deliveries used for "only unseen" context
// (see plan/notes.md §Hive delta context): clip each body so one huge
// message can't blow the budget alone, cap the whole block newest-first so
// a budget cut never drops the most recent (most relevant) message, and say
// plainly how many were left out instead of silently truncating.
export const DELTA_CLIP_CHARS = 600;
export const DELTA_MAX_MESSAGES = 12;
export const DELTA_MAX_BYTES = 4_000;

export const DELTA_PREAMBLE =
  "[This conversation received messages outside your provider session since your last turn here. Teammate reports below render exactly as they do elsewhere in this conversation — nothing here duplicates a turn you already ran:]";

export function clipMessageText(text: string, limit = DELTA_CLIP_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** Active-branch messages appended after `watermarkMessageId`. `undefined`
 * means this instance has no recorded handed state — a task that predates
 * this feature, or an instance that has never dispatched here — and that is
 * treated as "nothing to add", not "everything is unseen": the ordinary
 * resumed-turn path (no delta block) already covers that task exactly as it
 * did before this module existed. A watermark id no longer found on the
 * active branch (its message left the branch on a rewind/edit) is treated
 * the same way — harmless, because the rewind path forces a full replay
 * before this function is ever consulted for that turn. */
export function selectUnseenMessages(
  messages: readonly DeltaSourceMessage[],
  watermarkMessageId: string | undefined,
): DeltaSourceMessage[] {
  if (watermarkMessageId === undefined) return [];
  const index = messages.findIndex((m) => m.id === watermarkMessageId);
  if (index === -1) return [];
  return messages.slice(index + 1);
}

/** Render the unseen tail as a bounded, newest-first-capped block. Empty
 * input renders "" so callers can cheaply skip prepending anything — an
 * ordinary resumed turn with nothing unseen is then byte-identical to
 * pre-U1 behaviour. The first kept message is never dropped for being over
 * budget alone; the byte cap only stops picking up MORE messages. */
export function renderDeltaBlock(unseen: readonly DeltaSourceMessage[]): string {
  if (unseen.length === 0) return "";
  const newestFirst = [...unseen].reverse();
  const kept: DeltaSourceMessage[] = [];
  let bytes = 0;
  for (const message of newestFirst) {
    if (kept.length >= DELTA_MAX_MESSAGES) break;
    const clipped = clipMessageText(message.text);
    const lineBytes = Buffer.byteLength(clipped, "utf8");
    if (kept.length > 0 && bytes + lineBytes > DELTA_MAX_BYTES) break;
    kept.push({ ...message, text: clipped });
    bytes += lineBytes;
  }
  const omitted = unseen.length - kept.length;
  const oldestFirst = kept.reverse();
  const lines = oldestFirst.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`);
  return [
    DELTA_PREAMBLE,
    "",
    ...(omitted > 0 ? [`(${omitted} older omitted)`, ""] : []),
    ...lines,
  ].join("\n");
}

/** Prepend a rendered delta block ahead of the turn's own text. A "" block
 * (nothing unseen) is a no-op. */
export function buildDeltaTurnText(text: string, deltaBlock: string): string {
  if (!deltaBlock) return text;
  return [deltaBlock, "", text].join("\n\n");
}
