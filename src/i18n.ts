import { BASE_LOCALE, type Catalog, defineI18n } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

/**
 * Bundled-extension message catalog for RUNTIME tool text (content + error)
 * that reaches the model. Tool DESCRIPTIONS are localized separately in
 * manifest.yaml (`description` + `descriptions[locale]`).
 *
 * The locale set is an OPEN map — add a language by adding a column to each
 * entry. New keys are type-checked, so a typo in `t(locale, '...')` fails to
 * compile.
 */
export const CATALOG = {
  // ---- image / video ----
  modelNotConfigured: {
    en: '{cfg} not configured — set it to a {capability} model registered on the agent (provider_id/model_id)',
    zh: '{cfg} 未配置 —— 请将其设置为 agent 上注册的 {capability} 模型（provider_id/model_id）',
  },
  modelResolveFailed: {
    en: '{cfg}: {error}',
    zh: '{cfg}：{error}',
  },
  modelNotFound: {
    en: 'model not found',
    zh: '未找到模型',
  },
  promptRequired: {
    en: 'prompt is required',
    zh: '缺少 prompt。',
  },
  codeRequired: {
    en: 'code is required',
    zh: '缺少 code。',
  },
  textRequired: {
    en: 'text is required',
    zh: '缺少 text。',
  },
  urlRequired: {
    en: 'url is required',
    zh: '缺少 url。',
  },
  queryRequired: {
    en: 'query is required',
    zh: '缺少 query。',
  },
  generatedImages: {
    en: 'Generated {n} image(s) with {model}.',
    zh: '已用 {model} 生成 {n} 张图片。',
  },
  generatedVideos: {
    en: 'Generated {n} video(s) with {model}.',
    zh: '已用 {model} 生成 {n} 个视频。',
  },
  fileLine: {
    en: 'file:{code} ({mime}, {bytes} bytes)',
    zh: 'file:{code}（{mime}，{bytes} 字节）',
  },
  imageNotImage: {
    en: 'file {code} is not an image ({mime})',
    zh: '文件 {code} 不是图片（{mime}）',
  },
  imageFrameNotImage: {
    en: '{frameType} file {code} is not an image ({mime}) — the {frameType} must be an image file',
    zh: '{frameType} 文件 {code} 不是图片（{mime}）—— {frameType} 必须是图片文件',
  },
  editedImages: {
    en: 'Edited {n} image(s) from file:{ref} with {model}.',
    zh: '已用 {model} 基于 file:{ref} 编辑出 {n} 张图片。',
  },
  videoFrameNoteFirst: {
    en: 'first frame file:{code}',
    zh: '首帧 file:{code}',
  },
  videoFrameNoteLast: {
    en: 'last frame file:{code}',
    zh: '尾帧 file:{code}',
  },
  generatedVideosFrames: {
    en: 'Generated {n} video(s) with {model} ({frames}).',
    zh: '已用 {model} 生成 {n} 个视频（{frames}）。',
  },
  imagePromptRequired: {
    en: '{tool}: prompt is required',
    zh: '{tool}：缺少 prompt。',
  },

  // ---- speech / transcription ----
  synthesized: {
    en: 'Synthesized {kib} KiB {mime} with {model}: file:{code}',
    zh: '已用 {model} 合成 {kib} KiB 的 {mime}：file:{code}',
  },
  synthesizedClone: {
    en: 'Synthesized {kib} KiB {mime} with {model}, cloning voice from file:{ref}: file:{code}',
    zh: '已用 {model} 合成 {kib} KiB 的 {mime}，克隆自 file:{ref} 的嗓音：file:{code}',
  },
  notAudio: {
    en: 'file {code} is not audio ({mime})',
    zh: '文件 {code} 不是音频（{mime}）',
  },
  referenceNotAudio: {
    en: 'reference file {code} is not audio ({mime}) — voice cloning needs an audio clip',
    zh: '参考文件 {code} 不是音频（{mime}）—— 声音克隆需要一段音频片段',
  },
  transcriptionEmpty: {
    en: 'transcription returned an empty transcript',
    zh: '转写结果为空。',
  },
  transcriptionModelResolve: {
    en: 'model.transcription: {error}',
    zh: 'model.transcription：{error}',
  },
  transcriptionNotConfigured: {
    en: 'model.transcription not configured — set it to a transcription model registered on the agent (provider_id/model_id, capability=transcription)',
    zh: '未配置 model.transcription —— 请将其设置为 agent 上注册的转写模型（provider_id/model_id，capability=transcription）',
  },

  // ---- memory / subsession ----
  visionNotConfigured: {
    en: 'model.text not configured: set a vision model first',
    zh: '未配置 model.text：请先设置一个视觉模型。',
  },
  visionNotFound: {
    en: '{error}',
    zh: '{error}',
  },
  todosUpdated: {
    en: 'Updated {n} todo(s).',
    zh: '已更新 {n} 条待办。',
  },
  historyRangeEmpty: {
    en: 'history_range: empty.',
    zh: 'history_range：为空。',
  },
  fileInfo: {
    en: 'File {code}: {name} ({mime}, {bytes} bytes, sha256={sha256})',
    zh: '文件 {code}：{name}（{mime}，{bytes} 字节，sha256={sha256}）',
  },
  fileNotText: {
    en: 'file {code} is not readable text ({mime}) — only plain-text formats are supported; Office documents (docx/xlsx/pptx) and binary files are not',
    zh: '文件 {code} 不是可读文本（{mime}）—— 仅支持纯文本格式；不支持 Office 文档（docx/xlsx/pptx）与二进制文件',
  },
  fileReadEmpty: {
    en: '(empty file)',
    zh: '（空文件）',
  },
  fileReadShowingLines: {
    en: '\n(showing lines {start}-{end} of {total}{more})',
    zh: '\n（显示第 {start}-{end} 行，共 {total} 行{more}）',
  },
  fileReadMore: {
    en: '; more lines available',
    zh: '；还有更多行',
  },

  // ---- web fetch / search ----
  fetchUrlScheme: {
    en: 'URL must use http:// or https://',
    zh: 'URL 必须使用 http:// 或 https://',
  },
  fetchUnsupportedImage: {
    en: 'Unsupported fetched image content type: {mime}',
    zh: '不支持的抓取图片内容类型：{mime}',
  },
  fetchUnsupportedFile: {
    en: 'Unsupported fetched file content type: {mime}',
    zh: '不支持的抓取文件内容类型：{mime}',
  },
  fetchTooLarge: {
    en: 'Response too large (exceeds {bytes} byte limit)',
    zh: '响应过大（超过 {bytes} 字节上限）',
  },
  braveKeyMissing: {
    en: 'brave_api_key not configured',
    zh: '未配置 brave_api_key。',
  },
  braveTooLarge: {
    en: 'Response too large (exceeds {bytes} bytes)',
    zh: '响应过大（超过 {bytes} 字节）',
  },
  braveHttp: {
    en: 'Brave search failed: HTTP {status}',
    zh: 'Brave 搜索失败：HTTP {status}',
  },
  braveFailed: {
    en: 'Brave search failed: {detail}',
    zh: 'Brave 搜索失败：{detail}',
  },
} satisfies Catalog<string>

export type MessageKey = keyof typeof CATALOG

const { t } = defineI18n(CATALOG)

/** Translate a bundled-extension message into `locale`. */
export function tr(
  locale: string,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  return t(locale, key, params)
}

/** Read the session's effective locale (agent-projected), fallback `en`. */
export async function localeOf(
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
  return typeof cfg === 'string' && cfg !== '' ? cfg : BASE_LOCALE
}
