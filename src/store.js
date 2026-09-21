/**
 * 项目记忆的存储层：项目维度根目录解析、原子写入与稳定读取。
 *
 * ## 项目隔离
 *
 * 每个项目一个目录，目录名由项目根目录的**规范绝对路径**的 sha256 摘要决定，
 * 因此同一项目在任何会话/进程里命中同一目录，不同项目（哪怕基名相同）互不可见。
 *
 * ## 存放位置
 *
 * 对齐 ZCode 的布局 `core/src/memory/project-root.ts`（`resolveProjectMemoryRoot`）：
 *
 * ```text
 * <cliStorageRoot>/memories/projects/<slug>-<hash>/memory/
 * ```
 *
 * DSH 没有 `cliStorageRoot` 这个概念；本插件用 `$DSH_HOME`（默认 `~/.dsh`）作为
 * 它的对应物，于是得到 `$DSH_HOME/memories/projects/<slug>-<hash>/memory/`。
 * 记忆因此落在用户的数据目录里，**不写进项目仓库**。
 *
 * ## 健壮性
 *
 * 写入与读取都复刻 ZCode 的实现，而不是自创一套：
 *   - 写入：`apps/zcode-cli/packages/adapters/src/fs/index.ts`（`atomicWrite`）——
 *     拒绝写穿符号链接、保留原文件权限、`O_EXCL | O_NOFOLLOW` 独占创建临时文件、
 *     `fsync` 后 `rename`，失败时清理临时文件并降级为带 `O_NOFOLLOW` 的原地覆盖。
 *   - 读取：`packages/services/src/memory/projectMemoryStableRead.ts` ——
 *     `lstat` 拒绝非普通文件与符号链接、`O_RDONLY | O_NOFOLLOW` 打开、校验打开前后
 *     的文件身份一致、限制读取体积。
 *   - 路径安全：`core/src/memory/memory-file-path.ts` —— 包含性检查 + 敏感目录段拒绝。
 *
 * @module dsh-project-memory/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  MEMORY_INDEX_FILE_NAME,
  deriveDescription,
  parseMemoryFrontmatter,
  renderMemoryFile,
  sanitizeMemorySlug,
  upsertIndexEntry,
} from './memory-format.js'

/** 单条记忆正文的长度上限（字符）。 */
export const MEMORY_BODY_MAX_CHARS = 8000

/**
 * 单个记忆文件的读取上限。出处：`projectMemoryStableRead.ts`
 * （`PROJECT_MEMORY_PREVIEW_MAX_BYTES`，5 MiB）。
 */
export const MEMORY_READ_MAX_BYTES = 5 * 1024 * 1024

/**
 * 不允许作为记忆目录的敏感路径段。出处：`core/src/memory/memory-file-path.ts`
 * （`SENSITIVE_MEMORY_PATH_SEGMENTS`）。
 */
const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([
  '.git',
  'hooks',
  '.husky',
  '.githooks',
  'node_modules',
  '.vscode',
  '.idea',
  'head',
  'config',
  'objects',
  'refs',
  '.zcode',
  'skills',
  'commands',
  'agents',
  '.cargo',
  '.devcontainer',
  '.yarn',
  '.mvn',
])

/** 记忆目录名。出处：`core/src/memory/project-root.ts`。 */
const MEMORY_DIRECTORY_NAME = 'memory'

/** 记忆根相对存储根的位置。出处：`core/src/memory/project-root.ts` 与 `memoryService.ts`。 */
const MEMORY_PROJECTS_SEGMENTS = ['memories', 'projects']

/**
 * 写穿符号链接被拒绝时抛出的错误。
 *
 * 对应 ZCode 的 `SymlinkWriteRefusedError`
 * （`apps/zcode-cli/packages/adapters/src/fs/index.ts`）。
 */
export class SymlinkWriteRefusedError extends Error {
  /** @param {string} message 错误说明。 */
  constructor(message) {
    super(message)
    this.name = 'SymlinkWriteRefusedError'
    this.code = 'SYMLINK_WRITE_REFUSED'
  }
}

