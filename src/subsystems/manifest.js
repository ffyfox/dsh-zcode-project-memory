/**
 * manifest 扫描子系统 —— ZCode `memory/recall/manifest.ts` 的完整复刻。
 *
 * 这是四个子系统里唯一「读取侧」的子系统：它把记忆目录里的事实文件压成一份轻量
 * 清单（文件名 + 类型 + mtime + description），供注入口或抽取子系统当作「记忆地图」。
 *
 * 与 ZCode 的对应关系（逐项对齐，出处均为
 * `apps/zcode-cli/packages/core/src/memory/recall/`）：
 *
 * | 行为 | ZCode 出处 |
 * |---|---|
 * | `scanMemoryManifest({fileSystem, rootDir, signal})` | `manifest.ts` `scanMemoryManifest` |
 * | `formatMemoryManifest(manifest)` | `manifest.ts` `formatMemoryManifest` |
 * | `MemoryManifestEntry` 字段集 | `types.ts` `MemoryManifestEntry` |
 * | `MEMORY_RECALL_TYPES` | `types.ts` `MEMORY_RECALL_TYPES` |
 * | 递归收集、跳过 `MEMORY.md` | `manifest.ts` `collectMemoryPaths`/`isMemoryCandidate` |
 * | 预览只读前 30 行 | `manifest.ts` `MANIFEST_PREVIEW_LINE_LIMIT` |
 * | mtime 倒序后截前 200 条 | `manifest.ts` `MANIFEST_FILE_LIMIT` + `.sort().slice()` |
 * | 单项失败不影响整体（`allSettled`） | `manifest.ts` `Promise.allSettled` |
 * | 整体异常返回空数组 | `manifest.ts` 外层 `try { … } catch { return [] }` |
 *
 * 刻意的差异：ZCode 通过依赖注入拿到 `FileSystemPort`（一个远程可用的文件系统端口，
 * 因为它的 memory 可能落在 ssh 工作区上）。DSH 侧没有等价的「可注入文件系统端口」
 * 概念 —— 本插件已有的写入路径（`store.js`）直接用 `node:fs/promises`。为了不与既有
 * 子系统产生两套 IO 抽象，这里沿用 `node:fs/promises`，但**保留 `fileSystem` 形参
 * 位**作为可选注入点：传入一个符合 `FileSystemPort` 形状（`listDirectory`/`stat`/
 * `readTextFileRange`）的对象时走注入实现，缺省时走本地 fs 适配器。
 *
 * 该子系统只读、无副作用、可单独调用，不依赖另外两个子系统。
 *
 * @module dsh-zcode-project-memory/subsystems/manifest
 */

import { basename, join, relative, sep } from 'node:path'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'

import { MEMORY_INDEX_FILE_NAME, MEMORY_RECALL_TYPES } from '../memory-format.js'

/**
 * manifest 的条目数量上限。
 *
 * 出处：ZCode `manifest.ts` `const MANIFEST_FILE_LIMIT = 200`。
 */
export const MANIFEST_FILE_LIMIT = 200

/**
 * 读预览时最多读取的行数。
 *
 * 出处：ZCode `manifest.ts` `const MANIFEST_PREVIEW_LINE_LIMIT = 30`。
 * 只需要覆盖 frontmatter，不需要读整个正文。
 */
export const MANIFEST_PREVIEW_LINE_LIMIT = 30

export { MEMORY_RECALL_TYPES }

/**
 * 本地文件系统的 `FileSystemPort` 适配器。
 *
 * 形状对齐 ZCode 的端口（`listDirectory`/`stat`/`readTextFileRange`），让注入点与
 * 本地实现可以互换。`kind` 取值 `file`/`directory`/`symlink` 与 ZCode 一致。
 */
const localFileSystem = {
  async listDirectory({ path: directory }) {
    const dirents = await readdir(directory, { withFileTypes: true })
    return {
      entries: dirents.map((dirent) => ({
        kind: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
        path: join(directory, dirent.name),
      })),
    }
  },
  async stat({ path: targetPath }) {
    const info = await stat(targetPath)
    return {
      kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      mtimeMs: info.mtimeMs,
    }
  },
  async readTextFileRange({ path: targetPath, offsetLine = 0, limitLines }) {
    const content = await readFile(targetPath, 'utf8')
    const lines = content.split('\n')
    return { content: lines.slice(offsetLine, offsetLine + limitLines).join('\n') }
  },
}

