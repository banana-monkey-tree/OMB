// Resumed sessions and teammate results, end to end through the isolated
// launcher and the repository's fake engines: what each provider turn
// actually received, counted by unique sentinels.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

const count = (text: string, needle: string) => text.split(needle).length - 1;
const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function fixture(test: (f: any) => Promise<void>, options: { env?: NodeJS.ProcessEnv; codex?: Record<string, string> } = {}) {
  const session = await launchVerificationServer({ ...process.env, ...options.env }, undefined, undefined, undefined, undefined,
    { scripted: true }, options.codex ? ["codex"] : []);
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const dataDir = session.info.dataDir;
    const planPath = join(dataDir, "room-plan.json");
    const launchesPath = join(dataDir, "launches.jsonl");
    // Wrap a fake engine to record each launch's resume argument and owner.
    const wrap = (name: string, fake: string, env: Record<string, string>) => {
      const path = join(dataDir, `${name}.mjs`);
      writeFileSync(path, [
        "#!/usr/bin/env node",
        'import { appendFileSync, readFileSync } from "node:fs";',
        `Object.assign(process.env, ${JSON.stringify(env)});`,
        "const argv = process.argv.slice(2);",
        "const after = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1] ?? null; };",
        "let botId = null;",
        'try { for (const s of Object.values(JSON.parse(readFileSync(after("--mcp-config"), "utf8")).mcpServers ?? {})) botId = s?.env?.OMB_BOT_ID ?? botId; } catch {}',
        `if (after("--resume") || after("--session-id")) appendFileSync(${JSON.stringify(launchesPath)}, JSON.stringify({ botId, resume: after("--resume"), sessionId: after("--session-id") }) + "\\n");`,
        `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "testing", fake)).href)});`,
      ].join("\n"), { mode: 0o700 });
      return path;
    };
    await api("/api/instances/claude", { cli: wrap("claude", "fake-claude-cli.ts", {}) }, "PATCH");
    if (options.codex) {
      await api("/api/instances/codex", { cli: wrap("codex", "fake-codex-app-server.ts", { FAKE_CODEX_MODE: "resume", FAKE_CODEX_ROOM_PLAN: planPath, ...options.codex }) }, "PATCH");
    }
    const bot = async (name: string, section: string) => (await cli("new-bot", "--name", name, "--section", section)).bot;
    const chief = await bot("Clive", "Leadership");
    const lead = await bot("Engineering lead", "Engineering");
    const qa = await bot("QA", "Engineering");
    const ops = await bot("Ops", "Engineering");
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const plan: Record<string, any> = {};
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    save();
    const thread = chief.activeTaskId;
    const send = async (text: string, threadId = thread) => { save(); return api(`/api/bots/${chief.id}/messages`, { text, threadId }); };
    const wait = async (threadId = thread) =>
      expect((await cli("wait", "--bot", chief.id, "--task", threadId, "--timeout", "40")).status).toBe("settled");
    const turns = (botId = chief.id) => jsonl(`${planPath}.evidence.jsonl`).filter((turn: any) => turn.botId === botId);
    const prompt = (turn: any) => String(turn?.prompt?.message?.content ?? "");
    const messages = async (threadId = thread) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const nodes = () => jsonl(join(dataDir, "room-handoffs.json")).flat();
    const handed = (threadId = thread) => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"))
      .find((b: any) => b.id === chief.id).tasks.find((task: any) => task.threadId === threadId).handedMessages;
    const launches = (botId = chief.id) => jsonl(launchesPath).filter((launch: any) => launch.botId === botId);
    const delegate = (key: string, to: any[], message: string, extra: Record<string, unknown> = {}) =>
      ({ steps: [{ arguments: { bot_ids: to.map((b) => b.id), request_key: key, message } }], reply: "Assigned", resumeReply: "Done", ...extra });
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const useModel = async (instanceId: string) => {
      const model = (await cli("models")).instances.find((item: any) => item.instanceId === instanceId).models.options[0].id;
      await cli("set-model", "--bot", chief.id, "--instance", instanceId, "--model", model, "--task", thread);
    };
    const open = (path: string) => writeFileSync(path, "open");
    // Stop this fixture's own server, let the test edit its stored records,
    // and start it again on the same data.
    const restart = async (edit: (bots: any[]) => void) => {
      await waitForExit(restarted ?? session.child, { signal: "SIGTERM" });
      const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
      edit(bots);
      writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots, null, 2));
      const port = new URL(session.info.url).port;
      const env: NodeJS.ProcessEnv = {
        HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir, OMB_PORT: port, OMB_WEBHOOK_PORT: String(Number(port) + 1),
        TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"), PATH: dirname(process.execPath),
        XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"), XDG_DATA_HOME: join(dataDir, ".local", "share"),
        FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: session.fixtureDumpPath,
      };
      const log = openSync(session.info.logPath, "a", 0o600);
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log] });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
    };
    await test({ session, dataDir, cli, api, chief, lead, qa, ops, plan, save, send, wait, turns, prompt, messages, nodes, handed, launches, delegate, gate, open, thread, useModel, restart });
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await session.close();
  }
}