/**
 * 解析 DSH 主目录：`$DSH_HOME` 优先，否则 `~/.dsh`。每次现读环境变量，不缓存。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量来源。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  if (configured) return resolve(configured)
  return join(homedir(), '.dsh')
}

/**
 * 把项目路径规范成稳定的 slug（仅影响可读性，隔离由哈希承担）。
 *
 * 出处：`core/src/memory/project-root.ts`（`sanitizeProjectSlug`）。
 *
 * @param {string} value 原始项目基名。
 * @returns {string} 非空 slug。
 */
export function sanitizeProjectSlug(value) {
  return sanitizeMemorySlug(value)
}

/**
 * 由项目根目录解析出该项目独占的记忆根目录。
 *
 * 出处：`core/src/memory/project-root.ts`（`resolveProjectMemoryRoot`）。哈希输入、
 * Windows 小写化、slug 规则都与之保持一致，只有 `cliStorageRoot` 换成了 `$DSH_HOME`。
 *
 * @param {string} projectRoot 项目根目录（绝对或相对）。
 * @param {NodeJS.ProcessEnv} [env] 环境变量来源。
 * @returns {{ root: string, indexFilePath: string, slug: string, hash: string, projectRoot: string }}
 */
export function resolveProjectMemoryPaths(projectRoot, env = process.env) {
  const normalized = resolve(projectRoot)
  const keySource = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const hash = createHash('sha256').update(keySource).digest('hex').slice(0, 16)
  const slug = sanitizeProjectSlug(basename(normalized) || 'project')
  const root = join(
    resolveDshHome(env),
    ...MEMORY_PROJECTS_SEGMENTS,
    `${slug}-${hash}`,
    MEMORY_DIRECTORY_NAME,
  )
  return {
    root,
    indexFilePath: join(root, MEMORY_INDEX_FILE_NAME),
    slug,
    hash,
    projectRoot: normalized,
  }
}

/**
 * 断言目标路径位于根目录之内。
 *
 * 出处：`packages/services/src/memory/memoryService.ts`
 * （`assertContainedProjectMemoryPath`）。
 *
 * @param {string} rootDir 根目录。
 * @param {string} targetPath 目标路径。
 * @returns {void}
 * @throws {Error} 目标逃出根目录时。
 */
export function assertContainedMemoryPath(rootDir, targetPath) {
  const relativePath = relative(rootDir, targetPath)
  const escapes =
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  if (escapes) {
    throw new Error(`project memory path escapes the memory root: ${targetPath}`)
  }
}

/**
 * 断言记忆文件名安全：必须是单段、非敏感、且以 `.md` 结尾。
 *
 * 出处：`core/src/memory/memory-file-path.ts`（`resolveSafeMemoryFilePath` 与
 * `containsSensitiveMemoryPathSegment`）。
 *
 * @param {string} fileName 记忆文件名。
 * @returns {void}
 * @throws {Error} 文件名非法时。
 */
export function assertSafeMemoryFileName(fileName) {
  const value = String(fileName ?? '')
  const isSingleSegment =
    value.length > 0 && value !== '.' && value !== '..' && basename(value) === value
  if (!isSingleSegment || !value.endsWith('.md')) {
    throw new Error(`invalid project memory file name: ${JSON.stringify(fileName)}`)
  }
  const segments = value.split(/[\\/]+/u)
  for (const segment of segments) {
    const normalized = segment
      .toLowerCase()
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, '')
      .split(':', 1)[0]
      .replace(/[. ]+$/u, '')
    if (SENSITIVE_MEMORY_PATH_SEGMENTS.has(normalized)) {
      throw new Error(`refusing to use a sensitive path segment for memory: ${segment}`)
    }
  }
}

/**
 * 原子写入一个文本文件。
 *
 * 出处：`apps/zcode-cli/packages/adapters/src/fs/index.ts`（`atomicWrite`）。
 * 逐条对齐其行为：拒绝写穿符号链接、保留既有权限位、独占创建临时文件、
 * 落盘后 rename；失败时清理临时文件并降级为 `O_NOFOLLOW` 原地覆盖。
 *
 * @param {string} targetPath 目标文件绝对路径。
 * @param {string} content 完整内容。
 * @param {AbortSignal} [signal] 调用方的取消信号；触发后不再开始新的写入步骤。
 * @returns {Promise<void>} 完成时 settle。
 */
