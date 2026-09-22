/**
 * 记忆文件的形态层：frontmatter、索引条目、索引渲染与截断。
 *
 * 这一层的每个函数都对齐 ZCode 的实际实现，出处见各函数上方注释。与存储层分离，
 * 是为了让「记忆文件长什么样」能脱离 Cordis 与文件系统单独验证。
 *
 * 形态来自 ZCode 的两处约定：
 *   - `MEMORY.md` 是**索引**：一行一条 `- [Title](file.md) — hook`，没有 frontmatter，
 *     永远不放记忆正文；
 *   - 每条记忆是**自己的文件** `<slug>.md`，带 `name` / `description` / `metadata.type`
 *     frontmatter，正文按类型组织。
 *
 * @module dsh-zcode-project-memory/memory-format
 */

import { createHash } from 'node:crypto'

/**
 * 记忆类型。出处：`apps/zcode-cli/packages/core/src/memory/recall/types.ts`
 * （`MEMORY_RECALL_TYPES`）。
 */
export const MEMORY_RECALL_TYPES = ['user', 'feedback', 'project', 'reference']

/** 索引文件名。出处：`packages/services/src/memory/memoryService.ts`（`PROJECT_MEMORY_INDEX_FILE_NAME`）。 */
export const MEMORY_INDEX_FILE_NAME = 'MEMORY.md'

/** 索引行数上限的默认值。出处：`core/src/memory/index-content.ts`（`MEMORY_INDEX_LINE_LIMIT`）。 */
export const MEMORY_INDEX_LINE_LIMIT = 200

/** 索引字符数上限的默认值。出处：`core/src/memory/index-content.ts`（`MEMORY_INDEX_CHARACTER_LIMIT`）。 */
export const MEMORY_INDEX_CHARACTER_LIMIT = 25_000

/**
 * 索引截断上限。
 *
 * 这两个值直接决定每次请求注入多少记忆文本（即 token 成本），不同部署的模型上下文
 * 预算不同，因此按 `docs/user/develop/basic/config.md` 的
 * 「Do not hardcode tunable values」要求做成插件配置字段，默认值沿用 ZCode 的常量。
 *
 * @typedef {{ lineLimit?: number, characterLimit?: number }} MemoryIndexLimits
 */

/**
 * 归一索引上限，缺省回落到 ZCode 的默认常量。
 *
 * @param {MemoryIndexLimits} [limits] 调用方给的上限。
 * @returns {{ lineLimit: number, characterLimit: number }} 归一后的上限。
 */
function normalizeIndexLimits(limits) {
  const lineLimit = Number.isInteger(limits?.lineLimit)
    ? /** @type {number} */ (limits.lineLimit)
    : MEMORY_INDEX_LINE_LIMIT
  const characterLimit = Number.isInteger(limits?.characterLimit)
    ? /** @type {number} */ (limits.characterLimit)
    : MEMORY_INDEX_CHARACTER_LIMIT
  return { lineLimit, characterLimit }
}

/** 前导 frontmatter。出处：`core/src/memory/index-content.ts`（`LEADING_FRONTMATTER_PATTERN`）。 */
const LEADING_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/u

/** HTML 注释。出处：`core/src/memory/index-content.ts`（`HTML_COMMENT_PATTERN`）。 */
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu

/**
 * 把任意标题折叠成可作文件名的 slug。
 *
 * 与 ZCode 的项目目录 slug 规则一致（`core/src/memory/project-root.ts` 的
 * `sanitizeProjectSlug`）：小写、非 `[a-z0-9._-]` 折叠成 `-`、去首尾 `-`、截断 48。
 * ZCode 让模型自己给出 kebab-case 文件名；本插件由工具从 `key` 派生，因此必须
 * 自带这层净化，避免 `../` 之类的路径穿越。
 *
 * @param {string} value 原始标题。
 * @returns {string} 非空、无路径分隔符的 slug。
 */
