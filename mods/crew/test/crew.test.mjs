import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chipsFor, contextShare, costOf, createCrew, dollars, headerBlocks, parsePrices, priceFor } from "../lib/crew.mjs";
import { createWire } from "../lib/wire.mjs";

const prices = parsePrices(JSON.parse(readFileSync(new URL("../prices.json", import.meta.url), "utf8")));

test("models match by normalised id, prefix and alias, never by guess", () => {
  assert.equal(priceFor("claude-opus-5-5", prices)?.input, 4);
  assert.equal(priceFor("us.anthropic.claude-sonnet-4-6", prices)?.input, 3);
  assert.equal(priceFor("claude-opus-5-5[1m]", prices)?.output, 20);
  assert.equal(priceFor("claude-opus-5", prices)?.input, 5, "opus 5 does not take opus 5.5 prices");
  assert.equal(priceFor("sonnet", prices)?.id, "claude-sonnet-5-5");
  assert.equal(priceFor("gpt-5", prices), null);
  assert.equal(priceFor(null, prices), null);
});

test("cost uses the reported figure first, else estimates from tokens", () => {
  const opus = priceFor("claude-opus-5-5", prices);
  assert.deepEqual(costOf({ cost_usd: 0.5, tokens: 1e6 }, opus), { usd: 0.5, estimated: false });
  const estimate = costOf({ tokens: 1_000_000, output_tokens: 100_000 }, opus);
  assert.equal(estimate.estimated, true);
  assert.ok(Math.abs(estimate.usd - (0.9 * 4 + 0.1 * 20)) < 1e-9);
  assert.equal(costOf({ tokens: 1000 }, null), null);
  assert.equal(costOf({}, opus), null);
});

test("context share needs both usage and a known window", () => {
  const haiku = priceFor("claude-haiku-4-5", prices);
  assert.equal(contextShare({ context_tokens: 50_000 }, haiku), 0.25);
  assert.equal(contextShare({ context_tokens: 900_000 }, haiku), 1);
  assert.equal(contextShare({}, haiku), null);
  assert.deepEqual(chipsFor({ model: "mystery", usage: { tokens: 10 } }, prices), []);
});

test("dollars stay short and honest", () => {
  assert.equal(dollars(0), "$0");
  assert.equal(dollars(0.004), "<$0.01");
  assert.equal(dollars(1.234), "$1.23");
  assert.equal(dollars(250.4), "$250");
});

test("header shows plan progress and total cost, and leaves counts to the Subagents tab", () => {
  const state = { plan: [{ content: "Read", status: "completed" }, { content: "Write the parser", status: "in_progress" }], agents: new Map([["a", { status: "in_progress", model: "claude-opus-5-5", usage: { cost_usd: 1 } }], ["b", { status: "completed", model: "mystery", usage: { tokens: 5 } }]]) };
  const [progress, stats] = headerBlocks(state, prices);
  assert.deepEqual(progress, { type: "progress", title: "Plan", label: "Write the parser", value: 0.5 });
  assert.deepEqual(stats.items, [{ label: "Cost", value: "$1.00", hint: "1 of 2 subagents priced" }]);
  assert.deepEqual(headerBlocks({ plan: [], agents: new Map() }, prices), []);
  assert.deepEqual(headerBlocks({ plan: [], agents: new Map([["c", { status: "in_progress", model: "mystery", usage: { tokens: 5 } }]]) }, prices), []);
});

test("the worker publishes chips and header once, and only when they change", async () => {
  const written = [];
  const wire = createWire({ write: (line) => written.push(JSON.parse(line)), setup: () => createCrew(prices) });
  const update = (id, usage) => wire.feed(JSON.stringify({ type: "event", id, hook: "subagent.update", thread_id: "t1", workspace_id: "w", data: { tool_call_id: "sub-1", status: "in_progress", model: "claude-opus-5-5", usage } }));
  await update(1, { tokens: 100_000, output_tokens: 10_000, context_tokens: 250_000 });
  const first = written.at(-1);
  assert.equal(first.type, "reply");
  assert.deepEqual(first.publish.map((item) => item.slot), ["subagent.meta", "agents.header"]);
  assert.deepEqual(first.publish[0].chips.map((chip) => chip.value), ["$0.56", "25%"]);
  await update(2, { tokens: 100_000, output_tokens: 10_000, context_tokens: 250_000 });
  assert.deepEqual(written.at(-1).publish, [], "nothing changed, nothing published");
  await wire.feed(JSON.stringify({ type: "event", id: 3, hook: "turn.end", thread_id: "t1", workspace_id: "w", data: {} }));
  assert.deepEqual(written.at(-1).publish, [], "finishing a turn changes no cost");
});

test("bad events still get a reply", async () => {
  const written = [];
  const wire = createWire({ write: (line) => written.push(JSON.parse(line)), setup: () => createCrew(prices) });
  await wire.feed(JSON.stringify({ type: "event", id: 9, hook: "subagent.update", thread_id: "t1", data: "nonsense" }));
  await wire.feed("not json");
  assert.deepEqual(written.find((line) => line.type === "reply"), { type: "reply", id: 9, publish: [] });
});
