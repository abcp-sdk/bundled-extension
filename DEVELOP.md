# Developing `@abc-protocol/bundled-extension`

Developer notes: code style, conventions, build/test commands, and non-obvious
decisions. Keep this file up to date so the next session does not have to
re-discover things.

## Commands

```sh
npm ci            # install (uses the registry from .npmrc)
npm run build     # tsc -p tsconfig.json -> dist/
npm run check     # biome check .
npm run check:types
npm test          # vitest run
```

## Publishing & consuming via artifact (not GitHub/npmjs)
- Consume: .npmrc → registry=http://artifact.worker.svc.cluster.local/artifacts/npm/
- Publish: scoped name + npm publish --access public (_authToken in .npmrc)
- Interim: consumers use the cluster Forgejo git dep (not github:abcp-sdk/...).
See easy-vcs/deploy:PUBLISHING.md.

## History tools: full-chain traversal, paging, and the render budget

`history-range` / `history-search` (src/memory.ts) share three contracts:

- **No hidden depth cap.** They traverse the FULL chain via
  `deps.messageChain(tenant, tip, 0)`; `limit <= 0` means "no cap" (the agent
  host must honor this). `history-range`'s `limit` caps only the RETURNED
  message count — never the traversal depth — so deep windows
  (e.g. `from=900,to=1000`) are not silently empty. `data.total` is the full
  chain length.
- **Paging.** `history-search` returns one page `[offset, offset+limit)` over
  all matches (newest-first) and reports `data.has_more` / `data.next_offset`.
  `history-range` also reports `has_more`/`next_offset` for the window it cut
  short by `limit`.
- **Render budget, never a per-message cut.** `renderHistoryList` emits each
  message's FULL content. `max_total_chars` (default 100000; `0` = unlimited)
  accumulates meta+content; when adding the next entry would exceed the budget
  that entry is STILL emitted in full and the list then stops (the total may
  slightly exceed the budget). `data.entries[].content` is always complete;
  only the rendered text is bounded.

If `abc-protocol/agent`'s `messageChain` implementation changes the
`limit <= 0 = no cap` semantics, keep `src/deps.ts`'s `messageChain` doc and
`tests/history.test.ts` (whose stub mirrors it) in sync.