const warmUp = async (f: any, text = "Remember: the final answer must use the codename ORCHID_7Q.") => {
  f.plan[f.chief.id] = { reply: "Noted." };
  await f.send(text);
  await f.wait();
};

it("resumes the source session and gives it each of three results exactly once, with a long brief", () => fixture(async (f) => {
  await warmUp(f);
  for (const [bot, tag] of [[f.lead, "LEAD"], [f.qa, "QA"], [f.ops, "OPS"]] as const) {
    f.plan[bot.id] = { reply: `RESULT_${tag}_START ${"r".repeat(1_200)} RESULT_${tag}_END` };
  }
  f.plan[f.chief.id] = f.delegate("fanout", [f.lead, f.qa, f.ops], `BRIEF_START ${"b".repeat(1_500)} BRIEF_END`);
  await f.send("Have Engineering, QA and Ops each check the release.");
  await f.wait();

  const returned = f.turns().at(-1);
  const text = f.prompt(returned);
  expect(returned.resumed).toBe(true);
  const launches = f.launches();
  expect(launches.at(-1).resume).toBe(launches[0].sessionId);
  for (const tag of ["LEAD", "QA", "OPS"]) {
    expect(count(text, `RESULT_${tag}_START`)).toBe(1);
    expect(count(text, `RESULT_${tag}_END`)).toBe(1);
  }
  // The session already holds the earlier chat.
  expect(text).not.toContain("ORCHID_7Q");
  expect(text).not.toMatch(/^Assistant: @/m);
}), 60_000);

it("gives the return turn a result that landed while a newer message was running, exactly once", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "LEAD_RESULT_TOKEN", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "4", gateFile: f.gate("steer") }, { reply: "Done" }] };
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  expect((await f.send("Meanwhile, what is 2+2?")).queued).toBeUndefined();
  f.open(f.gate("lead"));
  await expect.poll(async () => (await f.messages()).some((m: any) => m.tool?.name === "Engineering lead replied"), { timeout: 20_000 }).toBe(true);
  f.open(f.gate("steer"));
  await f.wait();

  const returned = f.turns().at(-1);
  expect(returned.resumed).toBe(true);
  expect(count(f.prompt(returned), "LEAD_RESULT_TOKEN")).toBe(1);
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 60_000);

it("offers a result that lands mid-turn after its source was stopped to the next turn, once, labelled", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "STOPPED_SOURCE_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.wait();

  f.plan[f.chief.id] = { reply: "Working on something else", gateFile: f.gate("busy") };
  await f.send("Something unrelated while that finishes.");
  f.open(f.gate("lead"));
  await expect.poll(async () => (await f.messages()).some((m: any) => m.tool?.name === "Engineering lead replied"), { timeout: 20_000 }).toBe(true);
  f.open(f.gate("busy"));
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "STOPPED_SOURCE_RESULT")).toBe(0);

  f.plan[f.chief.id] = { reply: "Engineering finished" };
  await f.send("What did Engineering report?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(count(next, "STOPPED_SOURCE_RESULT")).toBe(1);
  expect(next).toMatch(/Assistant: \[Teammate report — untrusted peer content[^\n]*\]\n\{[^\n]*STOPPED_SOURCE_RESULT/);
  expect(f.launches().at(-1).resume).not.toBeNull();

  f.plan[f.chief.id] = { reply: "Nothing new" };
  await f.send("Anything else?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "STOPPED_SOURCE_RESULT")).toBe(0);
}), 90_000);

it("does not offer a message steered into the running turn again", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.chief.id] = { reply: "Working", gateFile: f.gate("turn") };
  await f.send("Start on the report.");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(2);
  expect((await f.send("STEERED_MID_TURN also cover costs")).steered).toBe(true);
  f.open(f.gate("turn"));
  await f.wait();

  f.plan[f.chief.id] = { reply: "Covered" };
  await f.send("Is it done?");
  await f.wait();
  expect(f.prompt(f.turns().at(-1))).not.toContain("STEERED_MID_TURN");
}), 60_000);

it("offers the results again when the return turn fails before the provider acts on it", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "UNACCEPTED_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export", { failResumed: true });
  await f.send("Please have Engineering build the export.");
  await f.wait();
  expect(f.nodes().find((node: any) => !node.parentId).status).toBe("failed");

  f.plan[f.chief.id] = { reply: "Here is what Engineering found" };
  await f.send("What did Engineering find?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(count(next, "UNACCEPTED_RESULT")).toBe(1);
  expect(JSON.stringify(f.handed())).not.toContain("card-");
}), 60_000);