/**
 * 扫描记忆目录，产出按 mtime 倒序的 manifest。
 *
 * 与 ZCode 的 `scanMemoryManifest` 行为一致：
 *   - 递归收集 `.md`，跳过 `MEMORY.md` 本身；
 *   - 文件 symlink 先 `stat` 确认指向普通文件才计入（失效链接安静跳过）；
 *   - 单条读失败不拖垮整批（`allSettled` 语义）；
 *   - 按 `mtimeMs` 倒序，再截取前 `MANIFEST_FILE_LIMIT` 条；
 *   - 任何整体性异常都收敛成 `[]`，不向上抛。
 *
 * @param {{ fileSystem?: object, rootDir: string, signal?: AbortSignal }} input
 *   `rootDir` 是记忆根目录；`fileSystem` 可选，缺省用本地 fs 适配器。
 * @returns {Promise<Array<{ description?: string, filePath: string, filename: string, mtimeMs: number, type?: string }>>}
 *   manifest 条目列表；目录不存在或不可读时为 `[]`。
 */
export async function scanMemoryManifest(input) {
  try {
    const fileSystem = input.fileSystem ?? localFileSystem
    const paths = await collectMemoryPaths(fileSystem, input.rootDir, input.signal)
    const settled = await Promise.allSettled(
      paths.map((filePath) =>
        readManifestEntry(fileSystem, input.rootDir, filePath, input.signal),
      ),
    )
    return settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, MANIFEST_FILE_LIMIT)
  } catch {
    return []
  }
}

/**
 * 把 manifest 渲染成逐行清单文本。
 *
 * 输出格式逐字符对齐 ZCode `formatMemoryManifest`：
 *   - 有 type：`- [user] file.md (2026-01-01T00:00:00.000Z): description`
 *   - 无 type：`- file.md (…)`
 *   - 无 description 时省略 `: description` 尾段。
 *
 * 注意 `filename` 是**相对记忆根目录的路径**（ZCode 的 `entry.filename`），不是
 * frontmatter 里的字段 —— manifest 条目没有 `name` 字段。
 *
 * @param {ReadonlyArray<{ description?: string, filename: string, mtimeMs: number, type?: string }>} manifest
 *   条目列表。
 * @returns {string} 每行一条的清单文本；空清单得到空串。
 */
export function formatMemoryManifest(manifest) {
  return manifest
    .map((entry) => {
      const type = entry.type ? `[${entry.type}] ` : ''
      const timestamp = new Date(entry.mtimeMs).toISOString()
      const base = `- ${type}${entry.filename} (${timestamp})`
      return entry.description ? `${base}: ${entry.description}` : base
    })
    .join('\n')
}

/**
 * 递归收集候选记忆文件。
 *
 * 出处：ZCode `manifest.ts` `collectMemoryPaths`。目录递归下钻；symlink 只有确认
 * 指向普通文件时才计入，失效链接安静跳过。
 *
 * @param {object} fileSystem 文件系统端口。
 * @param {string} directory 当前目录。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<string[]>} 文件绝对路径列表。
 */
async function collectMemoryPaths(fileSystem, directory, signal) {
  const listed = await fileSystem.listDirectory({ path: directory }, { signal })
  const paths = []

  for (const entry of listed.entries) {
    if (entry.kind === 'directory') {
      paths.push(...(await collectMemoryPaths(fileSystem, entry.path, signal)))
      continue
    }
    if (entry.kind === 'file') {
      if (isMemoryCandidate(entry.path)) paths.push(entry.path)
      continue
    }
    if (entry.kind !== 'symlink' || !isMemoryCandidate(entry.path)) continue

    try {
      const target = await fileSystem.stat({ path: entry.path }, { signal })
      if (target.kind === 'file') paths.push(entry.path)
    } catch {
      // 单个失效的文件 symlink 与单个无法读取的事实文件一样，不影响其他 manifest 项。
    }
  }

  return paths
}

