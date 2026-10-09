# Crew

A built-in [CommissionAI](https://github.com/patrick-lai) mod (protocol 3). Adds cost and context use to the Subagents tab.

Each subagent row gets an estimated cost (the agent's own figure when it reports one, else tokens × `prices.json`) and the share of its context window in use; models it doesn't know get no chip rather than a guess. The top of the tab shows plan progress, the running count and the total. Update `prices.json` here to change prices without an app release.

## Rules it follows
- It only adds beside a core surface; with it off, crashed or outdated, the app looks and behaves exactly as without it.
- It never allows, rejects or delays anything, and never saves anything without a button the person presses.

## Develop
```sh
node --test 'mods/crew/test/*.test.mjs'
COMMISSION_MODS_DIR=$PWD/mods   # point a dev daemon at this checkout; edits show on the next event or refresh
```
Node 20 or newer, no npm dependencies. The contract (manifest, worker protocol, hooks, capabilities, slots) is in CommissionAI's `docs/mods.md`, section "Protocol 3".

## Ship
CommissionAI registers this repository as a built-in pack and follows its head: push to `main` and every install picks it up within a day, without an app release.
