/**
 * `dsh-project-memory` 的宿主插件行。
 *
 * 为 DSH 提供项目级的长效记忆：模型在一次会话里沉淀下的项目教训，能在之后的新会话
 * 里被自动读回。
 *
 * 这一行做三件事，注入面严格对齐 ZCode（见 `prompt.js` 的模块注释）：
 *
 * 1. **注册 `save_project_memory` 工具**：写一条记忆（自己的文件）+ 维护索引。
 * 2. **注入记忆指引到 system prompt**：`ctx.systemPrompt.section()`。
 * 3. **注入记忆索引到运行时上下文**：`ctx.systemPrompt.context()`，落成 user-role
 *    快照 —— 对应 ZCode 的 `meta_user` 注入位。
 *
 * 项目身份来自会话 header 的 `cwd`，因此同一工具对任何项目都成立；记忆目录由该路径
 * 经 sha256 派生（见 `store.js`），不同项目互不可见。
 *
 * 保守边界（对应「材料未写明即取最保守」）：
 *   - 不做 watcher、不做向量检索（ZCode 中不存在该子系统，见 `store.js` 末尾说明）。
 *   - 三个独立子系统（manifest 扫描 / 自动抽取 / 后台总结）位于 `src/subsystems/`，
 *     各自可单独导入调用；它们**不被**本文件的 `apply()` 自动启动（见 README
 *     「子系统」一节对启用方式的说明）。
 *   - 记忆读取失败一律降级为「本项目还没有记忆」，绝不向上抛异常。
 *
 * @module dsh-project-memory
 */

import Schema from '@deepseek-ai/schemastery'

import { ProjectMemoryStore, readMemoryFileSync, resolveProjectMemoryPaths } from './store.js'
import { renderMemoryContext, renderMemoryGuidance } from './prompt.js'
import {
  MEMORY_INDEX_CHARACTER_LIMIT,
  MEMORY_INDEX_LINE_LIMIT,
  MEMORY_RECALL_TYPES,
} from './memory-format.js'
import { MEMORY_BODY_MAX_CHARS } from './store.js'

/** Cordis 插件名（出现在 Loader 树与诊断里）。 */
export const name = 'project-memory'

/**
 * 声明依赖的两个宿主服务：工具注册表与 system prompt 组装器。
 *
 * 两者都由 `dsh-base` 提供，因此任何继承 base 的 profile（web / headless / tui）
 * 都能激活本插件；缺少它们的部署里这一行停留在 PENDING，不产生副作用。
 * 出处：`docs/user/develop/basic/index.md`（Declare dependencies）与
 * `docs/user/develop/framework/service.md`（Required and optional dependencies）。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * 插件配置。
 *
 * 这三个值都直接决定每次请求的注入体量（token 成本）或单条记忆的容量，属于
 * 「两个部署可能想设成不同」的量，因此按 `docs/user/develop/basic/config.md` 的
 * 「Do not hardcode tunable values」（L78-92）做成配置字段，而不是硬编码常量；
 * 默认值沿用 ZCode 的常量，行为与之前完全一致。约束直接写在 schema 上，非法配置
 * 在插件加载期就失败（同文件「Fail loudly on invalid configuration」，L94-96）。
 *
 * 仍然固定、刻意不做成配置的量及其理由：
 *   - `MEMORY_READ_MAX_BYTES`（5 MiB）：与 ZCode `projectMemoryStableRead.ts` 的
 *     安全上限保持一致的防御性上界，不是部署策略。
 *   - `LOCK_TIMEOUT_MS`：内部并发退避时长，不改变对外语义。
 *   - 段落/上下文排序值：属中心化分配约定，不是部署旋钮（见下方 SECTION_ORDER）。
 */
export const Config = Schema.object({
  indexLineLimit: Schema.number()
    .min(1)
    .default(MEMORY_INDEX_LINE_LIMIT)
    .description('Maximum index lines injected into the runtime context before truncation.'),
  indexCharacterLimit: Schema.number()
    .min(1)
    .default(MEMORY_INDEX_CHARACTER_LIMIT)
    .description('Maximum index characters injected into the runtime context before truncation.'),
  maxMemoryChars: Schema.number()
    .min(1)
    .default(MEMORY_BODY_MAX_CHARS)
    .description('Maximum length of a single memory body accepted by save_project_memory.'),
})

