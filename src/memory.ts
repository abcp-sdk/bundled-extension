/**
 * Memory / history / file / vision tool handlers, ported from the Go
 * memory-extension but backed by the agent's sqlite DB + injected blob store +
 * LLM registry (no Postgres, no self-hosted HTTP). Tool descriptions/schemas
 * are declared in manifest.yaml (with `descriptions.zh`); this module exposes
 * the execute handlers only.
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'

interface TodoRow {
  content?: string
  status?: string
  priority?: string
  created_unix?: number
}

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

function numArg(m: Record<string, unknown>, k: string, def: number): number {
  const v = m[k]
  if (typeof v === 'number') return v
  return def
}

/** The bundled extension's `todos` table, created idempotently in the agent DB. */

/** Build the memory/history/file/vision execute handlers bound to [deps]. */
export function memoryExecutes(deps: BundledDeps): Record<string, ToolSpec['execute']> {
  // Ensure the todos table exists (idempotent) at tool-set construction time.
  void deps.todosEnsure().catch(() => {})

  const writeTodos = async (
    tenant: string,
    sid: string,
    todos: Record<string, unknown>[],
  ): Promise<number> => {
    await deps.todosReplace(
      tenant,
      sid,
      todos.map(t => ({
        content: strArg(t, 'content'),
        status: strArg(t, 'status') || 'pending',
        priority: strArg(t, 'priority') || 'medium',
      })),
    )
    return todos.length
  }

  const sessionTip = (tenant: string, sid: string): Promise<string> =>
    deps.sessionTip(tenant, sid)

  const chainRaw = (tenant: string, tip: string, limit: number) =>
    deps.messageChain(tenant, tip, limit).then(rows =>
      rows.map(r => ({ id: r.id, role: r.role, created: r.createdAt, depth: r.depth })),
    )

  const textPartsForMessages = async (
    tenant: string,
    ids: string[],
    query: string,
  ): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    if (ids.length === 0) return out
    const rows = await deps.messageParts(tenant, ids)
    for (const r of rows) {
      if (r.type !== 'text') continue
      const mid = r.messageId
      try {
        const v = JSON.parse(r.data) as { text?: string }
        const t = v.text ?? ''
        if (query !== '' && !t.toLowerCase().includes(query.toLowerCase())) continue
        out.set(mid, (out.get(mid) ?? '') + t)
      } catch {
        /* ignore malformed */
      }
    }
    return out
  }

  const partsForMessages = async (
    tenant: string,
    ids: string[],
  ): Promise<Map<string, { name: string; changeID: string }[]>> => {
    const out = new Map<string, { name: string; changeID: string }[]>()
    if (ids.length === 0) return out
    const rows = await deps.messageParts(tenant, ids)
    for (const r of rows) {
      const mid = r.messageId
      const typ = r.type
      try {
        const v = JSON.parse(r.data) as Record<string, unknown>
        const item = { name: '', changeID: '' }
        if (typ === 'tool') item.name = strArg(v, 'name')
        else if (typ === 'tool_result') {
          const md = v['metadata'] as Record<string, unknown> | undefined
          if (md) item.changeID = strArg(md, 'change_id')
        }
        const list = out.get(mid) ?? []
        list.push(item)
        out.set(mid, list)
      } catch {
        /* ignore malformed */
      }
    }
    return out
  }

  const renderHistoryList = (locale: string, entries: Array<Record<string, unknown>>): string => {
    if (entries.length === 0) return 'history_search: no matching messages.'
    const label = locale.startsWith('zh') ? '历史' : 'history'
    const lines: string[] = [`${label} ${entries.length} 条：`]
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const role = String(e['role'] ?? '?')
      let meta = `[${i}] ${role} (depth ${String(e['depth'] ?? 0)})`
      if (String(e['created_at'] ?? '') !== '') meta += ' ' + String(e['created_at'])
      if (String(e['tool_name'] ?? '') !== '') meta += ' tool=' + String(e['tool_name'])
      if (String(e['change_id'] ?? '') !== '') meta += ' change=' + String(e['change_id'])
      const body = String(e['content'] ?? '')
      const truncated = body.length > 200 ? body.slice(0, 200) + '…' : body
      lines.push(meta)
      if (truncated !== '') lines.push('    ' + truncated)
    }
    return lines.join('\n')
  }

  const buildHistoryEntries = async (
    tenant: string,
    sid: string,
    query: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> => {
    const tip = await sessionTip(tenant, sid)
    if (tip === '') return []
    const chain = await chainRaw(tenant, tip, 10000)
    const ids = chain.map(c => c.id)
    const textByMsg = await textPartsForMessages(tenant, ids, query)
    const toolByMsg = await partsForMessages(tenant, ids)
    const out: Array<Record<string, unknown>> = []
    for (const r of chain) {
      const content = textByMsg.get(r.id) ?? ''
      let toolName = ''
      let changeID = ''
      const parts = toolByMsg.get(r.id)
      if (parts) {
        for (const p of parts) {
          if (toolName === '') toolName = p.name
          if (changeID === '') changeID = p.changeID
        }
      }
      if (query !== '') {
        const hay = (content + ' ' + toolName + ' ' + changeID).toLowerCase()
        if (!hay.includes(query.toLowerCase())) continue
      }
      out.push({
        session: sid,
        role: r.role,
        content,
        tool_name: toolName,
        change_id: changeID,
        created_at: r.created,
        depth: r.depth,
      })
      if (out.length >= limit) break
    }
    return out
  }

  const fileMetaFromBlob = async (
    code: string,
    tenant: string,
  ): Promise<Record<string, unknown>> => {
    const res = await deps.blobGet(code, tenant)
    return res.meta
  }

  const vlmRead = async (
    prompt: string,
    imageDataUrl: string,
    tenant: string,
    locale: string,
  ): Promise<string> => {
    const modelId = String(await deps.resolveConfig('model.text', undefined, tenant) ?? '')
    if (modelId === '') throw new Error(tr(locale, 'visionNotConfigured'))
    const resolved = await deps.resolveModel(null as never, modelId, tenant)
    if (resolved.isErr()) {
      throw new Error(
        tr(locale, 'visionNotFound', { error: resolved.error ?? tr(locale, 'modelNotFound') }),
      )
    }
    const model = resolved.value!.model
    const { generateText } = await import('ai')
    const res = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', image: imageDataUrl },
          ],
        },
      ],
    })
    return res.text
  }

  const imageRead = async (
    code: string,
    prompt: string,
    sessionName: string,
    tenant: string,
    locale: string,
  ): Promise<{ content: string; data: Record<string, unknown> }> => {
    const meta = await fileMetaFromBlob(code, tenant)
    const mime = String(meta['mime'] ?? '')
    if (!mime.startsWith('image/')) {
      throw new Error(tr(locale, 'imageNotImage', { code, mime }))
    }
    const blob = await deps.blobGet(code, tenant)
    const b64 = Buffer.from(blob.data).toString('base64')
    const dataUrl = `data:${mime};base64,${b64}`
    const text = await vlmRead(prompt, dataUrl, tenant, locale)
    return {
      content: text,
      data: {
        model: String(await deps.resolveConfig('model.text', undefined, tenant) ?? ''),
        code,
        mime,
        size: Number(meta['size'] ?? 0),
      },
    }
  }

  const toolError = (msg: string): never => {
    throw new Error(msg)
  }

  return {
    'todo-write': async (args, _callId, sessionName, _signal, tenant = '') => {
      if (!sessionName) toolError('missing session context (session_name)')
      const todos = Array.isArray(args['todos'])
        ? (args['todos'] as Record<string, unknown>[])
        : []
      const n = await writeTodos(tenant, sessionName, todos)
      const locale = await localeOf(deps, tenant, sessionName)
      return { content: tr(locale, 'todosUpdated', { n }), data: { count: n } }
    },
    'history-search': async (args, _callId, sessionName, _signal, tenant = '') => {
      if (!sessionName) toolError('missing session context (session_name)')
      const query = strArg(args, 'query')
      const from = strArg(args, 'from')
      const to = strArg(args, 'to')
      const limit = numArg(args, 'limit', 50)
      const entries = await buildHistoryEntries(tenant, sessionName, query, limit)
      const filtered = entries.filter(e => {
        if (from !== '' && String(e['created_at']) < from) return false
        if (to !== '' && String(e['created_at']) > to) return false
        return true
      })
      const locale = await localeOf(deps, tenant, sessionName)
      const content = renderHistoryList(locale, filtered)
      return { content, data: { count: filtered.length, entries } }
    },
    'history-range': async (args, _callId, sessionName, _signal, tenant = '') => {
      if (!sessionName) toolError('missing session context (session_name)')
      const from = numArg(args, 'from', 0)
      const to = numArg(args, 'to', 0)
      const limit = numArg(args, 'limit', 200)
      const chain = await chainRaw(tenant, await sessionTip(tenant, sessionName), limit)
      const total = chain.length
      const norm = (d: number): number => (d < 0 ? total + d : d)
      let f = norm(from)
      let t = norm(to)
      if (f < 0) f = 0
      if (t > total) t = total
      if (f >= t) return { content: tr(await localeOf(deps, tenant, sessionName), 'historyRangeEmpty'), data: { count: 0 } }
      const ids = chain.map(c => c.id)
      const textByMsg = await textPartsForMessages(tenant, ids, '')
      const toolByMsg = await partsForMessages(tenant, ids)
      const entries = chain.slice(f, t).map(r => {
        let toolName = ''
        let changeID = ''
        const parts = toolByMsg.get(r.id)
        if (parts) {
          for (const p of parts) {
            if (toolName === '') toolName = p.name
            if (changeID === '') changeID = p.changeID
          }
        }
        return {
          session: sessionName,
          role: r.role,
          content: textByMsg.get(r.id) ?? '',
          tool_name: toolName,
          change_id: changeID,
          created_at: r.created,
          depth: r.depth,
        }
      })
      const locale = await localeOf(deps, tenant, sessionName)
      const content = renderHistoryList(locale, entries)
      return { content, data: { count: entries.length, entries } }
    },
    'file-info': async (args, _callId, sessionName, _signal, tenant = '') => {
      const locale = await localeOf(deps, tenant, sessionName ?? '')
      const code = strArg(args, 'code')
      if (code === '') toolError(tr(locale, 'codeRequired'))
      const meta = await fileMetaFromBlob(code, tenant)
      const content = tr(locale, 'fileInfo', {
        code,
        name: String(meta['name'] ?? ''),
        mime: String(meta['mime'] ?? ''),
        bytes: Number(meta['size'] ?? 0),
        sha256: String(meta['sha256'] ?? ''),
      })
      return { content, data: { meta } }
    },
    'image-read': async (args, _callId, sessionName, _signal, tenant = '') => {
      const locale = await localeOf(deps, tenant, sessionName ?? '')
      const code = strArg(args, 'code')
      if (code === '') toolError(tr(locale, 'codeRequired'))
      let prompt = strArg(args, 'prompt')
      if (prompt === '') prompt = 'Describe this image in detail.'
      const res = await imageRead(code, prompt, sessionName, tenant, locale)
      return { content: res.content, data: res.data }
    },
  }
}
