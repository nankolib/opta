# MemoryMax on the shared VPS (<VPS_IP>, 1958 MB total)

Live measurement (Gate 2A, 2026-07-17):

| Process | RSS (MemoryCurrent) |
|---|---|
| opta-crank (node + ts-node) | ~164 MB |
| opta-quotes (quotes-svc.js) | ~56 MB |
| nginx (master + worker) | ~23 MB |
| **MemAvailable** | **~1148 MB** |
| Swap | 5.4 GB (154 MB used) |

`opta-writer` runs **precompiled** (`node dist/main.js`, no ts-node), so it should
sit **below** the crank's ts-node footprint — budget ~150–250 MB RSS.

**Chosen caps** (so one service's OOM cannot take down the other):

- `opta-writer.service`: `MemoryMax=350M` (already set in `opta-writer.service`).
- `opta-crank.service`: **add** `MemoryMax=400M` (2.4× its live 164 MB).

Combined hard cap = 750 MB of 1958 MB → ~1.2 GB headroom + 5.4 GB swap backstop.

## Apply the crank cap on the box (one-time, alongside the writer deploy)

```bash
# On <VPS_IP>:
sudo systemctl edit opta-crank          # (or edit the unit directly)
# add under [Service]:
#   MemoryMax=400M
sudo systemctl daemon-reload
sudo systemctl restart opta-crank --no-block   # then poll one tick's structured log
```

The crank unit is VPS-only (not in the repo), so this edit is applied directly on
the box — it is intentionally not committed here.
