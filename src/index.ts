/**
 * Bundled extension: tools + config declared in manifest.yaml (with zh/en
 * `descriptions`), handlers (execute) implemented per-module. The SDK's
 * parseManifest/manifestConfig (fixed in v1.0.8) keeps the tool-level and
 * config-level `descriptions` maps, so the wire manifest carries them and the
 * agent localizes via `pickDescription`/`localizeSchema`.
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
    ...Object.fromEntries(
      Object.entries(memoryExecutes(deps)).map(([k, v]) => [k, { execute: v }]),
    ),
    'web-fetch': { execute: webFetchExecute },
    'brave-search': { execute: braveSearchExecute(deps) },
    ...Object.fromEntries(
      Object.entries(imageGenExecutes(deps)).map(([k, v]) => [k, { execute: v }]),
    ),
  }
  return manifestConfig(manifest, { handlers })
}
