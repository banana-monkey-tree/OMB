// What room members actually receive, through the isolated server and the
// repository fake Claude CLI. No provider credentials or live data are used.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const count = (text: string, needle: string) => text.split(needle).length - 1;

async function fixture(test: (f: any) => Promise<void>, resume = true) {
  const session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.270" },
    undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const planPath = join(session.info.dataDir, "room-plan.json");
    const launchesPath = join(session.info.dataDir, "launches.jsonl");
    const wrapper = join(session.info.dataDir, "claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const argv = process.argv.slice(2);",
      "const after = flag => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1] ?? null; };",
      "let botId = null;",
      'try { for (const s of Object.values(JSON.parse(readFileSync(after("--mcp-config"), "utf8")).mcpServers ?? {})) botId = s?.env?.OMB_BOT_ID ?? botId; } catch {}',
      `if (after("--resume") || after("--session-id")) appendFileSync(${JSON.stringify(launchesPath)}, JSON.stringify({ botId, resume: after("--resume"), sessionId: after("--session-id") }) + "\\n");`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("/api/instances/claude", { cli: wrapper }, "PATCH");
    const bots = [];
    for (const name of ["Alice", "Bob", "Carol"]) bots.push((await cli("new-bot", "--name", name)).bot);
    const [a, b, c] = bots;
    const { group } = await api("/api/groups", { name: "Delta room", memberIds: [a.id, b.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: a.id } } });
    const patch = (body: unknown) => api(`/api/groups/${group.id}`, body, "PATCH");
    if (resume) await patch({ memberSessions: "resume" });
    const plan: Record<string, any> = Object.fromEntries(bots.map(bot => [bot.id, { reply: `REPLY_${bot.name}` }]));
    const launches = (botId = a.id) => jsonl(launchesPath).filter(turn => turn.botId === botId);
    const turns = (botId = a.id) => jsonl(`${planPath}.evidence.jsonl`).filter(turn => turn.botId === botId);
    const prompt = (turn: any) => String(turn?.prompt?.message?.content ?? "");
    const messages = async () => (await api(`/api/threads/${group.threadId}/messages`)).messages;
    const stored = () => JSON.parse(readFileSync(join(session.info.dataDir, "groups.json"), "utf8")).find((g: any) => g.id === group.id);
    const record = (botId = a.id) => stored().members?.[group.threadId]?.[botId]?.handedMessages?.claude;
    const send = async (text: string, bot = a) => {
      await patch({ defaultResponder: { kind: "member", botId: bot.id } });
      writeFileSync(planPath, JSON.stringify(plan));
      const before = turns(bot.id).length;
      await api(`/api/groups/${group.id}/messages`, { text });
      await expect.poll(() => turns(bot.id).length, { timeout: 30_000 }).toBe(before + 1);
      await expect.poll(async () => (await api("/api/bots")).groups.find((g: any) => g.id === group.id).working,
        { timeout: 30_000 }).toBe(false);
      return prompt(turns(bot.id).at(-1));
    };
    // Plain text fixtures pin the whole fallback, including API provenance,
    // speaker labels, newlines and footer, against the stored transcript.
    const replay = async (bot = a) => {
      const context = (await messages()).filter((m: any) => m.kind === "text" && m.text).slice(0, -1).slice(-30);
      return context.map((m: any) => `${m.role === "user" ? m.via === "api" ? "User (sent through the local API, not typed)" : "User" : m.from?.name ?? "Bot"}: ${m.text}`).join("\n")
        + `\n\n(Reply to the conversation above as ${bot.name}.)`;
    };
    await test({ a, b, c, group, plan, patch, send, turns, launches, prompt, messages, stored, record, replay });
  } finally {
    await session.close();
  }
}