/**
 * 判断一个路径是不是记忆候选。
 *
 * 出处：ZCode `manifest.ts` `isMemoryCandidate` —— `.md` 结尾且不是索引本身。
 *
 * @param {string} filePath 文件路径。
 * @returns {boolean} 是否计入 manifest。
 */
function isMemoryCandidate(filePath) {
  return filePath.endsWith('.md') && basename(filePath) !== MEMORY_INDEX_FILE_NAME
}

/**
 * 读取单个 manifest 条目：并发取 stat 与前 30 行预览，再解析 frontmatter。
 *
 * 出处：ZCode `manifest.ts` `readManifestEntry`。
 *
 * @param {object} fileSystem 文件系统端口。
 * @param {string} rootDir 记忆根目录。
 * @param {string} filePath 文件绝对路径。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<object>} manifest 条目。
 */
async function readManifestEntry(fileSystem, rootDir, filePath, signal) {
  const [info, preview] = await Promise.all([
    fileSystem.stat({ path: filePath }, { signal }),
    fileSystem.readTextFileRange(
      { path: filePath, offsetLine: 0, limitLines: MANIFEST_PREVIEW_LINE_LIMIT },
      { signal },
    ),
  ])
  const frontmatter = parseManifestFrontmatter(preview.content)
  return {
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    filePath,
    filename: relative(rootDir, filePath).split(sep).join('/'),
    mtimeMs: info.mtimeMs ?? 0,
    ...(frontmatter.type ? { type: frontmatter.type } : {}),
  }
}

/**
 * 解析 manifest 需要的 frontmatter 子集（`description` 与 `metadata.type`）。
 *
 * 出处：ZCode `manifest.ts` `parseMemoryFrontmatter`。刻意**不**复用
 * `memory-format.js` 的 `parseMemoryFrontmatter`：后者面向写入侧的完整解析，而这里
 * 要的是 ZCode 那座「只认 description 与 type、且两者都可缺失」的窄解析器，两者的
 * 容错边界不同（这里没有 YAML 依赖，故用逐行的朴素解析）。
 *
 * 只认 ZCode 实际读取的两个字段 —— 条目没有 `name` 字段，`filename` 来自文件路径。
 *
 * @param {string} content 文件前若干行。
 * @returns {{ description?: string, type?: string }} 解析出的字段。
 */
function parseManifestFrontmatter(content) {
  const normalized = String(content).replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') return {}

  const end = lines.indexOf('---', 1)
  if (end < 0) return {}

  let description
  let type
  let inMetadata = false
  for (const line of lines.slice(1, end)) {
    if (/^metadata:\s*$/u.test(line)) {
      inMetadata = true
      continue
    }
    if (/^\S/u.test(line)) inMetadata = false

    const match = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line)
    if (!match) continue
    const [, indent, field, rawValue] = match
    const value = unquoteScalar(rawValue)

    if (field === 'type' && (inMetadata || indent.length > 0)) {
      if (isMemoryRecallType(value)) type = value
      continue
    }
    if (indent.length === 0 && field === 'description' && !inMetadata) {
      if (value.length > 0) description = value
    }
  }

  return {
    ...(description ? { description } : {}),
    ...(type ? { type } : {}),
  }
}

/**
 * 去掉 YAML 标量两侧的引号。
 *
 * 只处理写入侧实际会产生的形态（`JSON.stringify` 得到的双引号字符串）。
 *
 * @param {string} rawValue 原始标量文本。
 * @returns {string} 去引号后的值。
 */
function unquoteScalar(rawValue) {
  const trimmed = rawValue.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed))
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * 判断一个值是否是合法的召回类型。
 *
 * 出处：ZCode `manifest.ts` `isMemoryRecallType`。
 *
 * @param {unknown} value 待判定的值。
 * @returns {boolean} 是否属于 `MEMORY_RECALL_TYPES`。
 */
function isMemoryRecallType(value) {
  return typeof value === 'string' && MEMORY_RECALL_TYPES.includes(value)
}

/** 便于测试与外部复用的 lstat 包装（symlink 判定用）。 */
export async function isPlainFile(filePath) {
  try {
    const info = await lstat(filePath)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}