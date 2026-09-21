# @ffyfox/dsh-project-memory

[English](README.en.md) | 中文

DeepSeek Harness 的项目级长效记忆插件。模型在一次会话里沉淀下的项目教训，会在之后的新会话里被自动读回。

一行 Cordis 插件，做三件事：

1. **注册 `save_project_memory` 工具** —— 写一条记忆（独立文件 + 维护索引）。
2. **注入记忆指引到 system prompt**（`ctx.systemPrompt.section()`）—— 告诉模型何时写、写什么格式、怎么删。
3. **注入记忆索引到运行时上下文**（`ctx.systemPrompt.context()`）—— 新会话开场就带着既有记忆的目录。

记忆按**项目维度隔离**：目录名由项目根目录的规范绝对路径经 sha256 派生，同一项目在任何进程、任何会话里命中同一份记忆，不同项目互不可见。

机制以 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的实现为准复刻，DSH 侧接口以 [DeepSeek Harness 官方文档](https://deepseek-harness.github.io/deepseek-harness/)为准。

## 安装

```sh
dsh plugin --profile <你的 profile> add /path/to/dsh-project-memory
```

`package.json` 声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它加入 profile 的 bundle 层。

插件 `inject` 了 `tools` 与 `systemPrompt` 两个宿主服务，两者由 `dsh-base` 提供，因此 web / headless / tui 等继承 `dsh-base` 的 profile 都能生效；缺少这两个服务的部署里插件停留在 PENDING，不产生副作用。

## 使用

插件装好后无需任何配置，它就是模型的一个工具加两段自动注入。**日常用法就是正常对话** —— 不需要记命令、不需要手动整理文件。

### 让模型记住

直接说，或者让模型自己判断：

```
记住：这个项目的 migration 必须先在 staging 跑满 24 小时才能上生产。
```

模型会调用 `save_project_memory`，写入一条记忆 + 更新索引。它也被告知在遇到**非显而易见的项目约定、架构决策、调试时踩到的坑**时主动保存 —— 那些「未来的人读代码也便宜地推不出来」的知识。

不想让它记的别让它记：临时的任务状态、仓库里已经写着的事实（代码结构、git 历史、AGENTS.md 的内容），指引明确排除了这两类。

### 让它回忆

新会话里直接问就行，**记忆索引在开场就已在上下文里**：

```
这个项目的长效记忆里有什么？
上次说的那个 migration 约束是什么？
```

模型看到索引行后，会按需读取对应的记忆文件拿细节。跨会话、跨进程都有效 —— 记忆落在磁盘上，不依赖某个会话还活着。

### 让它忘记

没有删除工具，所以直接说：

```
忘掉关于 migration 的那条记忆。
```

模型会删掉记忆文件**并**从 `MEMORY.md` 移除那一行。也可以手工删（见下文「删除记忆」）。

### 检查它记住了什么

记忆是纯 Markdown，随时可读可改：

```sh
M=~/.dsh/memories/projects/<项目基名>-<哈希>/memory
cat "$M/MEMORY.md"     # 这行是索引：一条记忆一行
ls "$M"                # 每条记忆一个 .md 文件
```

想清空某个项目的记忆，直接删掉整个 `memory/` 目录即可，插件对不存在的目录安静降级。

## 命令

本包是**纯 JavaScript（ESM）**，没有转译或构建步骤 —— `src/` 下的源码就是发布产物，因此只有安装与测试两条命令：

| 命令 | 说明 |
|---|---|
| `npm install` | 安装唯一运行时依赖 `@deepseek-ai/schemastery` |
| `npm test` | 全量测试（129 项检查） |
| `npm run test:subsystems` | 只跑三个子系统的最小可执行用例 |

从零复现：

```sh
git clone https://github.com/ffyfox/dsh-project-memory.git && cd dsh-project-memory
npm ci        # 或 npm install
npm test      # 退出码 0 即通过
```

要求 Node.js `>=20`（见 `package.json` 的 `engines`）。CI 在 Node 20 与 22 上跑同一条命令，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

## 记忆放在哪

```
<DSH_HOME>/memories/projects/<项目基名>-<路径哈希前16位>/memory/
├── MEMORY.md          # 索引：一行一条，永远不放正文
└── <slug>.md          # 每条记忆一个文件，带 frontmatter
```

`DSH_HOME` 默认 `~/.dsh`。记忆**不写进项目仓库**，项目目录保持干净，也不受 git 操作、清理或只读挂载影响。

## 记忆文件形态

```markdown
---
name: "auth-token-refresh-gotcha"
description: "Expired tokens return 401, not 403."
metadata:
  type: project
  node_type: memory
  originSessionId: "session-…"
---

The refresh endpoint returns 401 (not 403) when the token is merely expired.

**Why:** retry logic keyed on 403 silently drops expired-token retries.
```

`MEMORY.md` 只放指针，一行一条：

```markdown
- [Auth token refresh gotcha](auth-token-refresh-gotcha.md) — Expired tokens return 401, not 403.
```

`type` 取四种：`user`（用户是谁）、`feedback`（工作方式上的指导）、`project`（进行中的工作与约束）、`reference`（外部资源指针）。同一条记忆重复保存会替换自己的文件与索引行，不重复堆叠。

索引超过 200 行或 25000 字符会被截断，注入时带提示。

### 文件名怎么来

文件名由 `key` 净化得到：

| `key` | 文件名 |
|---|---|
| `Auth token refresh gotcha` | `auth-token-refresh-gotcha.md` |
| `部署规则` | `memory-9c31a6.md` |

净化的字符类是 `[a-z0-9._-]`。**非 ASCII 字符会被整体丢弃**，因此当 `key` 含此字符类之外的字符时，slug 后追加原 key 的 6 位哈希 —— 否则 `部署规则` / `发布前检查` / `你的哨兵` 会全部塌缩成同一个 `memory.md` 并互相覆盖。纯 ASCII key 的文件名不受影响，已有记忆不会被改名。

### 删除记忆

**没有删除工具。** 删除是两半：删掉该记忆的文件，**并且**从 `MEMORY.md` 移除它那一行 —— 只删文件会留下悬空索引指针。注入的指引明确告诉了模型这一点，触发条件是「用户要求忘记某事」或「某条记忆被证明错误/过时」。

手工删除同理：

```sh
M=~/.dsh/memories/projects/<项目名>-<哈希>/memory
rm -f "$M/<slug>.md"
# 再从 $M/MEMORY.md 移除对应那一行
```

## 架构

```
src/index.js            Cordis 插件入口：工具注册 + 两处注入
├── src/store.js        记忆读写：路径派生、原子写、稳定读、并发锁
├── src/memory-format.js 记忆与索引的渲染 / 解析、slug 净化
├── src/prompt.js       两个注入面的文本渲染
└── src/subsystems/     三个可选子系统，可单独导入调用（见下）
```

### 两个注入面

| 内容 | 注入 API | 位置 |
|---|---|---|
| 记忆**指引**（何时写、格式、怎么删） | `ctx.systemPrompt.section()` | system prompt |
| 记忆**索引**（`MEMORY.md` 文本） | `ctx.systemPrompt.context()` | user-role 运行时快照 |

拆成两处与 ZCode 一致：指引是稳定的规则，索引是随内容变化的数据。

### 子系统

`src/subsystems/` 下三个模块复刻自 ZCode `core/src/memory/`。三者**互不 import**、可单独导入调用，需要彼此时通过参数注入（`formatManifest` / `execute` 回调）而非 import。

它们**不被** `apply()` 自动启动 —— 插件的运行时行为就是「工具 + 两处注入」这三件事。

| 子系统 | 入口 | 产出 |
|---|---|---|
| manifest 扫描 | `scanMemoryManifest({fileSystem?, rootDir, signal?})`、`formatMemoryManifest(manifest)` | 记忆文件清单（条目数组 / 单行清单文本） |
| 自动抽取 | `createMemoryExtractionScheduler(execute)`、`evaluateMemoryExtraction(snapshot, cursor)`、`buildMemoryExtractionPrompt(…)` | 抽取决策 + 增量范围 + 抽取 Prompt |
| 后台总结 | `runMemoryAgentLoop({model, tools, executeTool, …})`、`evaluateMemoryAgentToolPolicy(input)` | 总结文本 + 轮次 + 工具调用轨迹 |

```js
import { scanMemoryManifest, formatMemoryManifest } from '@ffyfox/dsh-project-memory/src/subsystems/manifest.js'

const manifest = await scanMemoryManifest({ rootDir: memoryRoot })
console.log(formatMemoryManifest(manifest))
// - [project] auth-token-refresh-gotcha.md (2026-09-22T05:05:00.000Z): Expired tokens return 401…
```

`files` 白名单包含整个 `src`，`src/subsystems/` 随包发布。每个子系统都有独立的最小可执行用例，在 stdout 打印一行可解析 JSON（`{"subsystem": "manifest", …}`）并以退出码 0 结束。

## 配置

插件导出 Schemastery `Config`。三个字段都直接影响注入体量或单条容量，属于不同部署可能想设成不同值的量：

```yaml
- id: project-memory
  config:
    indexLineLimit: 200        # 索引注入的行数上限
    indexCharacterLimit: 25000 # 索引注入的字符数上限
    maxMemoryChars: 8000       # 单条记忆正文长度上限
```

默认值与内置常量一致，不配置时行为不变。非法值（如 `maxMemoryChars: 0`）在插件加载期即失败，不静默降级。

## 失败行为

记忆是增强项，不能成为会话的失败源：

- 记忆不存在或不可读 → 注入空串，不在上下文里留空占位。
- 拿不到可解析的项目目录 → 工具返回 `saved: false`，两处注入返回空串。
- 读取一律拒绝符号链接与非普通文件，5 MiB 体积上限。

写入侧：拒绝写穿符号链接、保留既有权限位、`O_EXCL|O_NOFOLLOW` 独占创建临时文件、`fsync` 后 `rename`；索引的读-改-写有进程内排队 + 跨进程文件锁，并发保存不丢条目。

## 测试

```sh
npm test
```

| 测试 | 覆盖 |
|---|---|
| `test/injection.mjs` | 注入面为 section + context；工具参数与输出用真实契约 |
| `test/config.mjs` | 导出 Config、Standard Schema 接口、默认值在 schema 上、非法配置加载期失败 |
| `test/roundtrip.mjs` | 写入 → **另起进程**读回，逐字符相等；文件形态；重复保存替换；项目隔离 |
| `test/isolation.mjs` | 路径写法归一；同名不同父目录不碰撞；写 A 不影响 B |
| `test/robustness.mjs` | 符号链接拒绝、权限保留、原子替换、稳定读、路径安全、体积上限、并发不丢条目、`exec.signal` 传播、raw 工具自校验 |
| `test/subsystem-manifest.mjs` | 递归收集、跳过索引/非 .md/失效 symlink、mtime 倒序、字段集、渲染格式、端口可注入 |
| `test/subsystem-extraction.mjs` | 游标语义、两条跳过规则及优先级、Prompt 要素、调度器 coalescing / 不推进游标 / 关机 |
| `test/subsystem-summarization.mjs` | 拒绝文案、工具白名单、网络/Agent/mcp 拒绝、记忆目录内写删边界、循环轮次与并行 toolCall |
| `test/packaging.mjs` | 打包产物符合预期、源码不读取仓库内 `.md`、入口闭包不含开发期文件 |

端到端手工验证（需要可用的模型凭据）：

```sh
cd /your/project
dsh --profile headless "把这条教训存进项目记忆：<...>，然后回复 DONE"
dsh --profile headless "这个项目的长效记忆里说了什么？引用索引行原文。"
```

## 与 ZCode 的差异

复刻以行为一致为目标，以下差异是刻意的：

| 差异 | 说明 |
|---|---|
| 保存入口 | ZCode 无记忆工具，模型直接用 `write` 写文件；本插件提供 `save_project_memory`，指引相应改为引导调用该工具 |
| 索引维护 | ZCode 由模型手工更新 `MEMORY.md`；本插件在保存时由代码同步更新，两者不会不一致 |
| 索引并发 | ZCode 用 `expectedRevision` 乐观并发，冲突即失败；本插件用排队 + 文件锁，一次保存不会因为别人同时在存另一条记忆而失败 |
| `# agentsMd` 标题 | ZCode 把索引与 AGENTS.md 指令包在同一标题下；DSH 的指令由 `dsh-agent-instructions` 拥有，本插件不生成该标题 |
| HTML 注释剥离 | 不引入 `marked` 依赖，改用围栏感知的保守近似（宁可多留，不可误删正文） |
| 段落排序值 | 官方 `getSectionOrder()` 只接受仓库登记的具名项，仓库外插件拿不到，只能自选数值（section 950 / context 100） |
| 工具命名 | 子系统的工具白名单用 DSH 实际注册的小写名（`read`/`write`/`edit`/`bash`），ZCode 的大写名在 DSH 上不会命中 |

### 未复刻的部分

| 项 | 原因 |
|---|---|
| 每轮自动抽取 + 后台总结的**自动触发** | 子系统已实现且可用，但默认不挂载。每轮无条件触发会带来 token 成本叠加、并发限流压力与记忆熵增 |
| 既有文件的 frontmatter 修复 | 仅在新建记忆时写入 `node_type` / `originSessionId`，不改写既有文件 |

规范符合性检查报告见 [`docs/conformance-report.md`](docs/conformance-report.md)。

## 贡献

开发环境、测试与提交约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；参与本项目请遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## License

本项目自身代码采用 MIT。部分实现移植自 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，Copyright 2026 Z.AI Co., Ltd），因此整体为 **MIT AND Apache-2.0**。

逐文件的移植对应关系见 [`NOTICE.md`](NOTICE.md)；Apache-2.0 全文见 [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0)，上游 NOTICE 见 [`NOTICE-ZCode.md`](NOTICE-ZCode.md)。