/**
 * 记忆指引段落的排序值。
 *
 * 官方文档 `docs/subsystems/system-prompt.md` 规定仓库贡献方通过
 * `ctx.systemPrompt.getSectionOrder(name)` 解析中心化分配的位置，而
 * `PromptSectionOrderName` 只接受仓库自己登记的具名项。本插件在仓库之外，拿不到
 * 具名分配，因此只能显式给一个数值。真实分配带是 500–10100（HARNESS_IDENTITY
 * -1000、DEPLOYMENT_PERSONA_PREFIX 0、PLAN_POLICY 500、TEAM_POLICY 600、
 * TOOL_* 1000–2900、TOOLS_SDK 5000、HARNESS_SOURCE 10000）；这里取 950，落在
 * 策略段之后、工具指引之前，且不与任何已知分配相撞。
 *
 * 不确定点：这是本插件自选的数值，不是官方分配；若上游为记忆类内容新增具名项，
 * 应改为调用 `getSectionOrder()`。
 */
const SECTION_ORDER = 950

/**
 * 记忆索引上下文的排序值。
 *
 * 同理，官方 `CONTEXT_ORDERS` 只有 SANDBOX_POLICY 110 / APPROVAL_POLICY 115 /
 * SUBAGENT_DELEGATION 120 三个仓库具名项。这里取 100，让记忆索引排在策略上下文
 * 之前（ZCode 也把 project memory 放在 meta_user 块的第一位）。同样属于插件自选值。
 */
const CONTEXT_ORDER = 100

/** 注入段落/上下文的稳定名。 */
const SECTION_NAME = 'project-memory'
const CONTEXT_NAME = 'project-memory-index'

/** 工具名：与选题里写死的名字保持一致。 */
const TOOL_NAME = 'save_project_memory'

/**
 * 工具声明的参数名集合。
 *
 * 与 `parameters.properties` 的键保持一一对应；用于在 `execute` 里落实
 * `additionalProperties: false`（原始 JSON Schema 注册不会代做这件事）。
 */
const DECLARED_PARAMETER_NAMES = new Set(['key', 'content', 'type', 'description'])

/**
 * 从一次会话/执行里解析出项目根目录。
 *
 * 优先使用会话 header 的 `cwd`（DSH 自己校验过的绝对路径）；拿不到时退回
 * `process.cwd()`。两者都没有时返回 undefined，注入与写入都会安静跳过 —— 宁可
 * 不记忆，也不要把记忆写到错误的项目上。
 *
 * @param {unknown} candidate 可能携带 `cwd` 的会话或执行对象。
 * @returns {string | undefined} 项目根目录的绝对路径。
 */
function resolveProjectRoot(candidate) {
  const cwd = candidate?.header?.cwd ?? candidate?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd
  const fallback = process.cwd()
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined
}

/**
 * Cordis 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文。
 * @param {{ indexLineLimit?: number, indexCharacterLimit?: number, maxMemoryChars?: number }} [config]
 *   由 `Config` schema 校验并填好默认值的插件配置。
 */
