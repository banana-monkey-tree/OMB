// U1 (upstreams.md): a delegated/coordinated result returning to its source
// 1:1 thread now resumes the native session and sends only what that
// session has not been handed, instead of clearing resumeCursors and
// replaying up to 40 messages (see server/delta-context.ts). This exercises
// the real dispatch path end to end, through the same isolated launcher and
// the repo's own fake Claude CLI (server/testing/fake-claude-cli.ts) used
// throughout this suite — no real LLM calls.
//
// The wrapper below is the same recording pattern
// server/independent-threads-api.test.ts uses (write a small .mjs that logs
// argv/env around the unmodified fake, swap it in via
// PATCH /api/instances/claude {cli}), extended to also capture raw argv
// (--resume / --session-id) per launch, which the room-handoff plan agent's
// own evidence log does not record.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    // Record raw process launches (argv shape, --resume/--session-id) to a
    // JSONL the wrapper appends to, alongside the unmodified fake CLI.
    const capturePath = join(session.info.dataDir, "launches.jsonl");
    const fake = pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href;
    const wrapper = join(session.info.dataDir, "recording-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      'const argv = process.argv.slice(2);',
      'const argAfter = (f) => { const i = argv.indexOf(f); return i === -1 ? null : (argv[i + 1] ?? null); };',
      'let botId = null, threadId = null;',
      'const mc = argAfter("--mcp-config");',
      'if (mc) { try { const cfg = JSON.parse(readFileSync(mc, "utf8")); for (const s of Object.values(cfg.mcpServers ?? {})) { if (s?.env?.OMB_BOT_ID) { botId = s.env.OMB_BOT_ID; threadId = s.env.OMB_THREAD_ID ?? null; } } } catch {} }',
      `appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ pid: process.pid, t: Date.now(), resume: argAfter("--resume"), sessionIdArg: argAfter("--session-id"), botId, threadId }) + "\\n");`,
      `await import(${JSON.stringify(fake)});`,
    ].join("\n"), { mode: 0o700 });
    // request() throws on a non-2xx response, so reaching past this line at
    // all already proves the swap succeeded — this endpoint's JSON body
    // does not itself carry a "status" field (unlike /api/bots/:id's).
    await api("/api/instances/claude", { cli: wrapper }, "PATCH");

    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [chief.id]: { reply: "On it", resumeReply: "Done — the export is verified" },
      [lead.id]: { reply: "finished the export report" },
    };
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    save();
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const wait = () => cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30");
    const launches = () => existsSync(capturePath) ? readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const chiefLaunches = () => launches().filter((l: any) => l.botId === chief.id).sort((a: any, b: any) => a.t - b.t);
    const nodes = () => existsSync(join(session.info.dataDir, "room-handoffs.json"))
      ? JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8")) : [];
    await test({ session, cli, api, chief, lead, plan, save, wait, messages, launches, chiefLaunches, nodes, planPath });
  } finally {
    await session.close();
  }
}

