import { readFileSync } from "node:fs";
import { runStdio } from "./lib/wire.mjs";
import { createCrew, parsePrices } from "./lib/crew.mjs";

let prices = parsePrices(null);
try {
  prices = parsePrices(JSON.parse(readFileSync(new URL("./prices.json", import.meta.url), "utf8")));
} catch {
  prices = parsePrices(null);
}

runStdio(() => createCrew(prices));