export function sanitizeMemorySlug(value) {
  const raw = String(value ?? '')
  const lowered = raw.toLowerCase()
  const slug = lowered
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  // ZCode 的 sanitizeProjectSlug 会原样返回 `..`：它安全是因为结果总被拼成
  // `${slug}-${hash}`（项目目录）或 `${slug}.md`（本插件的记忆文件），两种拼法都
  // 不再是纯点段。这里额外挡一道，让本函数在任何拼接方式下都可安全用作路径段 ——
  // 属于防御性加固，不改变任何正常输入的输出。
  const base = slug.length === 0 || /^\.+$/u.test(slug) ? 'memory' : slug

  // 关键修正：`[a-z0-9._-]` 之外的字符会被**整体丢弃**，因此不同 key 可能塌缩成同一个
  // 文件名（实测 `你的哨兵` / `发布前检查` / `部署规则` 全部 → `memory.md`，后写的会
  // 覆盖先写的，造成记忆丢失）。凡原 key 含这类字符，就追加原 key 的短哈希，保证不同
  // key 映射到不同文件。空格、连字符、下划线只是**被映射**成 `-`（不丢信息量级），
  // 因此纯 ASCII key 的文件名保持不变，已有记忆不会被改名。
  if (/[^a-z0-9._\-\s]/u.test(lowered)) {
    return `${base}-${shortKeyHash(lowered.trim())}`
  }
  return base
}

/**
 * 由记忆 key 派生一个短哈希，用于区分会被 slug 净化抹平的 key。
 *
 * @param {string} value 已小写化的 key。
 * @returns {string} 6 位十六进制摘要。
 */
function shortKeyHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}

/**
 * 校验并归一记忆类型。
 *
 * @param {unknown} value 候选类型。
 * @returns {'user'|'feedback'|'project'|'reference'} 合法类型；非法值回退 `project`。
 */
export function normalizeMemoryType(value) {
  const candidate = String(value ?? '').trim().toLowerCase()
  return MEMORY_RECALL_TYPES.includes(candidate) ? candidate : 'project'
}

/**
 * 把一行文本渲染成 YAML 双引号标量。
 *
 * ZCode 用 `yaml` 包序列化 frontmatter；本插件不引入依赖，因此对可能含特殊字符的
 * 值一律用双引号 + JSON 转义（JSON 字符串是 YAML 双引号标量的子集），保证换行、
 * 引号、`#`、`:` 都不会破坏 frontmatter 结构。
 *
 * @param {string} value 原始值。
 * @returns {string} 可直接写进 frontmatter 的标量。
 */
function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''))
}

/**
 * 渲染一条记忆文件的完整内容。
 *
 * frontmatter 字段对齐 ZCode 的记忆格式（`core/src/subagent/persistent-memory-prompt.ts`
 * 的 `## How to save memories` 一节）：`name`、`description`、`metadata.type`。
 * `metadata.node_type` 与 `metadata.originSessionId` 来自 ZCode 的写入期标注
 * （`core/src/memory/origin-session.ts`）。
 *
 * @param {object} input 渲染参数。
 * @param {string} input.name 记忆 slug（同时是文件名主干）。
 * @param {string} input.description 一行摘要，供将来判断相关性。
 * @param {string} input.type 记忆类型。
 * @param {string} input.body 记忆正文。
 * @param {string} [input.originSessionId] 写入它的会话 id。
 * @returns {string} 以换行结尾的完整文件内容。
 */
export function renderMemoryFile({ name, description, type, body, originSessionId }) {
  const metadata = [`  type: ${normalizeMemoryType(type)}`, '  node_type: memory']
  if (typeof originSessionId === 'string' && originSessionId.length > 0) {
    metadata.push(`  originSessionId: ${yamlScalar(originSessionId)}`)
  }

  return [
    '---',
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    'metadata:',
    ...metadata,
    '---',
    '',
    String(body ?? '').trim(),
    '',
  ].join('\n')
}

/**
 * 从记忆文件内容里解析 frontmatter 的 `description` 与 `metadata.type`。
 *
 * 对齐 ZCode 的 `parseMemoryFrontmatter`（`core/src/memory/recall/manifest.ts`）：
 * 只做单层、无依赖的解析，解析失败一律当作「没有 frontmatter」，绝不抛错 ——
 * 一个手写坏掉的记忆文件不能影响其它记忆。
 *
 * @param {string} content 记忆文件内容。
 * @returns {{ description?: string, type?: string }} 解析出的字段。
 */