it("resumes each member's own session and sends unseen sentinels exactly once", () => fixture(async f => {
  await f.send("FIRST_SENTINEL", f.a);
  await f.send("SECOND_SENTINEL", f.b);
  await f.send("THIRD_SENTINEL", f.a);
  await f.send("FOURTH_SENTINEL", f.b);
  for (const bot of [f.a, f.b]) {
    const launches = f.launches(bot.id);
    expect(launches).toHaveLength(2);
    expect(launches[0].resume).toBeNull();
    expect(launches[1].resume).toBe(launches[0].sessionId);
    const received = f.turns(bot.id).map(f.prompt).join("\n");
    for (const marker of ["FIRST_SENTINEL", "SECOND_SENTINEL", "THIRD_SENTINEL"]) expect(count(received, marker)).toBe(1);
  }
  expect(f.launches(f.a.id)[0].sessionId).not.toBe(f.launches(f.b.id)[0].sessionId);
}), 90_000);

it("persists the room member delivery record in groups.json", () => fixture(async f => {
  await f.send("PERSIST_SENTINEL");
  expect(f.record(), "room delivery record must persist in groups.json").toMatchObject({
    session: f.launches()[0].sessionId, through: expect.any(String), ids: [],
  });
}), 60_000);

it("does not re-offer a member its own reply", () => fixture(async f => {
  await f.send("OWN_REPLY_FIRST");
  const next = await f.send("OWN_REPLY_SECOND");
  expect(f.launches().at(-1).resume).toBe(f.launches()[0].sessionId);
  expect(next).not.toContain("REPLY_Alice");
}), 60_000);

it("gives a member added mid-conversation a fresh session and the window", () => fixture(async f => {
  await f.send("BEFORE_JOIN");
  await f.patch({ memberIds: [f.a.id, f.b.id, f.c.id] });
  const next = await f.send("AFTER_JOIN", f.c);
  expect(f.launches(f.c.id)[0].resume).toBeNull();
  expect(next).toBe(await f.replay(f.c));
}), 60_000);

it("keeps default rooms on fresh sessions with the exact window replay", () => fixture(async f => {
  expect(f.stored().memberSessions).toBeUndefined();
  for (const text of ["DEFAULT_FIRST", "DEFAULT_SECOND"]) {
    expect(await f.send(text)).toBe(await f.replay());
  }
  expect(f.launches().every((turn: any) => turn.resume === null && typeof turn.sessionId === "string")).toBe(true);
  expect(f.record()).toBeUndefined();
}, false), 60_000);

it("replays after a member is removed and re-added", () => fixture(async f => {
  await f.send("BEFORE_REMOVAL");
  await f.patch({ memberIds: [f.b.id, f.c.id], defaultResponder: { kind: "member", botId: f.b.id } });
  expect(f.record()).toBeUndefined();
  await f.patch({ memberIds: [f.a.id, f.b.id, f.c.id] });
  expect(await f.send("AFTER_REJOIN")).toBe(await f.replay());
  expect(f.launches().at(-1).resume).toBeNull();
}), 60_000);

it("forces a fresh session and window after a bulletin edit", () => fixture(async f => {
  await f.send("BEFORE_BULLETIN");
  await f.patch({ bulletin: "BULLETIN_CHANGED: answer briefly." });
  expect(await f.send("AFTER_BULLETIN")).toBe(await f.replay());
  expect(f.launches().at(-1).resume).toBeNull();
  expect(f.turns().at(-1).system).toContain("BULLETIN_CHANGED");
}), 60_000);

it("keeps messages eligible when a turn fails before the provider acts", () => fixture(async f => {
  await f.send("ACCEPTED_SENTINEL");
  const before = f.record();
  f.plan[f.a.id] = { fail: true };
  await f.send("FAILED_SENTINEL");
  expect(f.record()).toEqual(before);
  f.plan[f.a.id] = { reply: "Recovered" };
  const next = await f.send("RETRY_SENTINEL");
  expect(f.launches().at(-1).resume).toBe(f.launches()[0].sessionId);
  expect(count(next, "FAILED_SENTINEL")).toBe(1);
  expect(next).not.toContain("ACCEPTED_SENTINEL");
}), 90_000);
