import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BundledDeps } from '../src/deps.js'
import { deleteSubsessions, subsessionExecutes } from '../src/subsession.js'

/**
 * The subsession tools are pure SQL + mailbox side effects, so they are tested
 * against a real in-memory SQLite (the same driver the agent uses) with a
 * capturing `publishMailbox` stub. No NATS, no network.
 */

interface Sent {
  tenant: string
  sessionName: string
  type: string
  payload: unknown
  source: string
}

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE sessions (
      tenant TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      variant TEXT NOT NULL DEFAULT '',
      preset TEXT NOT NULL DEFAULT '',
      tip_id TEXT,
      max_turns INTEGER NOT NULL DEFAULT 0,
      system_prompt TEXT NOT NULL DEFAULT '',
      locale TEXT NOT NULL DEFAULT '',
      "group" TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant, name)
    );
    CREATE TABLE mailbox (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL DEFAULT 'default',
      session_name TEXT NOT NULL,
      msg_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
  `)
  const sent: Sent[] = []
  const deps = {
    sessionGroup: async (tenant, sid) =>
      String(
        (
          db
            .prepare(
              'SELECT "group" AS g FROM sessions WHERE tenant = ? AND name = ?',
            )
            .all(tenant, sid) as Record<string, unknown>[]
        )[0]?.['g'] ?? '',
      ),
    sessionExists: async (tenant, sid) =>
      (
        db
          .prepare('SELECT 1 FROM sessions WHERE tenant = ? AND name = ?')
          .all(tenant, sid) as Record<string, unknown>[]
      ).length > 0,
    forkSession: async (tenant, parent, child) => {
      db.prepare(
        `INSERT INTO sessions
           (tenant, name, model, variant, preset, tip_id, max_turns,
            system_prompt, locale, "group", created_at, updated_at)
         SELECT tenant, ?, model, variant, preset, tip_id, max_turns,
                system_prompt, locale, ?, datetime('now'), datetime('now')
         FROM sessions WHERE tenant = ? AND name = ?`,
      ).run(child, parent, tenant, parent)
    },
    deleteSessionRow: async (tenant, sid) =>
      void db
        .prepare('DELETE FROM sessions WHERE tenant = ? AND name = ?')
        .run(tenant, sid),
    deleteSessionMailbox: async (tenant, sid) =>
      void db
        .prepare('DELETE FROM mailbox WHERE tenant = ? AND session_name = ?')
        .run(tenant, sid),
    sessionsInGroup: async (tenant, group) =>
      (
        db
          .prepare(
            'SELECT name AS n FROM sessions WHERE tenant = ? AND "group" = ?',
          )
          .all(tenant, group) as Record<string, unknown>[]
      ).map(r => String(r['n'] ?? '')),
    publishMailbox: async (
      tenant: string,
      sessionName: string,
      type: string,
      payload: unknown,
      source = '',
    ) => {
      sent.push({ tenant, sessionName, type, payload, source })
    },
    // No agent-projected session locale by default => tools fall back to 'en'.
    getSessionVariable: async () => undefined,
    resolveConfig: async () => undefined,
  } as unknown as BundledDeps
  const tools = subsessionExecutes(deps)
  return { db, deps, sent, tools }
}

function seedParent(
  db: DatabaseSync,
  name = 'parent',
  group = '',
  tip: string | null = 'TIP-1',
): void {
  db.prepare(
    `INSERT INTO sessions
       (tenant, name, model, variant, preset, tip_id, max_turns,
        system_prompt, locale, "group")
     VALUES ('t', ?, 'mock/m', 'high', 'default', ?, 7, 'sys', 'zh', ?)`,
  ).run(name, tip, group)
}

function rowOf(db: DatabaseSync, name: string): Record<string, unknown> {
  return db
    .prepare('SELECT * FROM sessions WHERE tenant = ? AND name = ?')
    .get('t', name) as Record<string, unknown>
}

const T = 't'

describe('subsession-create', () => {
  let fx: ReturnType<typeof fixture>
  beforeEach(() => (fx = fixture()))
  afterEach(() => fx.db.close())

  it('forks the parent (O(1)): copies columns, shares tip, sets group', async () => {
    seedParent(fx.db)
    const r = await fx.tools['subsession-create']!(
      { prompt: 'do the thing', name: 'child-1' },
      'call-1',
      'parent',
      undefined,
      T,
    )
    expect(r?.content).toContain('child-1')
    const child = rowOf(fx.db, 'child-1')
    // Inherited verbatim.
    expect(child['model']).toBe('mock/m')
    expect(child['variant']).toBe('high')
    expect(child['preset']).toBe('default')
    expect(child['max_turns']).toBe(7)
    expect(child['system_prompt']).toBe('sys')
    expect(child['locale']).toBe('zh')
    // Zero-copy: same tip as the parent (shared chain).
    expect(child['tip_id']).toBe('TIP-1')
    // Group = parent session name.
    expect(child['group']).toBe('parent')
  })

  it('wakes the child with a trigger carrying the task + reply instruction', async () => {
    seedParent(fx.db)
    await fx.tools['subsession-create']!(
      { prompt: 'analyze X', name: 'child-1' },
      'call-1',
      'parent',
      undefined,
      T,
    )
    expect(fx.sent).toHaveLength(1)
    expect(fx.sent[0]!.sessionName).toBe('child-1')
    expect(fx.sent[0]!.type).toBe('trigger')
    expect(fx.sent[0]!.source).toBe('session:parent')
    const text = String((fx.sent[0]!.payload as { text: string }).text)
    expect(text).toContain('analyze X')
    // The child is told how to return: mail-send to the parent.
    expect(text).toContain('mail-send')
    expect(text).toContain('parent')
  })

  it('auto-generates a child name when none is given', async () => {
    seedParent(fx.db)
    const r = await fx.tools['subsession-create']!(
      { prompt: 'x' },
      'c',
      'parent',
      undefined,
      T,
    )
    expect(String(r?.content)).toMatch(/parent#sub-/)
    const names = fx.db
      .prepare('SELECT name FROM sessions')
      .all()
      .map(r2 => String(r2['name']))
    expect(names.some(n => n.startsWith('parent#sub-'))).toBe(true)
  })

  it('refuses nesting (a subsession may not create a subsession)', async () => {
    seedParent(fx.db, 'child', 'a-parent')
    const r = await fx.tools['subsession-create']!(
      { prompt: 'x', name: 'grandchild' },
      'c',
      'child',
      undefined,
      T,
    )
    expect(String(r?.content)).toContain('nested subsessions are not allowed')
    expect(rowOf(fx.db, 'grandchild')).toBeUndefined()
    expect(fx.sent).toHaveLength(0)
  })

  it('rejects a missing prompt and an unknown parent', async () => {
    const noPrompt = await fx.tools['subsession-create']!(
      { prompt: '   ' },
      'c',
      'parent',
      undefined,
      T,
    )
    expect(String(noPrompt?.content)).toContain('missing "prompt"')

    const noParent = await fx.tools['subsession-create']!(
      { prompt: 'x' },
      'c',
      'ghost',
      undefined,
      T,
    )
    expect(String(noParent?.content)).toContain('not found')
  })

  it('rejects a name that already exists', async () => {
    seedParent(fx.db)
    seedParent(fx.db, 'taken')
    const r = await fx.tools['subsession-create']!(
      { prompt: 'x', name: 'taken' },
      'c',
      'parent',
      undefined,
      T,
    )
    expect(String(r?.content)).toContain('already exists')
  })
})

describe('mail-send', () => {
  let fx: ReturnType<typeof fixture>
  beforeEach(() => (fx = fixture()))
  afterEach(() => fx.db.close())

  it('delivers a trigger to an existing session (any same-tenant session)', async () => {
    seedParent(fx.db, 'child', 'parent')
    seedParent(fx.db, 'parent')
    const r = await fx.tools['mail-send']!(
      { to: 'parent', text: 'result: 42' },
      'c',
      'child',
      undefined,
      T,
    )
    expect(String(r?.content)).toContain('delivered')
    expect(fx.sent).toHaveLength(1)
    expect(fx.sent[0]).toMatchObject({
      tenant: 't',
      sessionName: 'parent',
      type: 'trigger',
      source: 'session:child',
    })
    expect((fx.sent[0]!.payload as { text: string }).text).toBe('result: 42')
  })

  it('rejects a missing recipient / empty body / unknown target', async () => {
    seedParent(fx.db, 'a')
    const noTo = await fx.tools['mail-send']!(
      { to: '', text: 'x' },
      'c',
      'a',
      undefined,
      T,
    )
    expect(String(noTo?.content)).toContain('missing "to"')
    const noText = await fx.tools['mail-send']!(
      { to: 'a', text: '' },
      'c',
      'a',
      undefined,
      T,
    )
    expect(String(noText?.content)).toContain('missing "text"')
    const noTarget = await fx.tools['mail-send']!(
      { to: 'ghost', text: 'x' },
      'c',
      'a',
      undefined,
      T,
    )
    expect(String(noTarget?.content)).toContain('not found')
    expect(fx.sent).toHaveLength(0)
  })
})

describe('deleteSubsessions (cascade on parent delete)', () => {
  let fx: ReturnType<typeof fixture>
  beforeEach(() => (fx = fixture()))
  afterEach(() => fx.db.close())

  it('deletes children + their mailbox rows, keeps the parent and siblings', async () => {
    seedParent(fx.db, 'parent')
    seedParent(fx.db, 'c1', 'parent')
    seedParent(fx.db, 'c2', 'parent')
    seedParent(fx.db, 'other')
    fx.db
      .prepare(
        `INSERT INTO mailbox (id, tenant, session_name, msg_type) VALUES ('m1','t','c1','trigger')`,
      )
      .run()

    await deleteSubsessions(fx.deps, T, 'parent')

    expect(rowOf(fx.db, 'c1')).toBeUndefined()
    expect(rowOf(fx.db, 'c2')).toBeUndefined()
    expect(rowOf(fx.db, 'parent')).toBeDefined()
    expect(rowOf(fx.db, 'other')).toBeDefined()
    const mb = fx.db.prepare('SELECT id FROM mailbox').all()
    expect(mb).toHaveLength(0)
  })
})

describe('subsession-create i18n', () => {
  it('writes the handoff instruction in the session locale (zh)', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE sessions (tenant TEXT, name TEXT, model TEXT, variant TEXT,
        preset TEXT, tip_id TEXT, max_turns INTEGER, system_prompt TEXT,
        locale TEXT, "group" TEXT, created_at TEXT, updated_at TEXT);
    `)
    db.prepare(
      `INSERT INTO sessions VALUES ('t','p','m','','default','TIP',1,'sys','','',datetime('now'),datetime('now'))`,
    ).run()
    const sent: Array<{ payload: unknown }> = []
    const deps = {
      sessionGroup: async (_t: string, sid: string) =>
        String(
          (
            db
              .prepare(
                'SELECT "group" AS g FROM sessions WHERE tenant = ? AND name = ?',
              )
              .all('t', sid) as Record<string, unknown>[]
          )[0]?.['g'] ?? '',
        ),
      sessionExists: async (_t: string, sid: string) =>
        (
          db
            .prepare('SELECT 1 FROM sessions WHERE tenant = ? AND name = ?')
            .all('t', sid) as Record<string, unknown>[]
        ).length > 0,
      forkSession: async (_t: string, parent: string, child: string) => {
        db.prepare(
          `INSERT INTO sessions (tenant, name, model, variant, preset, tip_id,
             max_turns, system_prompt, locale, "group", created_at, updated_at)
           SELECT tenant, ?, model, variant, preset, tip_id, max_turns,
                  system_prompt, locale, ?, datetime('now'), datetime('now')
           FROM sessions WHERE tenant = ? AND name = ?`,
        ).run(child, parent, 't', parent)
      },
      deleteSessionRow: async () => {},
      deleteSessionMailbox: async () => {},
      sessionsInGroup: async () => [],
      publishMailbox: async (_t: string, _s: string, _ty: string, p: unknown) =>
        sent.push({ payload: p }),
      // The agent projects this session's locale as vars.agent.<sid>.locale.
      getSessionVariable: async (
        _t: string,
        _p: string,
        _s: string,
        name: string,
      ) => (name === 'locale' ? 'zh-CN' : undefined),
      resolveConfig: async () => undefined,
    } as unknown as BundledDeps
    await subsessionExecutes(deps)['subsession-create']!(
      { prompt: 'do it', name: 'c1' },
      'call',
      'p',
      undefined,
      't',
    )
    const text = String((sent[0]!.payload as { text: string }).text)
    expect(text).toContain('mail-send')
    expect(text).toContain('发回父会话')
    db.close()
  })
})

