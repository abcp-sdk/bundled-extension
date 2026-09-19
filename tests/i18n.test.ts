import { describe, expect, it } from 'vitest'
import { CATALOG, tr } from '../src/i18n.js'

describe('bundled i18n', () => {
  it('renders English by default', () => {
    expect(tr('en', 'promptRequired')).toBe('prompt is required')
    expect(tr('', 'codeRequired')).toBe('code is required')
  })

  it('renders Chinese for zh locales', () => {
    expect(tr('zh', 'promptRequired')).toBe('缺少 prompt。')
    expect(tr('zh-CN', 'generatedImages', { n: 2, model: 'm' })).toBe(
      '已用 m 生成 2 张图片。',
    )
  })

  it('falls back to English for an unknown locale', () => {
    expect(tr('de', 'promptRequired')).toBe('prompt is required')
  })

  it('every catalog entry carries en + zh', () => {
    for (const [key, entry] of Object.entries(CATALOG)) {
      expect(entry.en, `${key}.en`).toBeTypeOf('string')
      expect(entry.zh, `${key}.zh`).toBeTypeOf('string')
      expect(entry.en.length, `${key}.en non-empty`).toBeGreaterThan(0)
      expect(entry.zh.length, `${key}.zh non-empty`).toBeGreaterThan(0)
    }
  })
})
