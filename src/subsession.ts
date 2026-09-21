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
 *   - child → parent: `mail-send` to the parent's name with the result
 *     (wakes the parent to continue its turn).
 *
 * There is no synchronous wait: the parent's tool call returns immediately and
 * the model is instructed (by the tool description) to end its turn; the
 * parent is resumed when the child's result lands in its mailbox.
 */

import { strArg, type ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

/** Locale-aware fixed strings for the subsession tools. */
function strings(locale: string): {
  handoff: (parent: string) => string
  forkPreamble: (parent: string) => string
  started: (child: string, desc: string) => string
  delivered: (to: string) => string
  errMissingPrompt: string
  errNested: string
  errParentMissing: (sid: string) => string
  errExists: (sid: string) => string
  errMissingTo: string
  errMissingText: string
  errTargetMissing: (sid: string) => string
} {
  const zh = locale.toLowerCase().startsWith('zh')
  if (zh)
    return {
      handoff: parent =>
        `\n\n[subsession] 完成后，请调用 "mail-send" 工具（to="${parent}"）把结果发回父会话，然后停止。`,
      forkPreamble: parent =>
        `[subsession 上下文] 你是父会话 '${parent}' 的 subsession（fork）。` +
        `在你上方出现的更早对话（含用户消息）都来自父会话，仅供背景参考——` +
        `不是发给你的请求。你的任务只由本条消息（在本标记之后）定义；` +
        `如背景不足以完成它，请按合理假设继续，而不是向用户提问。`,
      started: (child, desc) =>
        `subsession '${child}' 已启动${desc !== '' ? `（${desc}）` : ''}。` +
        `它正在后台工作；结果会以新消息的形式出现在本会话的 mailbox 中。` +
        `现在请立即结束本轮，不要轮询——结果到达时会自动恢复你。`,
      delivered: to => `消息已投递到会话 '${to}'。`,
      errMissingPrompt: 'subsession-create: 缺少 "prompt"。',
      errNested:
        'subsession-create: 本会话本身就是一个 subsession，不允许嵌套创建。',
      errParentMissing: sid => `subsession-create: 找不到父会话 '${sid}'。`,
      errExists: sid => `subsession-create: 会话 '${sid}' 已存在。`,
      errMissingTo: 'mail-send: 缺少 "to"。',
      errMissingText: 'mail-send: 缺少 "text"。',
      errTargetMissing: sid => `mail-send: 找不到目标会话 '${sid}'。`,
    }
  return {
    handoff: parent =>
      `\n\n[subsession] When you have finished, send your result back to the ` +
      `parent session by calling the "mail-send" tool with to="${parent}". ` +
      `Then stop.`,
    forkPreamble: parent =>
      `[subsession context] You are a subsession (fork) of the parent session ` +
      `'${parent}'. The earlier conversation above (including its user ` +
      `messages) belongs to the parent session and is background context ` +
      `only — none of it is addressed to you. Your task is defined solely by ` +
      `the message that follows this marker; if the context is insufficient ` +
      `to complete it, proceed on reasonable assumptions instead of asking ` +
      `the user questions.`,
    started: (child, desc) =>
      `Subsession '${child}' started${desc !== '' ? ` (${desc})` : ''}. ` +
      `It is working in the background; its result will arrive in this ` +
      `session's mailbox as a new message. END YOUR TURN NOW and do not ` +
      `poll — you will be resumed when the result arrives.`,
    delivered: to => `Message delivered to session '${to}'.`,
    errMissingPrompt: 'subsession-create: missing "prompt".',
    errNested:
      'subsession-create: this session is itself a subsession; nested subsessions are not allowed.',
    errParentMissing: sid =>
      `subsession-create: parent session '${sid}' not found.`,
    errExists: sid => `subsession-create: session '${sid}' already exists.`,
    errMissingTo: 'mail-send: missing "to".',
    errMissingText: 'mail-send: missing "text".',
    errTargetMissing: sid => `mail-send: target session '${sid}' not found.`,
  }
}

/** Session locale as the agent projects it (vars bucket, provider "agent"),
 *  falling back to the tenant-global `locale` config, then English. */
async function localeOf(
  deps: BundledDeps,
  tenant: string,
  sessionName: string,
): Promise<string> {
  const session = await deps
    .getSessionVariable(tenant, 'agent', sessionName, 'locale')
    .catch(() => undefined)
  if (typeof session === 'string' && session !== '') return session
  const cfg = await deps
    .resolveConfig('locale', undefined, tenant)
    .catch(() => undefined)
  return typeof cfg === 'string' && cfg !== '' ? cfg : 'en'
}

/** Short random suffix for auto-generated child names. */
function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** Build the subsession-create + mail-send execute handlers bound to [deps]. */
export function subsessionExecutes(
  deps: BundledDeps,
): Record<string, ToolSpec['execute']> {
  /** The `group` of a session ('' = top-level). */
  const groupOf = (tenant: string, sid: string): Promise<string> =>
    deps.sessionGroup(tenant, sid)

  /** Does a session exist in this tenant? */
  const sessionExists = (tenant: string, sid: string): Promise<boolean> =>
    deps.sessionExists(tenant, sid)

  const subsession: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenantArg,
  ) => {
    const tenant = tenantArg ?? 'default'
    const s = strings(await localeOf(deps, tenant, sessionName))
    const prompt = strArg(args, 'prompt').trim()
    if (prompt === '') {
      return { content: s.errMissingPrompt }
    }
    // Depth limit 1: a child (group != '') may not spawn further children.
    const parentGroup = await groupOf(tenant, sessionName)
    if (parentGroup !== '') {
      return { content: s.errNested }
    }
    if (!(await sessionExists(tenant, sessionName))) {
      return { content: s.errParentMissing(sessionName) }
    }

    const explicit = strArg(args, 'name').trim()
    const childName =
      explicit !== '' ? explicit : `${sessionName}#sub-${shortId()}`
    if (await sessionExists(tenant, childName)) {
      return { content: s.errExists(childName) }
    }

    // O(1) fork: copy every inheritable column from the parent, repoint tip_id
    // at the SAME tip (shared chain), and set group = parent name.
    await deps.forkSession(tenant, sessionName, childName)

    // Hand the task to the child (wakes it) with a fork-context preamble so
    // the child understands the shared history belongs to the parent, then
    // the task itself and a completion instruction — all in the session's
    // own locale.
    const handoff = `${s.forkPreamble(sessionName)}\n\n${prompt}${s.handoff(sessionName)}`
    await deps.publishMailbox(tenant, childName, 'user_prompt', {
      text: handoff,
    })

    const desc = strArg(args, 'description').trim()
    return { content: s.started(childName, desc) }
  }

  const sessionSend: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenantArg,
  ) => {
    const tenant = tenantArg ?? 'default'
    const s = strings(await localeOf(deps, tenant, sessionName))
    const to = strArg(args, 'to').trim()
    const text = strArg(args, 'text')
    if (to === '') return { content: s.errMissingTo }
    if (text === '') return { content: s.errMissingText }
    if (!(await sessionExists(tenant, to))) {
      return { content: s.errTargetMissing(to) }
    }
    // A `user_prompt` message wakes the target and continues its turn (an
    // `event` would only fold into its context without triggering a turn).
    await deps.publishMailbox(tenant, to, 'user_prompt', { text })
    return { content: s.delivered(to) }
  }

  return {
    'subsession-create': subsession,
    'mail-send': sessionSend,
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
  const children = await deps.sessionsInGroup(tenant, parentName)
  for (const child of children) {
    if (child === '') continue
    await deps.deleteSessionMailbox(tenant, child)
    await deps.deleteSessionRow(tenant, child)
  }
}