export async function writeFileAtomic(targetPath, content, signal) {
  throwIfAborted(signal)
  await mkdir(join(targetPath, '..'), { recursive: true })

  /** @type {number | undefined} */
  let existingMode
  try {
    const targetInfo = await lstat(targetPath)
    if (targetInfo.isSymbolicLink()) {
      throw new SymlinkWriteRefusedError(
        `Refusing to write through symlink: ${targetPath}. Resolve the symlink and pass the real target path explicitly.`,
      )
    }
    existingMode = targetInfo.mode
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }

  throwIfAborted(signal)
  const temporaryPath = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`

  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    )
    try {
      await handle.writeFile(content, { signal })
      if (existingMode !== undefined) {
        // 原子写会用临时文件 inode 覆盖目标；先复制原权限，避免抹掉执行位等标志。
        await handle.chmod(existingMode)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    // rename 不接受 signal，因此提交前显式检查一次：取消后不发布新内容。
    throwIfAborted(signal)
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    if (isAbortError(error)) throw error
    const fallbackHandle = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    ).catch((openError) => {
      if (errorCode(openError) === 'ELOOP') {
        throw new SymlinkWriteRefusedError(
          `Refusing to write through symlink: ${targetPath} (O_NOFOLLOW)`,
        )
      }
      throw openError
    })
    try {
      await fallbackHandle.writeFile(content, { signal })
      await fallbackHandle.sync()
    } finally {
      await fallbackHandle.close()
    }
  }
}

/**
 * 稳定读取一个记忆文件。
 *
 * 出处：`packages/services/src/memory/projectMemoryStableRead.ts`
 * （`readProjectMemoryFileFromStableHandle`）。对齐其安全属性：拒绝符号链接与非普通
 * 文件、`O_NOFOLLOW` 打开、校验打开前后的文件身份一致、限制体积。
 *
 * 与 ZCode 的差异：ZCode 会在身份不一致时抛 `PROJECT_MEMORY_FILE_CHANGED`；本插件
 * 把「读不到一致快照」降级为「这次没有记忆」—— 记忆读取不是失败源。
 *
 * @param {string} filePath 文件绝对路径。
 * @param {AbortSignal} [signal] 调用方的取消信号；取消时向上抛出而不是降级。
 * @returns {Promise<{ content: string, exists: boolean, mtimeMs: number | undefined }>}
 */
export async function readMemoryFileStable(filePath, signal) {
  throwIfAborted(signal)
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle
  try {
    const preOpenStat = await lstat(filePath, { bigint: true })
    if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
      return { content: '', exists: false, mtimeMs: undefined }
    }
    if (preOpenStat.size > BigInt(MEMORY_READ_MAX_BYTES)) {
      return { content: '', exists: false, mtimeMs: undefined }
    }

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(filePath, constants.O_RDONLY | noFollow)
    const openedStat = await handle.stat({ bigint: true })
    if (!openedStat.isFile() || !sameSnapshot(openedStat, preOpenStat)) {
      return { content: '', exists: false, mtimeMs: undefined }
    }

    const content = await handle.readFile({ encoding: 'utf8', signal })
    const finalStat = await handle.stat({ bigint: true })
    if (!sameSnapshot(openedStat, finalStat)) {
      return { content: '', exists: false, mtimeMs: undefined }
    }
    if (Buffer.byteLength(content, 'utf8') > MEMORY_READ_MAX_BYTES) {
      return { content: '', exists: false, mtimeMs: undefined }
    }

    return { content, exists: true, mtimeMs: Number(finalStat.mtimeNs) / 1_000_000 }
  } catch (error) {
    // 取消是调用方的意图，必须向上传播；其余读取失败才降级为「没有记忆」。
    if (isAbortError(error)) throw error
    return { content: '', exists: false, mtimeMs: undefined }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * 同步读取记忆文件，供 system prompt 组装使用。
 *
 * `PromptSection.text` / `PromptContext.text` 的 provider 契约是同步返回字符串，
 * 因此这一处必须同步。文件不存在或不可读一律返回空串。
 *
 * @param {string} filePath 文件绝对路径。
 * @returns {string} 文件内容；不可读时为空串。
 */
export function readMemoryFileSync(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** 记忆条目的写入结果。 */
export class ProjectMemoryStore {
  /**
   * @param {{ root: string, indexFilePath: string, projectRoot: string }} paths 记忆路径。
   */
  constructor(paths) {
    this.root = paths.root
    this.indexFilePath = paths.indexFilePath
    this.projectRoot = paths.projectRoot
  }

  /**
   * 保存一条记忆：写自己的文件 + 更新索引。两步都是原子写。
   *
   * 这与 ZCode 的形态一致（`core/src/subagent/persistent-memory-prompt.ts` 的
   * 「How to save memories」两步法：先写记忆文件，再往 `MEMORY.md` 加一行指针）。
   * 区别只在于 ZCode 由模型直接用 Write 工具做这两步，本插件把它收敛成一个工具调用。
   *
   * @param {object} input 保存参数。
   * @param {string} input.key 记忆主题（决定文件名与索引标题）。
   * @param {string} input.content 记忆正文。
   * @param {string} [input.type] 记忆类型。
   * @param {string} [input.description] 一行摘要；缺省时从正文派生。
   * @param {string} [input.originSessionId] 写入它的会话 id。
   * @param {AbortSignal} [input.signal] 调用方的取消信号。
   * @returns {Promise<{ fileName: string, filePath: string, bytes: number }>} 写入结果。
   */
  async save({ key, content, type, description, originSessionId, signal }) {
    throwIfAborted(signal)
    const slug = sanitizeMemorySlug(key)
    const fileName = `${slug}.md`
    assertSafeMemoryFileName(fileName)

    const filePath = join(this.root, fileName)
    assertContainedMemoryPath(this.root, filePath)

    const body = String(content ?? '').trim()
    const resolvedDescription = String(description ?? '').trim() || deriveDescription(body)

    const fileContent = renderMemoryFile({
      name: slug,
      description: resolvedDescription,
      type,
      body,
      originSessionId,
    })

    // 记忆文件本身是一次纯原子替换，没有读-改-写，因此不存在竞争。
    await writeFileAtomic(filePath, fileContent, signal)

    // 索引是「读-改-写」，必须串行化，否则并发保存会互相覆盖、丢掉条目。
    await withIndexLock(this.indexFilePath, async () => {
      throwIfAborted(signal)
      const release = await acquireFileLock(this.indexFilePath, signal)
      try {
        const indexContent = await this.readIndex(signal)
        const nextIndex = upsertIndexEntry(indexContent.content, {
          title: String(key ?? '').trim() || slug,
          fileName,
          hook: resolvedDescription,
        })
        await writeFileAtomic(this.indexFilePath, nextIndex, signal)
      } finally {
        if (release) await release()
      }
    })

    return { fileName, filePath, bytes: Buffer.byteLength(fileContent, 'utf8') }
  }

  /**
   * 读取索引文件（稳定读）。
   *
   * @param {AbortSignal} [signal] 调用方的取消信号。
   * @returns {Promise<{ content: string, exists: boolean }>} 索引内容。
   */
  async readIndex(signal) {
    const snapshot = await readMemoryFileStable(this.indexFilePath, signal)
    return { content: snapshot.content, exists: snapshot.exists }
  }

  /**
   * 列出记忆根目录下的记忆条目（不含索引）。
   *
   * 这是 ZCode `core/src/memory/recall/manifest.ts`（`scanMemoryManifest`）的**最小
   * 子集**：只做「列出 `.md` 文件并解析 frontmatter」，不做 mtime 排序、不做 200 条
   * 上限、不做预览截断、不递归子目录。
   *
   * 完整的 manifest 子系统已实现在 `subsystems/manifest.js`（`scanMemoryManifest` /
   * `formatMemoryManifest`），需要排序/上限/递归时请用那个入口；本方法保留原语义不变。
   *
   * @returns {Promise<{ fileName: string, description?: string, type?: string }[]>} 条目列表。
   */
  async listEntries() {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      const results = []
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue
        if (!entry.name.endsWith('.md') || entry.name === MEMORY_INDEX_FILE_NAME) continue
        const snapshot = await readMemoryFileStable(join(this.root, entry.name))
        if (!snapshot.exists) continue
        results.push({ fileName: entry.name, ...parseMemoryFrontmatter(snapshot.content) })
      }
      return results
    } catch {
      return []
    }
  }
}

/**
 * 解析 `lstat`/`open` 结果的错误码。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {unknown} 错误码。
 */
function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * 判断一个错误是否为取消错误。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} 是否由 AbortSignal 触发。
 */
function isAbortError(error) {
  if (typeof error !== 'object' || error === null) return false
  const name = /** @type {{ name?: unknown }} */ (error).name
  const code = /** @type {{ code?: unknown }} */ (error).code
  return name === 'AbortError' || code === 'ABORT_ERR'
}

/**
 * 在开始一个不可中断的步骤之前检查取消状态。
 *
 * `tools` 的契约要求每个异步工具「observe or forward」调用方的 `exec.signal`
 * （`docs/cookbook/adding-a-tool.md`，Rules of the execute() contract —
 * "Honor `exec.signal`"）。文件系统原语里只有 `readFile`/`writeFile` 接受 signal，
 * `lstat`/`rename`/`mkdir` 不接受，因此在每个不可中断的步骤之前显式检查一次。
 *
 * @param {AbortSignal | undefined} signal 调用方信号。
 * @returns {void}
 * @throws {Error} 已取消时抛出一个 `AbortError`。
 */
function throwIfAborted(signal) {
  if (signal?.aborted !== true) return
  const error = new Error('project memory operation aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  throw error
}

// ---------------------------------------------------------------------------
// 索引读-改-写的串行化
//
// 记忆文件是纯原子替换，没有竞争；但索引是「读 → 改 → 写」，并发保存会互相覆盖。
// 两道防线：
//
//   1. **进程内**：按索引路径串成一条 promise 链，同一进程的并发保存依次执行。
//   2. **跨进程**：`wx` 独占创建的 `<index>.lock` 邻接锁，带指数退避与超时。
//      拿不到锁时**照常写入**（单次写入本身是原子的）—— 宁可接受一次小概率的
//      条目覆盖，也绝不因为锁竞争让一次本来可以成功的记忆保存失败。
//
// 与 ZCode 的差异（刻意，已标注）：ZCode 的记忆写入走 `writeTextFile` 的
// `expectedRevision` 乐观并发（`adapters/src/fs/index.ts` 与
// `core/src/tool/handlers/write.ts`）—— 版本不匹配时**写入失败**。本插件选择
// 「串行化 + 重试」而不是「冲突即失败」：对用户而言，一次保存因为别人同时在存
// 另一条记忆而报错，比极低概率的索引条目覆盖更糟。检测冲突的目的（不静默丢数据）
// 由串行化达成。
// ---------------------------------------------------------------------------

/** 进程内锁链：索引路径 → 当前队尾 promise。 */
const indexLockChains = new Map()

/**
 * 串行执行一次索引读-改-写：先排队（进程内），再抢锁（跨进程）。
 *
 * @param {string} key 索引文件路径。
 * @param {() => Promise<unknown>} task 需要串行执行的任务。
 * @returns {Promise<unknown>} 任务结果。
 */
async function withIndexLock(key, task) {
  const previous = indexLockChains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  // 队尾吞掉结果与异常，保证后续任务总能继续排队。
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  indexLockChains.set(key, tail)
  try {
    return await run
  } finally {
    // 只有当自己仍是队尾时才移除条目，避免把后排队列丢掉；
    // 这样 Map 不会随着不同项目路径无限增长（插件生命周期内的状态卫生）。
    if (indexLockChains.get(key) === tail) indexLockChains.delete(key)
  }
}

/** 跨进程锁的等待上限（毫秒）。 */
const LOCK_TIMEOUT_MS = 2000

/**
 * 尽力获取一把跨进程的邻接锁。
 *
 * @param {string} targetPath 目标文件路径（锁为 `<target>.lock`）。
 * @param {AbortSignal} [signal] 调用方的取消信号；取消时立刻停止等待。
 * @returns {Promise<(() => Promise<void>) | undefined>} 释放函数；未拿到锁时为 undefined。
 */
async function acquireFileLock(targetPath, signal) {
  const lockPath = `${targetPath}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delayMs = 10

  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(String(process.pid), 'utf8').catch(() => undefined)
      return async () => {
        await handle.close().catch(() => undefined)
        await rm(lockPath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      if (errorCode(error) !== 'EEXIST') return undefined
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      delayMs = Math.min(delayMs * 2, 200)
    }
  }

  return undefined
}

