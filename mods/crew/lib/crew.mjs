import { isRecord } from "./wire.mjs";

const THREADS = 64;
const AGENTS = 200;

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parsePrices(raw) {
  const models = isRecord(raw) && Array.isArray(raw.models) ? raw.models : [];
  const table = [];
  for (const model of models) {
    if (!isRecord(model) || typeof model.id !== "string") continue;
    const input = number(model.input);
    const output = number(model.output);
    if (input === null || output === null) continue;
    table.push({ id: normalise(model.id), input, output, context: number(model.context) });
  }
  table.sort((a, b) => b.id.length - a.id.length);
  const aliases = new Map();
  if (isRecord(raw) && isRecord(raw.aliases)) {
    for (const [alias, id] of Object.entries(raw.aliases)) if (typeof id === "string") aliases.set(normalise(alias), normalise(id));
  }
  return { table, aliases };
}

export function normalise(id) {
  return String(id).trim().toLowerCase().replace(/^(anthropic[./]|us\.anthropic\.)/, "").replace(/\[.*\]$/, "").replace(/[._]/g, "-");
}

export function priceFor(model, prices) {
  if (typeof model !== "string" || !model.trim()) return null;
  const id = normalise(model);
  const wanted = prices.aliases.get(id) ?? id;
  return prices.table.find((entry) => wanted === entry.id || wanted.startsWith(`${entry.id}-`)) ?? null;
}

export function costOf(usage, price) {
  if (!isRecord(usage)) return null;
  const reported = number(usage.cost_usd);
  if (reported !== null) return { usd: reported, estimated: false };
  if (price === null) return null;
  const total = number(usage.tokens);
  if (total === null) return null;
  const output = Math.min(number(usage.output_tokens) ?? 0, total);
  return { usd: ((total - output) * price.input + output * price.output) / 1e6, estimated: true };
}

export function contextShare(usage, price) {
  const used = isRecord(usage) ? number(usage.context_tokens) : null;
  if (used === null || price === null || !price.context) return null;
  return Math.min(1, used / price.context);
}

export function dollars(usd) {
  if (usd < 0.01) return usd === 0 ? "$0" : "<$0.01";
  return usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}

export function chipsFor(agent, prices) {
  const price = priceFor(agent.model, prices);
  const chips = [];
  const cost = costOf(agent.usage, price);
  if (cost !== null) chips.push(cost.estimated ? { label: "Cost", value: dollars(cost.usd), hint: `Estimated from token counts at ${agent.model} prices` } : { label: "Cost", value: dollars(cost.usd), hint: "Reported by the agent" });
  const share = contextShare(agent.usage, price);
  if (share !== null) chips.push({ label: "Context", value: `${Math.round(share * 100)}%` });
  return chips;
}

const RUNNING = new Set(["pending", "in_progress", "running"]);

export function headerBlocks(state, prices) {
  const blocks = [];
  const entries = state.plan;
  if (entries.length > 0) {
    const done = entries.filter((entry) => entry.status === "completed").length;
    const current = entries.find((entry) => entry.status === "in_progress");
    blocks.push({ type: "progress", title: "Plan", label: current ? current.content.slice(0, 120) : done === entries.length ? "All steps done" : "Next step not started", value: done / entries.length });
  }
  const agents = [...state.agents.values()];
  let total = 0;
  let estimated = false;
  let priced = 0;
  for (const agent of agents) {
    const cost = costOf(agent.usage, priceFor(agent.model, prices));
    if (cost === null) continue;
    total += cost.usd;
    priced += 1;
    estimated ||= cost.estimated;
  }
  if (priced > 0) {
    const hint = priced < agents.length ? `${priced} of ${agents.length} subagents priced` : estimated ? "Estimated" : undefined;
    blocks.push({ type: "stats", items: [hint === undefined ? { label: "Cost", value: dollars(total) } : { label: "Cost", value: dollars(total), hint }] });
  }
  return blocks;
}

function planOf(data) {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries.filter(isRecord).map((entry) => ({ content: typeof entry.content === "string" ? entry.content : "", status: typeof entry.status === "string" ? entry.status : "pending" }));
}

export function createCrew(prices) {
  const threads = new Map();
  function threadState(id) {
    let state = threads.get(id);
    if (!state) {
      if (threads.size >= THREADS) threads.delete(threads.keys().next().value);
      state = { agents: new Map(), plan: [], shown: new Map() };
      threads.set(id, state);
    }
    return state;
  }
  function changed(state, place, publication) {
    const text = JSON.stringify(publication);
    if (state.shown.get(place) === text) return false;
    state.shown.set(place, text);
    return true;
  }
  function header(event, state) {
    const blocks = headerBlocks(state, prices);
    const publication = blocks.length === 0 ? { thread_id: event.thread_id, slot: "agents.header", key: "", clear: true } : { thread_id: event.thread_id, slot: "agents.header", key: "", blocks };
    if (blocks.length === 0 && !state.shown.has("header")) return [];
    return changed(state, "header", publication) ? [publication] : [];
  }
  return {
    handlers: {
      "subagent.update": (event) => {
        const data = event.data;
        const id = typeof data.tool_call_id === "string" ? data.tool_call_id : "";
        if (!id) return [];
        const state = threadState(event.thread_id);
        const before = state.agents.get(id);
        if (!before && state.agents.size >= AGENTS) return [];
        const agent = { status: typeof data.status === "string" ? data.status : before?.status ?? "in_progress", model: typeof data.model === "string" ? data.model : before?.model ?? null, usage: isRecord(data.usage) ? data.usage : before?.usage ?? null };
        state.agents.set(id, agent);
        const out = [];
        const chips = chipsFor(agent, prices);
        if (chips.length > 0) {
          const publication = { thread_id: event.thread_id, slot: "subagent.meta", key: id, chips };
          if (changed(state, `meta:${id}`, publication)) out.push(publication);
        }
        return [...out, ...header(event, state)];
      },
      "tool.call": (event) => {
        const data = event.data;
        const id = typeof data.tool_call_id === "string" ? data.tool_call_id : "";
        const state = threads.get(event.thread_id);
        if (!state || !id || !state.agents.has(id)) return [];
        const agent = state.agents.get(id);
        if (typeof data.status === "string") agent.status = data.status;
        return header(event, state);
      },
      "plan.update": (event) => {
        const state = threadState(event.thread_id);
        state.plan = planOf(event.data);
        return header(event, state);
      },
      "turn.end": (event) => {
        const state = threads.get(event.thread_id);
        if (!state) return [];
        for (const agent of state.agents.values()) if (RUNNING.has(agent.status)) agent.status = "completed";
        return header(event, state);
      },
    },
  };
}
