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