describe('subsession handoff fork-context preamble', () => {
  it('prepends a fork-context preamble naming the parent (en)', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE sessions (tenant TEXT, name TEXT, model TEXT, variant TEXT,
        preset TEXT, tip_id TEXT, max_turns INTEGER, system_prompt TEXT,
        locale TEXT, "group" TEXT, created_at TEXT, updated_at TEXT);
    `)
    db.prepare(
      `INSERT INTO sessions VALUES ('t','p','m','','default','TIP',1,'sys','','',datetime('now'),datetime('now'))`,
    ).run()
    const sent: Array<{ payload: unknown }> = []
    const deps = {
      sessionGroup: async (_t: string, sid: string) =>
        String(
          (
            db
              .prepare(
                'SELECT "group" AS g FROM sessions WHERE tenant = ? AND name = ?',
              )
              .all('t', sid) as Record<string, unknown>[]
          )[0]?.['g'] ?? '',
        ),
      sessionExists: async (_t: string, sid: string) =>
        (
          db
            .prepare('SELECT 1 FROM sessions WHERE tenant = ? AND name = ?')
            .all('t', sid) as Record<string, unknown>[]
        ).length > 0,
      forkSession: async (_t: string, parent: string, child: string) => {
        db.prepare(
          `INSERT INTO sessions (tenant, name, model, variant, preset, tip_id,
             max_turns, system_prompt, locale, "group", created_at, updated_at)
           SELECT tenant, ?, model, variant, preset, tip_id, max_turns,
                  system_prompt, locale, ?, datetime('now'), datetime('now')
           FROM sessions WHERE tenant = ? AND name = ?`,
        ).run(child, parent, 't', parent)
      },
      deleteSessionRow: async () => {},
      deleteSessionMailbox: async () => {},
      sessionsInGroup: async () => [],
      publishMailbox: async (_t: string, _s: string, _ty: string, p: unknown) =>
        sent.push({ payload: p }),
      getSessionVariable: async () => undefined,
      resolveConfig: async () => undefined,
    } as unknown as BundledDeps
    await subsessionExecutes(deps)['subsession-create']!(
      { prompt: 'do it', name: 'c1' },
      'call',
      'p',
      undefined,
      't',
    )
    const text = String((sent[0]!.payload as { text: string }).text)
    expect(text).toContain('subsession context')
    expect(text).toContain("parent session 'p'")
    // Task must come AFTER the preamble.
    expect(text.indexOf('subsession context')).toBeLessThan(
      text.indexOf('do it'),
    )
    db.close()
  })
})
