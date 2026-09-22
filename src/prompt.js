/**
 * 记忆进入模型上下文的两个注入面。
 *
 * ZCode 把记忆拆成**两处**注入，而不是一处（这是与初始提示词最大的机制差异）：
 *
 *   1. **指引**（记忆系统怎么用、格式是什么）→ `injectionTarget: "system"`
 *      出处：`apps/zcode-cli/packages/core/src/context/sections/memory.ts`
 *      （`buildMemorySection` / `buildMemoryContent`）。
 *      DSH 对应物：`ctx.systemPrompt.section()`（系统提示词段落）。
 *
 *   2. **索引内容**（`MEMORY.md` 的实际文本）→ `injectionTarget: "meta_user"`
 *      出处：`apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts`
 *      （`buildProjectMemoryIndexContent`，由 `buildRequestUserContextSection` 组装）。
 *      DSH 对应物：`ctx.systemPrompt.context()` —— 官方文档
 *      `docs/subsystems/system-prompt.md` 定义 `PromptContext` 为
 *      "Dynamic model context materialized as a durable user-role snapshot"，
 *      与 ZCode 的 meta_user 注入位是同一件事。
 *
 * 初始提示词只描述了「把记忆注入 system prompt」一处，且注入的是记忆正文；这与
 * ZCode 冲突，已按 ZCode 修正为上述两处。
 *
 * @module dsh-zcode-project-memory/prompt
 */

import {
  MEMORY_INDEX_FILE_NAME,
  MEMORY_RECALL_TYPES,
  formatProjectMemoryIndexContent,
} from './memory-format.js'

/**
 * 渲染记忆**指引**段落（进 system prompt）。
 *
 * 内容对齐 ZCode `context/sections/memory.ts` 的 `buildMemoryContent`：说明记忆目录
 * 位置、每条记忆一个文件、frontmatter 字段、四种类型、以及「先查重再写、别把仓库
 * 已经记录的东西写进来」。
 *
 * 与 ZCode 的差异（已刻意保留）：ZCode 让模型「直接用 Write 工具写文件」，因为
 * ZCode 没有记忆工具；本插件按选题要求提供 `save_project_memory` 工具，因此指引
 * 改为引导模型调用该工具。这样模型不需要知道文件系统的落盘细节。
 *
 * **删除**是上述差异的例外：本插件没有删除工具，所以删除必须由模型自己动文件 ——
 * 与 ZCode 一致（`core/src/subagent/persistent-memory-prompt.ts` 的
 * "If they ask you to forget something, find and remove the relevant entry"，
 * 以及 `context/sections/memory.ts` 的 "delete memories that turn out to be wrong"）。
 * 指引里明确写出「删文件 + 删索引行」两半，避免留下悬空指针。
 *
 * @param {string} memoryRoot 该项目的记忆根目录。
 * @returns {string} 指引文本。
 */
export function renderMemoryGuidance(memoryRoot) {
  const types = MEMORY_RECALL_TYPES.join(' | ')
  return [
    '# Persistent Project Memory',
    '',
    `You have a persistent, file-based memory system for this project at \`${memoryRoot}/\`.`,
    'It survives across sessions: what you save now is readable by a future session in this same project.',
    '',
    `Write to it with the \`save_project_memory\` tool — do not create files there by hand, and do not run mkdir or check for its existence. Each memory is one file holding one fact, with frontmatter of \`name\`, \`description\`, and \`metadata.type\` (one of ${types}).`,
    '',
    '`user` — who the user is (role, expertise, preferences). `feedback` — guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. `project` — ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. `reference` — pointers to external resources (URLs, dashboards, tickets).',
    '',
    `Each save also maintains \`${MEMORY_INDEX_FILE_NAME}\`, the index loaded into context each session — one line per memory, never memory content.`,
    '',
    'Before saving, check whether an existing memory already covers it and update that one instead of duplicating it. Do not save what the repository already records (code structure, past fixes, git history, AGENTS.md) or what only matters to this conversation.',
    '',
    `To remove a memory, delete its file and remove that memory's line from \`${MEMORY_INDEX_FILE_NAME}\`. There is no delete tool, so both halves are yours: a deleted file whose index line survives leaves a dangling pointer that future sessions will try to follow. Do this when the user asks you to forget something, and also when a memory turns out to be wrong or outdated.`,
  ].join('\n')
}

/**
 * 渲染记忆**索引内容**（进 user-role 运行时上下文）。
 *
 * 输出对齐 ZCode `buildRequestUserContextSection` 里 `buildProjectMemoryIndexContent`
 * 的返回值：一行来源说明 + 格式化后的索引。
 *
 * 与 ZCode 的差异（已刻意保留）：ZCode 把这段和 AGENTS.md 指令一起包在 `# agentsMd`
 * 大标题下；DSH 的指令由 `dsh-agent-instructions` 拥有，本插件只贡献记忆这一段，
 * 不生成 `# agentsMd` 标题，避免与 DSH 自己的指令段落重复或冲突。
 *
 * @param {string} memoryRoot 该项目的记忆根目录。
 * @param {string} indexContent `MEMORY.md` 的原始内容。
 * @param {{ lineLimit?: number, characterLimit?: number }} [limits] 索引截断上限（来自插件配置）。
 * @returns {string} 可注入的上下文文本；没有记忆时返回空串（空文本不贡献任何内容）。
 */
export function renderMemoryContext(memoryRoot, indexContent, limits) {
  const formatted = formatProjectMemoryIndexContent(indexContent, limits)
  if (!formatted) return ''

  return [
    `Contents of ${memoryRoot}/${MEMORY_INDEX_FILE_NAME} (user's auto-memory, persists across conversations):`,
    '',
    formatted,
  ].join('\n')
}
