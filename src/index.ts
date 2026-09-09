/**
 * Bundled extension: tools declared in manifest.yaml (with zh/en
 * `descriptions`), handlers (execute) implemented per-module. We use the SDK's
 * `parseManifest` + `manifestConfig`, so the wire manifest carries the
 * localized `descriptions` and property-level descriptions verbatim — the
 * agent localizes tool descriptions/schemas via `pickDescription`/`localizeSchema`.
 */

import { parseManifest, manifestConfig } from '@abc-protocol/sdk'
import type { ExtensionConfig, ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import manifestYaml from '../manifest.yaml'
import { webFetchExecute } from './webfetch.js'
import { braveSearchExecute } from './brave-search.js'
import { imageGenExecutes } from './image.js'
import { memoryExecutes } from './memory.js'

export * from './deps.js'
export * from './serve.js'
export type { BundledDeps }

const manifest = parseManifest(manifestYaml)

/**
 * Build the bundled extension's protocol config. A single `ExtensionConfig`
 * declares every tool's schema + handler, surfaced over the abc protocol.
 * The agent server injects [deps] at boot so this extension has no import of
 * agent source (it is a standalone lib that can also be served in-process).
 */
export function createBundledConfig(deps: BundledDeps): ExtensionConfig {
  const handlers: Record<string, { execute: ToolSpec['execute'] }> = {
    ...memoryExecutes(deps),
    'web-fetch': { execute: webFetchExecute },
    'brave-search': { execute: braveSearchExecute(deps) },
    ...imageGenExecutes(deps),
  }
  return manifestConfig(manifest, { handlers })
}