/**
 * 两个文件快照是否指向同一份内容。
 *
 * 出处：`projectMemoryStableRead.ts`（`isSameFileSnapshot`）：比较设备号、inode、
 * 大小与修改时间。
 *
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint }} left 快照 A。
 * @param {{ dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint }} right 快照 B。
 * @returns {boolean} 是否一致。
 */
function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  )
}

/**
 * 记忆目录的只读校验：确认它存在、是目录、且不是符号链接。
 *
 * 出处：`packages/services/src/memory/memoryService.ts`（`requirePlainDirectory`）。
 *
 * @param {string} rootDir 记忆根目录。
 * @returns {Promise<boolean>} 是否是普通目录。
 */
export async function isPlainMemoryDirectory(rootDir) {
  try {
    const info = await lstat(rootDir)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 校验记忆根目录的真实路径仍落在 DSH 主目录之内。
 *
 * 出处：`memoryService.ts`（`assertContainedProjectMemoryPath`，用 `realpath` 解析
 * 之后再做包含性判断，避免符号链接把读写引到数据目录之外）。
 *
 * @param {string} rootDir 记忆根目录。
 * @param {NodeJS.ProcessEnv} [env] 环境变量来源。
 * @returns {Promise<boolean>} 是否位于 DSH 主目录之内。
 */
export async function isContainedInDshHome(rootDir, env = process.env) {
  try {
    const homeRealPath = await realpath(resolveDshHome(env))
    const rootRealPath = await realpath(rootDir)
    const relativePath = relative(homeRealPath, rootRealPath)
    return (
      relativePath.length > 0 &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 已实现的三个 ZCode 独立子系统（见 `src/subsystems/`，各自可单独调用）
//
//   1. manifest 扫描与召回排序 → `subsystems/manifest.js`
//      ZCode: apps/zcode-cli/packages/core/src/memory/recall/manifest.ts
//      （`scanMemoryManifest`：递归收集 .md、读 30 行预览、解析 frontmatter、
//       按 mtime 倒序、上限 200 条；`formatMemoryManifest` 渲染成单行清单。）
//      本文件里的 `listEntries()` 保留为更小的列出能力，未被该子系统取代。
//
//   2. 自动抽取 → `subsystems/extraction.js`
//      ZCode: apps/zcode-cli/packages/core/src/memory/extraction.ts
//      （`createMemoryExtractionScheduler` + `evaluateMemoryExtraction` +
//       `buildMemoryExtractionPrompt`；游标 boundaryMessageId、跳过规则
//       direct-memory-write / no-user-prose、MINIMUM_USER_WORDS = 3。）
//      这一层只做决策与调度，执行由调用方注入。
//
//   3. 后台总结 → `subsystems/summarization.js`
//      ZCode: apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts
//      （`runMemoryAgentLoop`：独立伴生 Agent 循环 + 工具白名单 + 写/删权限收窄到
//       记忆目录内；编排层在 runtime/helpers/project-memory-extraction.ts。）
//
// 仍未实现的部分：
//
//   4. 记忆文件写入期 frontmatter 修复
//      ZCode: apps/zcode-cli/packages/core/src/memory/origin-session.ts
//      （`stampMemoryOriginSessionId`：给既有记忆文件补齐 node_type/originSessionId）。
//      本插件只在**新建**记忆时写入这两个字段，不改写既有文件。
//
//   5. 向量检索 / 语义召回 —— ZCode 中不存在此子系统
//      【更正】此前这里写的是「ZCode 通过外部 provider 提供向量检索」。那是一句
//      没有依据的推测，已删除。核实结论（ZCode 源码
//      apps/zcode-cli/packages/core/src/memory/ 全目录）：
//        - recall/ 下只有 manifest.ts / types.ts / index.ts，没有向量实现；
//        - grep `cosine|similarity|embed|vector|score` 在该目录 0 命中；
//        - `MemoryManifestEntry` 只有 {description, filePath, filename, mtimeMs, type}，
//          没有相似度分数字段；排序依据是 mtimeMs 倒序，不是相似度。
//      因此「带相似度分值的召回列表」在 ZCode 中没有对应机制，本插件不实现。
// ---------------------------------------------------------------------------
