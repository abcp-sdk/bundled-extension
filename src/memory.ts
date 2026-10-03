/**
 * Memory / history / file / vision tool handlers, ported from the Go
 * memory-extension but backed by the agent's sqlite DB + injected blob store +
 * LLM registry (no Postgres, no self-hosted HTTP). Tool descriptions/schemas
 * are declared in manifest.yaml (with `descriptions.zh`); this module exposes
 * the execute handlers only.
 */

import { numArg as numArgRaw, strArg, type ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'

/** Read a number argument with a fallback default (built on the SDK's
 *  undefined-for-invalid extension-kit primitive). */
function numArg(m: Record<string, unknown>, k: string, def: number): number {
  return numArgRaw(m, k) ?? def
}

/**
 * True for mime types `file-read` treats as readable plain text: anything
 * `text/*`, plus the common JSON/XML/YAML/TOML/CSV shapes. Office documents
 * (docx/xlsx/pptx) and other binaries are deliberately excluded.
 */
function isReadableTextMime(mime: string): boolean {
  const m = mime.toLowerCase()
  if (m.startsWith('text/')) return true
  return (
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/x-yaml' ||
    m === 'application/yaml' ||
    m === 'application/toml' ||
    m === 'application/javascript' ||
    m === 'application/typescript' ||
    m === 'application/x-sh'
  )
}

/** Split text into lines, tolerating CRLF/CR and dropping a trailing newline. */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The bundled extension's `todos` table, created idempotently in the agent DB. */

/** Build the memory/history/file/vision execute handlers bound to [deps]. */
export function memoryExecutes(
  deps: BundledDeps,
): Record<string, ToolSpec['execute']> {
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
      rows.map(r => ({
        id: r.id,
        role: r.role,
        created: r.createdAt,
        depth: r.depth,
      })),
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
        if (query !== '' && !t.toLowerCase().includes(query.toLowerCase()))
          continue
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

  /**
   * Render history entries as text. Every message is emitted in FULL — a
   * single entry is NEVER truncated. `maxTotalChars` is a total budget:
   * entries accumulate (meta + full content chars) and, when adding the
   * NEXT entry would exceed the budget, that entry is still emitted in full
   * and the list then STOPS (so the last entry may push the total slightly
   * past the budget). `maxTotalChars <= 0` disables the budget. At least one
   * entry is always emitted. Returns the text and the count actually shown.
   */
  const renderHistoryList = (
    locale: string,
    entries: Array<Record<string, unknown>>,
    maxTotalChars: number,
  ): { content: string; shown: number } => {
    if (entries.length === 0)
      return { content: 'history_search: no matching messages.', shown: 0 }
    const label = locale.startsWith('zh') ? '历史' : 'history'
    const itemLines: string[] = []
    let total = 0
    let shown = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const role = String(e['role'] ?? '?')
      let meta = `[${i}] ${role} (depth ${String(e['depth'] ?? 0)})`
      if (String(e['created_at'] ?? '') !== '')
        meta += ` ${String(e['created_at'])}`
      if (String(e['tool_name'] ?? '') !== '')
        meta += ` tool=${String(e['tool_name'])}`
      if (String(e['change_id'] ?? '') !== '')
        meta += ` change=${String(e['change_id'])}`
      const body = String(e['content'] ?? '')
      const wouldExceed =
        maxTotalChars > 0 && total + meta.length + body.length > maxTotalChars
      // Never truncate a single message: emit this one in full, then stop if
      // it is the entry that pushed us over the budget.
      itemLines.push(meta)
      if (body !== '') itemLines.push(`    ${body}`)
      total += meta.length + body.length
      shown++
      if (wouldExceed) break
    }
    const out = [`${label} ${shown} 条：`, ...itemLines]
    if (shown < entries.length) {
      out.push(
        locale.startsWith('zh')
          ? `（已达 ${maxTotalChars} 字符预算，仅显示前 ${shown} 条）`
          : `(reached ${maxTotalChars}-char budget; showing first ${shown})`,
      )
    }
    return { content: out.join('\n'), shown }
  }

  /**
   * Collect EVERY match over the FULL chain (no depth cap), newest-first.
   * Pagination and the render budget are applied by the caller so that early
   * history is searchable and paging is possible.
   */
  const buildHistoryEntries = async (
    tenant: string,
    sid: string,
    query: string,
  ): Promise<Array<Record<string, unknown>>> => {
    const tip = await sessionTip(tenant, sid)
    if (tip === '') return []
    const chain = await chainRaw(tenant, tip, 0)
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
        const hay = `${content} ${toolName} ${changeID}`.toLowerCase()
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
    const modelId = String(
      (await deps.resolveConfig('model.text', undefined, tenant)) ?? '',
    )
    if (modelId === '') throw new Error(tr(locale, 'visionNotConfigured'))
    const resolved = await deps.resolveModel(null as never, modelId, tenant)
    if (resolved.isErr()) {
      throw new Error(
        tr(locale, 'visionNotFound', {
          error: resolved.error ?? tr(locale, 'modelNotFound'),
        }),
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
    _sessionName: string,
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
        model: String(
          (await deps.resolveConfig('model.text', undefined, tenant)) ?? '',
        ),
        code,
        name: String(meta['name'] ?? ''),
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
    'history-search': async (
      args,
      _callId,
      sessionName,
      _signal,
      tenant = '',
    ) => {
      if (!sessionName) toolError('missing session context (session_name)')
      const query = strArg(args, 'query')
      const from = strArg(args, 'from')
      const to = strArg(args, 'to')
      const offset = Math.max(0, Math.floor(numArg(args, 'offset', 0)))
      const limit = Math.max(0, Math.floor(numArg(args, 'limit', 50)))
      const maxTotalChars = Math.max(
        0,
        Math.floor(numArg(args, 'max_total_chars', 100000)),
      )
      const all = await buildHistoryEntries(tenant, sessionName, query)
      const filtered = all.filter(e => {
        if (from !== '' && String(e['created_at']) < from) return false
        if (to !== '' && String(e['created_at']) > to) return false
        return true
      })
      const total = filtered.length
      const page =
        limit > 0
          ? filtered.slice(offset, offset + limit)
          : filtered.slice(offset)
      const locale = await localeOf(deps, tenant, sessionName)
      const rendered = renderHistoryList(locale, page, maxTotalChars)
      const entries = page.slice(0, rendered.shown)
      const consumed = offset + rendered.shown
      const hasMore = consumed < total
      return {
        content: rendered.content,
        data: {
          count: entries.length,
          total,
          offset,
          has_more: hasMore,
          next_offset: hasMore ? consumed : null,
          entries,
        },
      }
    },
    'history-range': async (
      args,
      _callId,
      sessionName,
      _signal,
      tenant = '',
    ) => {
      if (!sessionName) toolError('missing session context (session_name)')
      const from = numArg(args, 'from', 0)
      const to = numArg(args, 'to', 0)
      const limit = Math.max(0, Math.floor(numArg(args, 'limit', 200)))
      const maxTotalChars = Math.max(
        0,
        Math.floor(numArg(args, 'max_total_chars', 100000)),
      )
      // Traverse the WHOLE chain (limit <= 0 = no depth cap); `limit` below is
      // only the RETURN cap, so deep windows are never silently empty.
      const chain = await chainRaw(
        tenant,
        await sessionTip(tenant, sessionName),
        0,
      )
      const total = chain.length
      const norm = (d: number): number => (d < 0 ? total + d : d)
      let f = norm(from)
      let t = norm(to)
      if (f < 0) f = 0
      if (t > total) t = total
      const locale = await localeOf(deps, tenant, sessionName)
      if (f >= t)
        return {
          content: tr(locale, 'historyRangeEmpty'),
          data: {
            count: 0,
            total,
            offset: f,
            has_more: false,
            next_offset: null,
          },
        }
      let window = chain.slice(f, t)
      if (limit > 0 && window.length > limit) window = window.slice(0, limit)
      const ids = window.map(c => c.id)
      const textByMsg = await textPartsForMessages(tenant, ids, '')
      const toolByMsg = await partsForMessages(tenant, ids)
      const built = window.map(r => {
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
      const rendered = renderHistoryList(locale, built, maxTotalChars)
      const entries = built.slice(0, rendered.shown)
      const consumed = f + rendered.shown
      const hasMore = consumed < t
      return {
        content: rendered.content,
        data: {
          count: entries.length,
          total,
          offset: f,
          has_more: hasMore,
          next_offset: hasMore ? consumed : null,
          entries,
        },
      }
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
    'file-read': async (args, _callId, sessionName, _signal, tenant = '') => {
      const locale = await localeOf(deps, tenant, sessionName ?? '')
      const code = strArg(args, 'code')
      if (code === '') toolError(tr(locale, 'codeRequired'))
      const blob = await deps.blobGet(code, tenant)
      const mime = String(blob.meta['mime'] ?? '')
      if (!isReadableTextMime(mime)) {
        toolError(tr(locale, 'fileNotText', { code, mime: mime || 'unknown' }))
      }
      const offset = Math.max(0, Math.floor(numArg(args, 'offset', 0)))
      const limit = Math.min(
        Math.max(1, Math.floor(numArg(args, 'limit', 200))),
        1000,
      )
      const all = splitLines(new TextDecoder('utf-8').decode(blob.data))
      const total = all.length
      const start = Math.min(offset, total)
      const lines = all.slice(start, start + limit)
      const end = start + lines.length
      const width = String(Math.max(end, 1)).length
      let content =
        lines.length === 0
          ? tr(locale, 'fileReadEmpty')
          : lines
              .map(
                (l, i) => `${String(start + i + 1).padStart(width, ' ')}  ${l}`,
              )
              .join('\n')
      if (end < total) {
        content += tr(locale, 'fileReadShowingLines', {
          start: start + 1,
          end,
          total,
          more: tr(locale, 'fileReadMore'),
        })
      }
      return {
        content,
        data: {
          code,
          name: String(blob.meta['name'] ?? ''),
          mime,
          total_lines: total,
          start,
          shown: lines.length,
        },
      }
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