export function apply(ctx, config) {
  const indexLineLimit = config?.indexLineLimit ?? MEMORY_INDEX_LINE_LIMIT
  const indexCharacterLimit = config?.indexCharacterLimit ?? MEMORY_INDEX_CHARACTER_LIMIT
  const maxMemoryChars = config?.maxMemoryChars ?? MEMORY_BODY_MAX_CHARS
  const indexLimits = { lineLimit: indexLineLimit, characterLimit: indexCharacterLimit }

  /** 取一个带上下文的 logger；日志本身绝不能成为失败源。 */
  const log = (level, ...args) => {
    try {
      const logger = ctx.logger?.('project-memory')
      if (typeof logger?.[level] === 'function') logger[level](...args)
    } catch {
      /* ignore */
    }
  }

  /**
   * 解析某个会话/执行对应的记忆路径与存储对象。
   *
   * @param {unknown} candidate 携带 cwd 的会话/执行对象。
   * @returns {{ root: string, indexFilePath: string, projectRoot: string } | undefined}
   */
  const pathsFor = (candidate) => {
    const projectRoot = resolveProjectRoot(candidate)
    if (projectRoot === undefined) return undefined
    try {
      return resolveProjectMemoryPaths(projectRoot)
    } catch {
      return undefined
    }
  }

  // ---- 1. 工具：写入当前项目的长效记忆 --------------------------------
  //
  // 直接在插件上下文里注册：`tools` 已在插件级 `inject` 里声明，走到这里时
  // `ctx.tools` 一定可用。注册返回的 disposer 由 Cordis 的 fiber 管理，插件卸载时
  // 自动反注册（见 docs/cordis-tutorial/02-lifecycle-and-effects.md：
  // 通过 Cordis API 做的注册都是 effect）—— 因此不需要、也不应该手写 dispose 钩子。
  ctx.tools.register({
    name: TOOL_NAME,
    description:
      "Save a durable, project-specific lesson to this project's long-term memory, so future sessions in this project can read it back. Use it for non-obvious project conventions, architectural decisions, and gotchas discovered while debugging — things a future agent could not cheaply derive from reading the repository. Do not use it for transient task state or for facts the repository already records.",
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Short topic heading for this memory, e.g. "Database migration rules" or "Auth token refresh gotcha". Determines the memory file name.',
        },
        content: {
          type: 'string',
          description: 'The exact knowledge to remember for future sessions in this project.',
        },
        type: {
          type: 'string',
          enum: [...MEMORY_RECALL_TYPES],
          description:
            'Memory kind. "project" (default) for ongoing work, goals, or constraints; "feedback" for guidance on how to work; "user" for who the user is; "reference" for external resources.',
        },
        description: {
          type: 'string',
          description:
            'One-line summary used later to judge relevance. Defaults to the first line of the content.',
        },
      },
      required: ['key', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          saved: { type: 'boolean' },
          fileName: { type: 'string' },
          filePath: { type: 'string' },
          bytes: { type: 'number' },
        },
        required: ['saved', 'fileName', 'filePath', 'bytes'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.saved
            ? `Saved to project memory: ${value.filePath} (${value.bytes} bytes).`
            : 'Project memory was not saved: this session has no resolvable project directory.',
        },
      ],
    },
    async execute(args, exec) {
      const paths = pathsFor(exec.agent)
      if (paths === undefined) {
        return { saved: false, fileName: '', filePath: '', bytes: 0 }
      }

      const key = String(args.key ?? '').trim()
      const content = String(args.content ?? '').trim()
      if (key.length === 0 || content.length === 0) {
        throw new Error('save_project_memory requires a non-empty "key" and "content"')
      }
      if (content.length > maxMemoryChars) {
        throw new Error(
          `save_project_memory content is ${content.length} characters, over the ${maxMemoryChars}-character limit`,
        )
      }
      // 原始 JSON Schema 注册的工具自己负责输入校验（docs/cookbook/adding-a-tool.md，
      // "Raw JSON-Schema tools registered directly own their input validation"）。
      // parameters 声明了 additionalProperties: false，这里就要真的拒绝未知键，
      // 否则声明与行为不一致。
      const unknownKeys = Object.keys(args).filter((name) => !DECLARED_PARAMETER_NAMES.has(name))
      if (unknownKeys.length > 0) {
        throw new Error(
          `save_project_memory received unknown parameter(s): ${unknownKeys.join(', ')}`,
        )
      }

      const sessionId = exec.agent?.session?.id
      const store = new ProjectMemoryStore(paths)
      // 工具契约要求 observe or forward 调用方的 exec.signal
      // （docs/cookbook/adding-a-tool.md，"Honor `exec.signal`"）。
      const result = await store.save({
        key,
        content,
        type: args.type,
        description: args.description,
        originSessionId: typeof sessionId === 'string' ? sessionId : undefined,
        signal: exec.signal,
      })

      log('info', `saved project memory "${result.fileName}" for ${paths.projectRoot}`)
      return {
        saved: true,
        fileName: result.fileName,
        filePath: result.filePath,
        bytes: result.bytes,
      }
    },
  })

  // ---- 2. 注入记忆指引到 system prompt --------------------------------
  //
  // `PromptSection.text` 的 provider 契约是同步返回字符串（`renderPrompt` 在同一个
  // tick 里拼接），因此这里同步读目录是否存在；指引本身是静态文本，只在拿不到项目
  // 目录时为空。
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const paths = pathsFor(context?.agent)
      if (paths === undefined) return ''
      try {
        return renderMemoryGuidance(paths.root)
      } catch {
        return ''
      }
    },
  })

  // ---- 3. 注入记忆索引到运行时上下文（user-role 快照）-------------------
  //
  // 对应 ZCode 的 `injectionTarget: "meta_user"`。文本为空时不贡献任何内容，
  // 因此「本项目还没有记忆」不会在上下文里留下空占位。
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (context) => {
      const paths = pathsFor(context?.agent)
      if (paths === undefined) return ''
      try {
        return renderMemoryContext(paths.root, readMemoryFileSync(paths.indexFilePath), indexLimits)
      } catch {
        return ''
      }
    },
  })
}
