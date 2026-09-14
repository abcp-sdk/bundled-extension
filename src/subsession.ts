/**
 * Subsession tools: launch a child session and send messages between sessions.
 *
 * A "subsession" is an ordinary session created by O(1) fork: the child's
 * `tip_id` points at the parent's current tip, so it shares the parent's
 * message chain (zero-copy) and inherits its model/preset/variant verbatim —
 * which also means it reuses the parent's prompt/prefix caches. The child is
 * linked to the parent through the generic `sessions.group` column (set to the
 * parent's name), NOT a dedicated parent column.
 *
 * Depth is limited to 1: a subsession may not itself create a subsession. The
 * check is "does my own session have a non-empty group?".
 *
 * Handoff is plain mailbox messaging (the same channel the HTTP prompt route
 * uses):
 *   - parent → child: `user_prompt` carrying the task (wakes the child).
 *   - child → parent: `session-send` to the parent's name with the result
 *     (wakes the parent to continue its turn).
 *
 * There is no synchronous wait: the parent's tool call returns immediately and
 * the model is instructed (by the tool description) to end its turn; the
 * parent is resumed when the child's result lands in its mailbox.
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

/** Short random suffix for auto-generated child names. */
function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** Build the subsession + session-send execute handlers bound to [deps]. */
export function subsessionExecutes(
  deps: BundledDeps,
): Record<string, ToolSpec['execute']> {
  /** The `group` of a session ('' = top-level). */
  const groupOf = async (
    tenant: string,
    sid: string,
  ): Promise<string> => {
    const rows = await deps.rawAll(
      `SELECT "group" FROM sessions WHERE tenant = ? AND name = ?`,
      [tenant, sid],
    )
    return rows.length > 0 ? String(rows[0]!['group'] ?? '') : ''
  }

  /** Does a session exist in this tenant? */
  const sessionExists = async (
    tenant: string,
    sid: string,
  ): Promise<boolean> => {
    const rows = await deps.rawAll(
      `SELECT 1 AS x FROM sessions WHERE tenant = ? AND name = ? LIMIT 1`,
      [tenant, sid],
    )
    return rows.length > 0
  }

  const subsession: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenantArg,
  ) => {
    const tenant = tenantArg ?? 'default'
    const prompt = strArg(args, 'prompt').trim()
    if (prompt === '') {
      return { content: 'subsession: missing "prompt".' }
    }
    // Depth limit 1: a child (group != '') may not spawn further children.
    const parentGroup = await groupOf(tenant, sessionName)
    if (parentGroup !== '') {
      return {
        content:
          'subsession: this session is itself a subsession; nested subsessions are not allowed.',
      }
    }
    if (!(await sessionExists(tenant, sessionName))) {
      return { content: `subsession: parent session '${sessionName}' not found.` }
    }

    const explicit = strArg(args, 'name').trim()
    const childName = explicit !== '' ? explicit : `${sessionName}#sub-${shortId()}`
    if (await sessionExists(tenant, childName)) {
      return { content: `subsession: session '${childName}' already exists.` }
    }

    // O(1) fork: copy every inheritable column from the parent, repoint tip_id
    // at the SAME tip (shared chain), and set group = parent name.
    await deps.rawRun(
      `INSERT INTO sessions
         (tenant, name, model, variant, preset, tip_id, max_turns,
          system_prompt, locale, "group", created_at, updated_at)
       SELECT tenant, ?, model, variant, preset, tip_id, max_turns,
              system_prompt, locale, ?, datetime('now'), datetime('now')
       FROM sessions WHERE tenant = ? AND name = ?`,
      [childName, sessionName, tenant, sessionName],
    )

    // Hand the task to the child (wakes it) with a completion instruction.
    const handoff =
      `${prompt}\n\n` +
      `[subsession] When you have finished, send your result back to the ` +
      `parent session by calling the "session-send" tool with ` +
      `to="${sessionName}". Then stop.`
    await deps.publishMailbox(tenant, childName, 'user_prompt', { text: handoff })

    const desc = strArg(args, 'description').trim()
    return {
      content:
        `Subsession '${childName}' started${desc !== '' ? ` (${desc})` : ''}. ` +
        `It is working in the background; its result will arrive in this ` +
        `session's mailbox as a new message. END YOUR TURN NOW and do not ` +
        `poll — you will be resumed when the result arrives.`,
    }
  }

  const sessionSend: ToolSpec['execute'] = async (
    args,
    _callId,
    _sessionName,
    _signal,
    tenantArg,
  ) => {
    const tenant = tenantArg ?? 'default'
    const to = strArg(args, 'to').trim()
    const text = strArg(args, 'text')
    if (to === '') return { content: 'session-send: missing "to".' }
    if (text === '') return { content: 'session-send: missing "text".' }
    if (!(await sessionExists(tenant, to))) {
      return { content: `session-send: target session '${to}' not found.` }
    }
    // A `user_prompt` message wakes the target and continues its turn (an
    // `event` would only fold into its context without triggering a turn).
    await deps.publishMailbox(tenant, to, 'user_prompt', { text })
    return { content: `Message delivered to session '${to}'.` }
  }

  return {
    subsession,
    'session-send': sessionSend,
  }
}

/**
 * Cascade-delete a deleted session's subsessions (depth 1). Removes each
 * child's session row and its mailbox queue; message history is left intact
 * (it is shared with the parent via the O(1) fork's chain).
 */
export async function deleteSubsessions(
  deps: BundledDeps,
  tenant: string,
  parentName: string,
): Promise<void> {
  const children = await deps.rawAll(
    `SELECT name FROM sessions WHERE tenant = ? AND "group" = ?`,
    [tenant, parentName],
  )
  for (const row of children) {
    const child = String(row['name'] ?? '')
    if (child === '') continue
    await deps.rawRun(
      `DELETE FROM mailbox WHERE tenant = ? AND session_name = ?`,
      [tenant, child],
    )
    await deps.rawRun(`DELETE FROM sessions WHERE tenant = ? AND name = ?`, [
      tenant,
      child,
    ])
  }
}
