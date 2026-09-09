/**
 * Memory / history / file / vision tools, ported from the Go memory-extension
 * but backed by the agent's sqlite DB + injected blob store + LLM registry
 * (no Postgres, no self-hosted HTTP). Tool names follow the snake->dash
 * convention: `todo-write` (was todowrite).
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

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

function fmt(locale: string, en: string, zh: string): string {
  return locale.startsWith('zh') ? zh : en
}

/** The memory extension's `todos` table, created idempotently in the agent DB. */
const TODOS_DDL = `
CREATE TABLE IF NOT EXISTS bundled_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  created_unix INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_bundled_todos_session ON bundled_todos (session_id);
`

export function memoryTools(deps: BundledDeps): Record<string, ToolSpec> {
  // Ensure the todos table exists (idempotent) at tool-set construction time.
  void deps.rawRun(TODOS_DDL).catch(() => {})

  const writeTodos = async (sid: string, todos: Record<string, unknown>[]): Promise<number> => {
    await deps.rawRun(`DELETE FROM bundled_todos WHERE session_id = ?`, [sid])
    for (const t of todos) {
      const content = strArg(t, 'content')
      const status = strArg(t, 'status') || 'pending'
      const priority = strArg(t, 'priority') || 'medium'
      await deps.rawRun(
        `INSERT INTO bundled_todos (session_id, content, status, priority) VALUES (?,?,?,?)`,
        [sid, content, status, priority],
      )
    }
    return todos.length
  }

  const listTodos = async (sid: string): Promise<TodoRow[]> => {
    const rows = await deps.rawAll(
      `SELECT content, status, priority, created_unix FROM bundled_todos WHERE session_id = ? ORDER BY id`,
      [sid],
    )
    return rows.map(r => ({
      content: String(r['content'] ?? ''),
      status: String(r['status'] ?? 'pending'),
      priority: String(r['priority'] ?? 'medium'),
      created_unix: Number(r['created_unix'] ?? 0),
    }))
  }

  // ---- session chain (reuse agent sqlite: messages.tip_id / prev_id) ----

  const sessionTip = async (sid: string): Promise<string> => {
    const rows = await deps.rawAll(`SELECT tip_id FROM sessions WHERE name = ?`, [sid])
    if (rows.length === 0) return ''
    return String(rows[0]!['tip_id'] ?? '')
  }

  const chainRaw = async (tip: string, limit: number): Promise<Array<{ id: string; role: string; created: string; depth: number }>> => {
    const rows = await deps.rawAll(
      `WITH RECURSIVE chain AS (
         SELECT m.id, m.role, m.prev_id, m.created_at, 0 AS depth
         FROM messages m WHERE m.id = ?
         UNION ALL
         SELECT m.id, m.role, m.prev_id, m.created_at, c.depth + 1
         FROM messages m JOIN chain c ON m.id = c.prev_id
       )
       SELECT id, role, created_at, depth FROM chain WHERE depth < ? ORDER BY depth ASC`,
      [tip, limit],
    )
    return rows.map(r => ({
      id: String(r['id'] ?? ''),
      role: String(r['role'] ?? ''),
      created: String(r['created_at'] ?? ''),
      depth: Number(r['depth'] ?? 0),
    }))
  }

  const textPartsForMessages = async (ids: string[], query: string): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    if (ids.length === 0) return out
    const placeholders = ids.map(() => '?').join(',')
    const rows = await deps.rawAll(
      `SELECT message_id, data FROM parts WHERE message_id IN (${placeholders}) AND type = 'text'
       ORDER BY message_id, seq`,
      ids,
    )
    for (const r of rows) {
      const mid = String(r['message_id'] ?? '')
      const data = String(r['data'] ?? '')
      try {
        const v = JSON.parse(data) as { text?: string }
        const t = v.text ?? ''
        if (query !== '' && !t.toLowerCase().includes(query.toLowerCase())) continue
        out.set(mid, (out.get(mid) ?? '') + t)
      } catch {
        /* ignore malformed */
      }
    }
    return out
  }

  const partsForMessages = async (ids: string[]): Promise<Map<string, { name: string; changeID: string }[]>> => {
    const out = new Map<string, { name: string; changeID: string }[]>()
    if (ids.length === 0) return out
    const placeholders = ids.map(() => '?').join(',')
    const rows = await deps.rawAll(
      `SELECT message_id, type, data FROM parts WHERE message_id IN (${placeholders}) ORDER BY message_id, seq`,
      ids,
    )
    for (const r of rows) {
      const mid = String(r['message_id'] ?? '')
      const typ = String(r['type'] ?? '')
      const data = String(r['data'] ?? '')
      try {
        const v = JSON.parse(data) as Record<string, unknown>
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
        /* ignore */
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
    sid: string,
    query: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> => {
    const tip = await sessionTip(sid)
    if (tip === '') return []
    const chain = await chainRaw(tip, 10000)
    const ids = chain.map(c => c.id)
    const textByMsg = await textPartsForMessages(ids, query)
    const toolByMsg = await partsForMessages(ids)
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

  const fileMetaFromBlob = async (code: string): Promise<Record<string, unknown>> => {
    const res = await deps.blobGet(code)
    return res.meta
  }

  // ---- file / image handlers ----

  const vlmRead = async (prompt: string, imageDataUrl: string): Promise<string> => {
    const modelId = String(await deps.resolveConfig('vlm_model') ?? '')
    if (modelId === '') throw new Error('vlm_model not configured: set a vision model first')
    const resolved = await deps.resolveModel(null as never, modelId)
    if (resolved.isErr()) throw new Error(resolved.error ?? 'vision model not found')
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

  const imageRead = async (code: string, prompt: string, sessionName: string): Promise<{ content: string; data: Record<string, unknown> }> => {
    const meta = await fileMetaFromBlob(code)
    const mime = String(meta['mime'] ?? '')
    if (!mime.startsWith('image/')) {
      throw new Error(`file ${code} is not an image (${mime})`)
    }
    const blob = await deps.blobGet(code)
    const b64 = Buffer.from(blob.data).toString('base64')
    const dataUrl = `data:${mime};base64,${b64}`
    const text = await vlmRead(prompt, dataUrl)
    return {
      content: text,
      data: {
        model: String(await deps.resolveConfig('vlm_model') ?? ''),
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
    'todo-write': {
      description: "Replace the session's todo list (stored in the database, not a file).",
      descriptions: {
        zh: '替换会话的待办列表（存于数据库，而非文件）。',
      },
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full todo list to replace the session current one.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Todo item text.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'Todo status.' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Todo priority.' },
              },
              required: ['content', 'status', 'priority'],
            },
          },
        },
        required: ['todos'],
      },
      execute: async (args, _callId, sessionName) => {
        if (!sessionName) toolError('missing session context (session_name)')
        const todos = Array.isArray(args['todos'])
          ? (args['todos'] as Record<string, unknown>[])
          : []
        const n = await writeTodos(sessionName, todos)
        return { content: `Updated ${n} todo(s).`, data: { count: n } }
      },
    },
    'history-search': {
      description: "Search this session's chat history by keyword (case-insensitive substring over parts(type=text) text, tool names and change ids), optionally constrained to a time range [from, to] (YYYY-MM-DD HH:MM:SS). Returns messages newest-first with their role, depth (0 = newest), tool name and workspace change id.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive keyword matched against message text, tool names and change ids.' },
          from: { type: 'string', description: 'Inclusive lower time bound (YYYY-MM-DD HH:MM:SS).' },
          to: { type: 'string', description: 'Inclusive upper time bound (YYYY-MM-DD HH:MM:SS).' },
          limit: { type: 'integer', description: 'Maximum number of messages to return (default 50).' },
        },
        required: ['query'],
      },
      execute: async (args, _callId, sessionName) => {
        if (!sessionName) toolError('missing session context (session_name)')
        const query = strArg(args, 'query')
        const from = strArg(args, 'from')
        const to = strArg(args, 'to')
        const limit = numArg(args, 'limit', 50)
        const entries = await buildHistoryEntries(sessionName, query, limit)
        const filtered = entries.filter(e => {
          if (from !== '' && String(e['created_at']) < from) return false
          if (to !== '' && String(e['created_at']) > to) return false
          return true
        })
        const locale = String(await deps.resolveConfig('agent.locale') ?? 'en')
        const content = renderHistoryList(locale, filtered)
        return { content, data: { count: filtered.length, entries } }
      },
    },
    'history-range': {
      description: "Read this session's chat history by position (depth) window. depth 0 = the newest message; positive numbers go back in time; negative numbers count from the newest side (-1 = newest). Returns [depth_from, depth_to) oldest-first with role, content, tool name and change id.",
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'integer', description: 'Starting depth offset (0 = newest message).' },
          to: { type: 'integer', description: 'Exclusive depth bound.' },
          limit: { type: 'integer', description: 'Maximum number of messages to return (default 200).' },
        },
      },
      execute: async (args, _callId, sessionName) => {
        if (!sessionName) toolError('missing session context (session_name)')
        const from = numArg(args, 'from', 0)
        const to = numArg(args, 'to', 0)
        const limit = numArg(args, 'limit', 200)
        const chain = await chainRaw(await sessionTip(sessionName), limit)
        const total = chain.length
        const norm = (d: number): number => (d < 0 ? total + d : d)
        let f = norm(from)
        let t = norm(to)
        if (f < 0) f = 0
        if (t > total) t = total
        if (f >= t) return { content: 'history_range: empty.', data: { count: 0 } }
        const ids = chain.map(c => c.id)
        const textByMsg = await textPartsForMessages(ids, '')
        const toolByMsg = await partsForMessages(ids)
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
        const locale = String(await deps.resolveConfig('agent.locale') ?? 'en')
        const content = renderHistoryList(locale, entries)
        return { content, data: { count: entries.length, entries } }
      },
    },
    'file-info': {
      description: 'Return metadata (name, mime type, size, sha256) for a previously uploaded file referenced as file:<code>. Use this first to learn a file type and size before deciding to read or analyze it.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'The file code (the 16-char segment after file:)' } },
        required: ['code'],
      },
      execute: async (args, _callId, sessionName) => {
        const code = strArg(args, 'code')
        if (code === '') toolError('code is required')
        const meta = await fileMetaFromBlob(code)
        const content = `File ${code}: ${String(meta['name'] ?? '')} (${String(meta['mime'] ?? '')}, ${Number(meta['size'] ?? 0)} bytes, sha256=${String(meta['sha256'] ?? '')})`
        return { content, data: { meta } }
      },
    },
    'image-read': {
      description: 'Understand a previously uploaded image referenced as file:<code> using a vision model. Pass a question (prompt); the model returns a natural-language description/answer about the image.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The file code (the 16-char segment after file:)' },
          prompt: { type: 'string', description: 'Question about the image (default: describe it in detail).' },
        },
        required: ['code'],
      },
      requiredConfig: ['vlm_model'],
      execute: async (args, _callId, sessionName) => {
        const code = strArg(args, 'code')
        if (code === '') toolError('code is required')
        let prompt = strArg(args, 'prompt')
        if (prompt === '') prompt = 'Describe this image in detail.'
        const res = await imageRead(code, prompt, sessionName)
        return { content: res.content, data: res.data }
      },
    },
  }
}