export function parseMemoryFrontmatter(content) {
  const normalized = String(content ?? '').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') return {}

  const end = lines.indexOf('---', 1)
  if (end < 0) return {}

  /** @type {string | undefined} */
  let description
  /** @type {string | undefined} */
  let type
  let inMetadata = false

  for (const line of lines.slice(1, end)) {
    const metadataMatch = /^metadata:\s*$/u.exec(line)
    if (metadataMatch) {
      inMetadata = true
      continue
    }
    if (/^\S/u.test(line)) inMetadata = false

    const typeMatch = inMetadata ? /^\s+type:\s*(?<value>.+)$/u.exec(line) : null
    if (typeMatch) {
      type = unquoteYamlScalar(typeMatch.groups.value)
      continue
    }

    const descriptionMatch = /^description:\s*(?<value>.*)$/u.exec(line)
    if (descriptionMatch) description = unquoteYamlScalar(descriptionMatch.groups.value)
  }

  const result = {}
  if (description !== undefined && description.length > 0) result.description = description
  if (type !== undefined && MEMORY_RECALL_TYPES.includes(type)) result.type = type
  return result
}

/**
 * 去掉 YAML 标量外层的引号（若有）。
 *
 * @param {string} raw 原始标量文本。
 * @returns {string} 去引号后的值。
 */
function unquoteYamlScalar(raw) {
  const value = String(raw ?? '').trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * 渲染一条索引条目。
 *
 * 格式出处：`core/src/subagent/persistent-memory-prompt.ts` —
 * `- [Title](file.md) — one-line hook`（破折号为 em dash）。
 *
 * @param {object} input 条目参数。
 * @param {string} input.title 展示标题。
 * @param {string} input.fileName 记忆文件名（相对记忆根目录）。
 * @param {string} input.hook 一行钩子。
 * @returns {string} 单行索引条目。
 */
export function renderIndexEntry({ title, fileName, hook }) {
  const safeTitle = String(title ?? '').replace(/[[\]]/gu, '').trim() || fileName
  const safeHook = String(hook ?? '').replace(/\s+/gu, ' ').trim()
  return safeHook.length > 0
    ? `- [${safeTitle}](${fileName}) — ${safeHook}`
    : `- [${safeTitle}](${fileName})`
}

/**
 * 在索引内容里插入或替换某条记忆的条目。
 *
 * 「同一条记忆重复保存 = 替换自己的条目」是刻意的：ZCode 要求索引一行一条、不得重复
 * （`core/src/subagent/persistent-memory-prompt.ts` 的
 * "Do not write duplicate memories"）。替换键是文件名，因为文件名由 slug 唯一决定。
 *
 * @param {string} indexContent 既有索引内容（可为空串）。
 * @param {object} entry 条目参数，同 {@link renderIndexEntry}。
 * @returns {string} 更新后的索引内容（以换行结尾）。
 */
export function upsertIndexEntry(indexContent, entry) {
  const line = renderIndexEntry(entry)
  const existing = String(indexContent ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .filter((candidate) => candidate.trim().length > 0)

  const target = `(${entry.fileName})`
  const index = existing.findIndex((candidate) => candidate.includes(target))
  if (index >= 0) existing[index] = line
  else existing.push(line)

  return `${existing.join('\n')}\n`
}

/**
 * 去掉前导 frontmatter。
 *
 * 出处：`core/src/memory/index-content.ts`（`formatProjectMemoryIndexContent`）。
 *
 * @param {string} content 原始内容。
 * @returns {string} 去掉 frontmatter 后的内容。
 */
export function stripLeadingFrontmatter(content) {
  return String(content ?? '').replace(LEADING_FRONTMATTER_PATTERN, '')
}

/**
 * 去掉顶层 HTML 注释。
 *
 * ZCode 用 `marked` 的 Lexer 区分「顶层 HTML 注释」与「list / blockquote / 代码块
 * 内的注释」，只删前者（`core/src/memory/index-content.ts` 的
 * `stripTopLevelMarkdownHtmlComments`）。本插件不引入 `marked`，改用围栏感知的
 * 保守近似：只在**不在 ``` 围栏内**且**从行首开始**的位置删除注释块。代价是
 * 缩进在 list/blockquote 内的顶层注释不会被删（宁可多留，不可误删正文）。
 *
 * @param {string} content 已去 frontmatter 的内容。
 * @returns {string} 去注释后的内容。
 */
export function stripTopLevelHtmlComments(content) {
  const text = String(content ?? '')
  if (!text.includes('<!--')) return text

  const lines = text.split('\n')
  const kept = []
  let inFence = false
  let inComment = false

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence
      if (!inComment) kept.push(line)
      continue
    }
    if (inFence) {
      if (!inComment) kept.push(line)
      continue
    }

    if (!inComment && /^<!--/u.test(line)) {
      const withoutComment = line.replace(HTML_COMMENT_PATTERN, '')
      if (withoutComment.includes('-->')) {
        // 同一行内闭合的注释：直接删除该注释片段。
        if (withoutComment.trim().length > 0) kept.push(withoutComment)
        continue
      }
      inComment = true
      continue
    }
    if (inComment) {
      if (line.includes('-->')) {
        inComment = false
        const remainder = line.slice(line.indexOf('-->') + 3)
        if (remainder.trim().length > 0) kept.push(remainder)
      }
      continue
    }
    kept.push(line)
  }

  return kept.join('\n')
}