it("resumes the source session across a coordinate_bots round-trip, with a delta of exactly the unseen thread messages, and no duplicate results", () => fixture(async (f) => {
  // Two ordinary warm-up turns first, so there is a settled session and
  // prior chat this instance has already been handed.
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "hello there");
  expect((await f.wait()).status).toBe("settled");
  const warmup = f.chiefLaunches();
  expect(warmup).toHaveLength(1);
  expect(warmup[0].resume).toBeNull(); // first-ever turn: fresh
  const sessionId = warmup[0].sessionIdArg ?? "fake-session";

  // Now the coordination round: the chief delegates to Engineering, the
  // reply lands on the source 1:1 thread, and the chief's node resumes.
  f.plan[f.chief.id] = {
    steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "build", message: "Build and verify the CSV export" } }],
    reply: "Assigned to Engineering",
    resumeReply: "Done — the export is verified",
  };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Please have Engineering build a CSV export.");
  expect((await f.wait()).status).toBe("settled");

  const chiefLaunches = f.chiefLaunches();
  expect(chiefLaunches).toHaveLength(3); // warm-up, dispatch turn, resumed return turn
  const [, dispatchTurn, returnTurn] = chiefLaunches;

  // (a) resume cursor preserved and --resume used on the return turn — the
  // SAME session id the warm-up turn established, never reset.
  expect(dispatchTurn.resume).toBe(sessionId);
  expect(returnTurn.resume).toBe(sessionId);

  const chiefMessages = await f.messages(f.chief.activeTaskId);
  const evidence = readFileSync(`${f.planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const chiefResumedTurn = evidence.filter((e: any) => e.botId === f.chief.id).at(-1);
  const returnText: string = chiefResumedTurn.prompt.message.content;

  // (b) the delta contains exactly the unseen messages on the source
  // thread: the addressed request to Engineering and its result — not the
  // warm-up turn this session already ran.
  expect(returnText).toContain("Build and verify the CSV export");
  expect(returnText).toContain("finished the export report");
  expect(returnText).not.toContain("hello there");

  // (c) the result is not sent twice: teammateReportContext's rendering of
  // "finished the export report" appears exactly once in the return turn,
  // not once in a replay block and again in coordinationTurnText's own
  // brief (the pre-U1/U37 duplication).
  const occurrences = returnText.split("finished the export report").length - 1;
  expect(occurrences).toBe(1);

  // The reply the chief actually gave, using the delta, reaches the user.
  expect(chiefMessages.some((m: any) => m.text === "Done — the export is verified")).toBe(true);
}), 45_000);

it("falls back to a full inline replay (not a resume) when the session is genuinely lost to a rewind, even right after a delegated round resumed it via delta", () => fixture(async (f) => {
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "hello there");
  expect((await f.wait()).status).toBe("settled");

  f.plan[f.chief.id] = {
    steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "build", message: "Build and verify the CSV export" } }],
    reply: "Assigned to Engineering",
    resumeReply: "Done — the export is verified",
  };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Please have Engineering build a CSV export.");
  // The whole coordination round settles first (this is the resume+delta
  // path the previous test exercises) — the task must be idle before the
  // app allows an edit at all.
  expect((await f.wait()).status).toBe("settled");

  // One ordinary follow-up turn after the delegated round settled — resumed
  // with (at most) an empty delta, same as any other resumed turn.
  f.plan[f.chief.id] = { reply: "Anything else?" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Thanks.");
  expect((await f.wait()).status).toBe("settled");

  // Rewind THAT follow-up (not the original delegating message — editing it
  // would fork the branch before the delegated round, discarding it) — the
  // only mapped way (control-omb's own `edit` command comment) to make the
  // NEXT provider turn REBUILD rather than resume. A session lost this way
  // must fall back to today's full replay regardless of any handed
  // watermark delta-context.ts holds; the delegated round stays on the
  // active branch because it happened BEFORE the edited message.
  const followup = (await f.messages(f.chief.activeTaskId)).findLast((m: any) => m.role === "user");
  f.plan[f.chief.id] = { reply: "Rebuilt from the replay" };
  f.save();
  await f.cli("edit", "--bot", f.chief.id, "--message", followup.id, "--task", f.chief.activeTaskId,
    "--text", "Thanks — one more thing (edited).");
  expect((await f.wait()).status).toBe("settled");

  const evidence = readFileSync(`${f.planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rewoundTurn = evidence.filter((e: any) => e.botId === f.chief.id).at(-1);
  const rewoundLaunch = f.chiefLaunches().at(-1);
  // Not resumed: a fresh session, the same as pre-U1 behaviour for this case.
  expect(rewoundLaunch.resume).toBeNull();
  // The full active branch replayed inline, including the earlier teammate
  // report this same task received a delta for a moment ago — the fallback
  // is a superset, never a loss, of what the delta path would have sent.
  const rewoundPrompt: string = rewoundTurn.prompt.message.content;
  expect(rewoundPrompt).toContain("edited");
  expect(rewoundPrompt).toContain("finished the export report");
  expect(rewoundPrompt).toContain("rewound this conversation");
}), 45_000);