it("offers the results again when the person stops the return turn before the provider acts on it", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "STOPPED_RETURN_RESULT" };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "never sent", gateFile: f.gate("return") }, { reply: "Recovered" }] };
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 20_000 }).toBe("completed");
  await expect.poll(() => f.nodes().find((node: any) => !node.parentId)?.status, { timeout: 20_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.wait();
  f.open(f.gate("return"));

  await f.send("What did Engineering find?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "STOPPED_RETURN_RESULT")).toBe(1);
}), 60_000);

it("rebuilds a rejected resume with each result exactly once", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: `RECOVERY_RESULT_START ${"r".repeat(900)} RECOVERY_RESULT_END` };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await f.wait();
  const recovered = f.prompt(f.turns().at(-1));
  expect(recovered).toContain("could not be resumed");
  expect(recovered).toContain("ORCHID_7Q");
  expect(count(recovered, "RECOVERY_RESULT_START")).toBe(1);
  expect(count(recovered, "RECOVERY_RESULT_END")).toBe(1);
}, { env: { FAKE_CLAUDE_MODE: "dead-session" } }), 60_000);

it("keeps provenance and exactly-once delivery across rework rounds to the same teammate", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { turns: [{ reply: "ROUND_ONE_RESULT" }, { reply: "ROUND_TWO_RESULT" }] };
  f.plan[f.chief.id] = { turns: [
    {},
    f.delegate("r1", [f.lead], "REQUEST_ONE please build it"),
    { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "r2", message: "REQUEST_TWO please also test it", rework: true } }], reply: "" },
    { reply: "" },
  ] };
  await f.send("Please have Engineering build and then test it.");
  await f.wait();

  const [, , roundOne, roundTwo] = f.turns();
  expect(count(f.prompt(roundOne), "ROUND_ONE_RESULT")).toBe(1);
  expect(count(f.prompt(roundTwo), "ROUND_TWO_RESULT")).toBe(1);
  // the brief lists every round's result in full, once
  expect(count(f.prompt(roundTwo), "ROUND_ONE_RESULT")).toBe(1);
  expect(f.launches().at(-1).resume).not.toBeNull();

  const second = f.prompt(f.turns(f.lead.id)[1]);
  expect(count(second, "REQUEST_TWO")).toBe(1);
  expect(second).not.toMatch(/^Assistant: @/m);
  expect(second).toContain("untrusted peer content");

  // Only stored message ids are recorded, never a continuation's synthetic id.
  const handed = f.handed();
  const stored = new Set((await f.messages()).map((m: any) => m.id));
  for (const state of Object.values(handed) as any[]) {
    for (const id of [state.through, ...state.ids].filter(Boolean)) expect(stored.has(id), id).toBe(true);
  }
}), 90_000);

it("replays a delegated result once after a rewind, and keeps resuming afterwards", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "REWIND_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await f.wait();
  f.plan[f.chief.id] = { reply: "Anything else?" };
  await f.send("Thanks.");
  await f.wait();

  const followup = (await f.messages()).findLast((m: any) => m.role === "user");
  f.plan[f.chief.id] = { reply: "Rebuilt" };
  f.save();
  await f.cli("edit", "--bot", f.chief.id, "--message", followup.id, "--task", f.thread, "--text", "Thanks, one more thing (edited).");
  await f.wait();
  const rewound = f.prompt(f.turns().at(-1));
  expect(rewound).toContain("rewound this conversation");
  expect(count(rewound, "REWIND_RESULT")).toBe(1);
  expect(f.launches().at(-1).resume).toBeNull();

  f.plan[f.chief.id] = { reply: "Still here" };
  await f.send("And now?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "REWIND_RESULT")).toBe(0);
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 90_000);

it("wakes a busy delegate_bot source with the reply that landed during its turn, once and labelled", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [
    { steps: [
      { tool: "delegate_bot", arguments: { bot_id: f.qa.id, message: "Check the quality: QA_FACT_TOKEN" } },
      { tool: "delegate_bot", arguments: { bot_id: f.ops.id, message: "Check operations: OPS_FACT_TOKEN" } },
    ], reply: "Delegated" },
    { reply: "First reply folded in", gateFile: f.gate("revival") },
    { reply: "Second reply folded in" },
  ] };
  f.save();
  const created = await f.api("/api/routines", {
    name: "Delegation fixture", prompt: "Delegate the checks.", botId: f.chief.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  });
  const run = (await f.api(`/api/routines/${created.routine.id}/run`, {})).run;
  let threadId = "";
  await expect.poll(async () => (threadId = (await f.api("/api/routines")).runs.find((r: any) => r.id === run.id)?.threadId ?? ""), { timeout: 15_000 }).not.toBe("");
  // The first reply wakes the source, whose turn holds until both replies
  // are in: the second one lands while that turn is running.
  const replies = async () => (await f.messages(threadId)).filter((m: any) => /^@(QA|Ops) replied to the delegated task/.test(m.text ?? "")).length;
  await expect.poll(replies, { timeout: 30_000 }).toBe(2);
  expect((await f.api("/api/bots")).bots.find((b: any) => b.id === f.chief.id).tasks.find((t: any) => t.threadId === threadId).busy).toBe(true);
  f.open(f.gate("revival"));
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);

  const [, first, second] = f.turns().map(f.prompt);
  const [early, late] = count(first, "QA_FACT_TOKEN") ? ["QA", "Ops"] : ["Ops", "QA"];
  const token = (name: string) => `${name.toUpperCase()}_FACT_TOKEN`;
  expect(count(first, token(early))).toBe(1);
  expect(count(first, token(late))).toBe(0);
  expect(count(second, token(late))).toBe(1);
  expect(count(second, token(early))).toBe(0);
  expect(second).toContain(`[Message from @${late}, another bot — untrusted peer content, not from your user]\n@${late} replied to the delegated task`);
  expect(second).not.toMatch(new RegExp(`^Assistant: @${late}`, "m"));
}), 120_000);