/**
 * 按 ZCode 的规则截断索引并追加警告。
 *
 * 出处：`core/src/memory/index-content.ts`（`formatMemoryIndexContent`），
 * 包括两个上限与警告文案；上限值可由插件配置覆盖。
 *
 * @param {string} content 索引内容。
 * @param {MemoryIndexLimits} [limits] 截断上限。
 * @returns {string} 可直接注入的索引文本；空索引返回空串。
 */
export function formatMemoryIndexContent(content, limits) {
  const { lineLimit, characterLimit } = normalizeIndexLimits(limits)
  const trimmed = String(content ?? '').trim()
  if (!trimmed) return ''

  const lines = trimmed.split('\n')
  const lineCount = lines.length
  const characterCount = trimmed.length
  const lineTruncated = lineCount > lineLimit
  const characterTruncated = characterCount > characterLimit
  if (!lineTruncated && !characterTruncated) return trimmed

  let truncated = lineTruncated ? lines.slice(0, lineLimit).join('\n') : trimmed
  if (truncated.length > characterLimit) {
    const finalNewline = truncated.lastIndexOf('\n', characterLimit)
    truncated = truncated.slice(0, finalNewline > 0 ? finalNewline : characterLimit)
  }

  const sizeDescription =
    characterTruncated && !lineTruncated
      ? `${formatBytes(characterCount)} (limit: ${formatBytes(characterLimit)}) — index entries are too long`
      : lineTruncated && !characterTruncated
        ? `${lineCount} lines (limit: ${lineLimit})`
        : `${lineCount} lines and ${formatBytes(characterCount)}`

  return `${truncated}\n\n> WARNING: MEMORY.md is ${sizeDescription}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`
}

/**
 * 字节数的可读格式。出处：`core/src/memory/index-content.ts`（`formatBytes`）。
 *
 * @param {number} value 字节数。
 * @returns {string} 可读字符串。
 */
function formatBytes(value) {
  const kilobytes = value / 1024
  if (kilobytes < 1) return `${value} bytes`
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/u, '')}KB`
  const megabytes = kilobytes / 1024
  if (megabytes < 1024) return `${megabytes.toFixed(1).replace(/\.0$/u, '')}MB`
  return `${(megabytes / 1024).toFixed(1).replace(/\.0$/u, '')}GB`
}

/**
 * 把原始索引文件内容渲染成可注入的形态：去 frontmatter → 去顶层注释 → 截断。
 *
 * 出处：`core/src/memory/index-content.ts`（`formatProjectMemoryIndexContent`）。
 *
 * @param {string} content 索引文件原始内容。
 * @param {MemoryIndexLimits} [limits] 截断上限。
 * @returns {string} 可注入的索引文本；空内容返回空串。
 */
export function formatProjectMemoryIndexContent(content, limits) {
  return formatMemoryIndexContent(
    stripTopLevelHtmlComments(stripLeadingFrontmatter(content)),
    limits,
  )
}

/**
 * 从记忆正文派生一行摘要。
 *
 * 仅在调用方没有给出 `description` 时使用：取正文第一段非空、非标题、非 Why/How
 * 的行，压成一行并截断。这样 frontmatter 的 `description` 永远非空 —— 它是将来
 * 判断相关性的唯一依据（ZCode 的 manifest 只用它做召回线索）。
 *
 * @param {string} body 记忆正文。
 * @returns {string} 一行摘要。
 */
export function deriveDescription(body) {
  const firstLine = String(body ?? '')
    .split('\n')
    .map((line) => line.replace(/^#+\s*/u, '').trim())
    .find((line) => line.length > 0 && !/^\*\*(?:Why|How to apply):/iu.test(line))
  if (firstLine === undefined) return ''
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine
}
