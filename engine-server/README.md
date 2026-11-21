# BTC FlowDesk PRO server-side PAPER engine

Independent PRO engine process, isolated from the LIVE dashboard and its storage.

- Default port: 3002
- Bind: 127.0.0.1
- State: engine-server/data/state.json
- REST market ticker polling every 5 seconds; strategy loop every second.
- Paper only. No exchange order execution.

This is a starter engine and is **not yet hardened, dashboard-connected, or deployed**.
Before enabling: audit API protection, stale-feed safety, config validation, restart behavior, and paper tests.