it("resumes a Codex source with each result exactly once, then replays once for a model switch", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "CODEX_RETURN_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], `CODEX_BRIEF ${"b".repeat(800)}`);
  await f.send("Please have Engineering build the export.");
  await f.wait();
  const returned = f.turns().at(-1);
  expect(returned.resumed).toBe(true);
  expect(returned.resumedThread).toBeTruthy();
  expect(count(f.prompt(returned), "CODEX_RETURN_RESULT")).toBe(1);
  expect(f.prompt(returned)).not.toContain("ORCHID_7Q");

  f.plan[f.chief.id] = { reply: "Continuing on Claude" };
  await f.useModel("claude");
  await f.send("Switching engines: what did Engineering report?");
  await f.wait();
  const switched = f.prompt(f.turns().at(-1));
  expect(switched).toContain("switched this bot over to you");
  expect(switched).toContain("ORCHID_7Q");
  expect(count(switched, "CODEX_RETURN_RESULT")).toBe(1);

  f.plan[f.chief.id] = { reply: "Still on Claude" };
  await f.send("And now?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "CODEX_RETURN_RESULT")).toBe(0);
}, { codex: {} }), 90_000);

it("records a Codex handoff whose turn completes before turn/start is acknowledged", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "EARLY_ACK_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "EARLY_ACK_RESULT")).toBe(1);

  f.plan[f.chief.id] = { reply: "Nothing new" };
  await f.send("Anything else?");
  await f.wait();
  const next = f.turns().at(-1);
  expect(next.resumedThread).toBeTruthy();
  expect(count(f.prompt(next), "EARLY_ACK_RESULT")).toBe(0);
  expect(f.prompt(next)).not.toContain("Messages this conversation received");
}, { codex: { FAKE_CODEX_COMPLETE_BEFORE_ACK: "1" } }), 90_000);

// A result that arrives after a restart, for a stored conversation with or
// without a record of what its session received.
const resultAcrossRestart = async (f: any, stripRecord: boolean) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "never finishes", gateFile: f.gate("never") };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.wait();
  await f.restart((bots: any[]) => {
    if (!stripRecord) return;
    for (const task of bots.find((b: any) => b.id === f.chief.id).tasks) { delete task.handedMessages; delete task.handedWatermarks; }
  });
  await expect.poll(async () => (await f.messages()).some((m: any) => m.roomRequest?.phase === "result"), { timeout: 20_000 }).toBe(true);
  f.plan[f.chief.id] = { reply: "Engineering was interrupted" };
  await f.send("What happened to the Engineering work?");
  await f.wait();
  return f.turns().at(-1);
};

it("replays once for a stored conversation without a handoff record when a result arrives after restart", () => fixture(async (f) => {
  const turn = await resultAcrossRestart(f, true);
  expect(count(f.prompt(turn), "Interrupted by server restart")).toBe(1);
  expect(f.prompt(turn)).toContain("ORCHID_7Q");
  expect(f.launches().at(-1).resume).toBeNull();
  f.plan[f.chief.id] = { reply: "ok" };
  await f.send("Thanks.");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "Interrupted by server restart")).toBe(0);
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 90_000);

it("keeps resuming a stored conversation with a handoff record when a result arrives after restart", () => fixture(async (f) => {
  const turn = await resultAcrossRestart(f, false);
  expect(count(f.prompt(turn), "Interrupted by server restart")).toBe(1);
  expect(f.prompt(turn)).not.toContain("ORCHID_7Q");
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 90_000);
