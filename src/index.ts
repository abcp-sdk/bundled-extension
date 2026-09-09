import type { ExtensionConfig } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { memoryTools } from './memory.js'
import { webFetchTool } from './webfetch.js'
import { braveSearchTool } from './brave-search.js'
import { imageGenTool } from './image.js'
import { configSpec } from './config-spec.js'

export * from './deps.js'
export * from './serve.js'
export type { BundledDeps }

/**
 * Build the bundled extension's protocol config. A single `ExtensionConfig`
 * declares every tool's schema + handler, surfaced over the abc protocol.
 * The agent server injects [deps] at boot so this extension has no import of
 * agent source (it is a standalone lib that can also be served in-process).
 */
export function createBundledConfig(deps: BundledDeps): ExtensionConfig {
  const tools = {
    ...memoryTools(deps),
    ...webFetchTool(),
    ...braveSearchTool(deps),
    ...imageGenTool(deps),
  }
  return {
    id: 'bundled',
    version: '0.1.0',
    tools,
    config: configSpec(),
  }
}