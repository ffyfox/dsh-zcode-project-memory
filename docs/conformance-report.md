# dsh 官方开发文档符合性检查报告

本报告逐项判定 `@ffyfox/dsh-project-memory` 是否符合 dsh 官方开发文档规范。

## 判定基准（唯一权威）

| 项 | 值 |
|---|---|
| 判定基准 | DeepSeek Harness 官方仓库 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) |
| 版本 | tag `dsh-v0.1.6-alpha.2` |
| commit | `ddefc45fbc7f8e46dd73185e68295696d1297887`（Thu Sep 17 21:19:19 2026 +0800） |
| 文档站 | <https://deepseek-harness.github.io/deepseek-harness/>（由上述仓库生成，供人阅读） |

本报告引用的文档路径（如 `docs/user/develop/basic/config.md`）**均相对于该仓库根目录**。复核方式：

```sh
git clone --depth 1 --branch dsh-v0.1.6-alpha.2 https://github.com/deepseek-ai/deepseek-harness.git
```

**适用文档范围**：本插件是**仓库外（out-of-tree）的第三方 bundle**，因此判定基准取面向插件作者的两组文档：

- `docs/user/develop/**`（`basic/`、`framework/`、`practice/`）—— 插件作者教程与契约
- `docs/cookbook/adding-a-tool.md` —— 工具作者参考

**刻意排除的文档**：仓库根 `AGENTS.md`、`docs/AGENTS.md`（文档分层与字数预算标准）、`docs/development.md`、`docs/architecture.md`、`docs/subsystems/**`、`docs/tool-catalog.md`、`docs/config-catalog.md` 等。理由：这些规范约束的是 **dsh 仓库自身**（`packages/`、`docs/` 的目录结构、生成物、i18n 配对、字数上限），对一个不进入该仓库的独立 npm 包不适用。此判断本身记为**不适用**条目（见 R25）。

**未定位到的规范**：无。官方文档已定位并读取，本次检查**不依赖**「依据缺失」的保守路径。

---

## 一、结论汇总

| 判定 | 条数 |
|---|---|
| 符合 | 25 |
| 不符合（本次已修复） | 5 |
| 不符合（未修复） | 0 |
| 不适用 | 4 |

**「不符合且未修复」条目数 = 0**（验收标准 2 满足）。

---

## 二、逐条判定

### A. bundle 打包与清单（`docs/user/develop/basic/publish.md`）

| # | 规范条款出处 | 项目对应位置 | 判定 |
|---|---|---|---|
| R1 | `publish.md` L13「A **bundle** is an npm package that ships a configuration layer. Its manifest declares `dsh.bundle` … a patch file that inserts or overrides plugin rows.」 | `package.json` L24-28（`dsh.bundle.patch: "./cordis.patch.yml"`） | 符合 |
| R2 | `publish.md` L16「A bundle is what you author and distribute; a profile is what a user boots with. **Nothing is both.**」 | `package.json` L24-28：只声明 `dsh.bundle`，无 `dsh.profile` | 符合 |
| R3 | `publish.md` L36-43 bundle 清单示例字段：`name` / `version` / `type: "module"` / `main` / `files` / `dsh.bundle.patch` | `package.json` L2 `name`、L3 `version`、L5 `type`、L7 `main`、L12 `files`、L24-28 `dsh.bundle.patch` | 符合 |
| R4 | `publish.md` L41 `"files": ["index.js", "cordis.patch.yml"]`（入口与 patch 必须进产物） | `package.json` L12-17：`["src", "cordis.patch.yml", "README.md", "LICENSE"]`；`src` 含入口 `src/index.js` | 符合 |
| R5 | `publish.md` L49 入口导出 `export const name` | `src/index.js` L36 | 符合 |
| R6 | `publish.md` L51 入口导出 `export function apply` | `src/index.js` L142 | 符合 |
| R7 | `publish.md` L56「The patch is a YAML array … plugin rows reference the package **by name** instead of a relative source path so Node resolution finds the installed code」 | `cordis.patch.yml` L12-14：YAML 数组，`name: @ffyfox/dsh-project-memory` 与 `package.json` L2 的包名一致 | 符合 |
| R8 | `publish.md` L163「**The author** ships a `prepare` script … that builds the published entry points from source」（仅针对 git 安装的 TS 包） | `package.json`：无 `prepare`。本包是**纯 JavaScript**（无 `lib/` 构建产物），git 安装后入口即可直接加载，不需要转译 | 不适用 |
| R9 | `publish.md` L175-178「distribute built artifacts instead — **Publish to npm** … **Ship a tarball** from `pnpm pack`」 | 纯 JS 源码即产物；`npm pack` 产物含 7 个文件（见 `test/packaging.mjs`） | 符合 |

### B. 插件配置（`docs/user/develop/basic/config.md`）

| # | 规范条款出处 | 项目对应位置 | 判定 |
|---|---|---|---|
| R10 | `config.md` L9「Export a `Config` type and a same-named Schemastery schema. Put defaults directly on the schema fields」 | `src/index.js` L63-76：`export const Config = Schema.object({...})`，三个字段各自 `.default(...)` | **不符合 → 已修复**（见 §三.2） |
| R11 | `config.md` L45「Do not export a plain object as `Config`; it does not implement the Standard Schema interface required by Cordis」 | `src/index.js` L63 的 `Config` 是 Schemastery schema，实现 `~standard`（`test/config.mjs` 断言 `~standard.version === 1`） | 符合 |
| R12 | `config.md` L80「Harness requires **anything that two deployments may want to set differently to be a configuration field**」 | 修复前：`src/store.js` L51 `MEMORY_BODY_MAX_CHARS`、`src/memory-format.js` L26/L29 索引上限均为硬编码常量 | **不符合 → 已修复**（见 §三.2） |
| R13 | `config.md` L92「The test is whether `cordis.yml` can change the value without a code edit」 | 修复后：`--patch` 覆盖 `maxMemoryChars: 20` 实测生效（模型回复 `LIMIT_ENFORCED`）；`test/config.mjs` 断言 `indexLineLimit`/`indexCharacterLimit` 覆盖生效 | **不符合 → 已修复**（见 §三.2） |
| R14 | `config.md` L94-96「Express self-contained constraints in the schema so invalid configuration fails while the plugin loads」 | `src/index.js` L64-75 每个字段带 `.min(1)`；`test/config.mjs` 断言 `{maxMemoryChars: 0}` 等返回 `issues` | 符合 |
| R15 | `config.md` L100「Because registrations are effects and clean themselves up, replacement does not retain the old instance's registrations」 | `src/index.js`：工具/段落/上下文全部经 `ctx.*` 注册，无手写 dispose | 符合 |

### C. 插件形态与生命周期（`docs/user/develop/basic/index.md`、`framework/`）

| # | 规范条款出处 | 项目对应位置 | 判定 |
|---|---|---|---|
| R16 | `basic/index.md` L22-29「a plugin is a TypeScript module that exports an `apply` function … That is the complete configuration.」 | `src/index.js` L36 `name`、L142 `apply` | 符合 |
| R17 | `basic/index.md` L68「Anything registered through `ctx` … is cleaned up when the plugin unloads. You do not need to call removeListener or clearInterval manually.」 | `src/index.js` L180/L287/L305 全为 `ctx` 注册；源码无 `ctx.on('dispose')` 或手工反注册（`test/injection.mjs` 断言） | 符合 |
| R18 | `basic/index.md` L70「For a resource that needs explicit cleanup, such as a network connection, use `ctx.effect()`」 | 插件无定时器/连接/文件监视器等需显式释放的句柄。`src/store.js` L527 `indexLockChains` 是纯内存队列状态，非资源句柄；其条目在 `withIndexLock` 的 `finally` 中按「仍是队尾才删除」回收，不会随项目数无限增长 | 符合 |
| R19 | `basic/index.md` L89-95「If the plugin consumes another service such as `tools` or `llm`, declare it in `inject`」 | `src/index.js` L46 `export const inject = ['tools', 'systemPrompt']` | 符合 |
| R20 | `framework/service.md` L92「Required: the plugin does not load while the service is absent.」 | 同上；缺失 `tools`/`systemPrompt` 的部署中该行停在 PENDING | 符合 |
| R21 | `framework/service.md` L104-109「If a required service disappears … Dependent plugins dispose automatically … load again when the service returns.」 | 插件不自行缓存服务引用（每次经 `ctx.tools` / `ctx.systemPrompt` 访问），由 Cordis 负责卸载与重载 | 符合 |
| R22 | `framework/events.md` L66、L80「A waterfall listener **must call `next()`**」 | 插件未注册任何 waterfall 监听器（`tools/pre-execute`、`system-prompt/assemble` 等均未使用） | 不适用 |

### D. 工具契约（`docs/user/develop/basic/tool.md`、`docs/cookbook/adding-a-tool.md`）

| # | 规范条款出处 | 项目对应位置 | 判定 |
|---|---|---|---|
| R23 | `tool.md` L16「`export const inject = ['tools']`」 | `src/index.js` L46（含 `tools`） | 符合 |
| R24 | `tool.md` L19「`ctx.tools.register(...)`」 | `src/index.js` L180 | 符合 |
| R25 | `tool.md` L22-28 参数用 DSL、`output` 声明 `schema` + `render` | `src/index.js` L184-231：`parameters` 用**原始 JSON Schema**、`output` 含 `schema`+`render` | 符合（依据 `adding-a-tool.md` L42 末句，见 R26） |
| R26 | `adding-a-tool.md` L42「Raw JSON-Schema tools registered directly **own their input validation**.」 | 原始 JSON Schema 注册被文档明确承认为合法形态；插件在 `src/index.js` L238-257 自行校验非空、长度上限与未知参数 | 符合 |
| R27 | `adding-a-tool.md` L38「Registration is effect-based: disposing the plugin fiber unregisters the tool.」 | `src/index.js` L180 注册；无手工反注册（同 R17） | 符合 |
| R28 | `adding-a-tool.md` L42「You still hand-check constraints the DSL does not express, such as non-empty strings …」 | `src/index.js` L238-257：非空 key/content、`maxMemoryChars` 上限、未知参数拒绝 | 符合 |
| R29 | `adding-a-tool.md` L45「**Declare and return one canonical JSON value.** … `execute` returns only the inferred value」 | `src/index.js` L273-278 返回 `{saved, fileName, filePath, bytes}`，与 L211-222 的 `output.schema` 一致；不返回 content blocks | 符合 |
| R30 | `adding-a-tool.md` L46「**Throwing … means `isError`.**」 | `src/index.js` L238-257 对基础设施/输入失败抛错；正常结果用 canonical value 表达 | 符合 |
| R31 | `adding-a-tool.md` L47「**Honor `exec.signal`.** Cancel in-flight work when it fires.」 | 修复前：`src/index.js` 的 `execute(args, exec)` 全程未使用 `exec.signal`；`store.save` 不接收 signal | **不符合 → 已修复**（见 §三.1） |
| R34 | `adding-a-tool.md` L42「Raw JSON-Schema tools registered directly **own their input validation**.」——声明了 `additionalProperties: false` 就必须真的拒绝未知键 | `src/index.js` L209 声明 `additionalProperties: false`；修复前 `execute` 未拒绝未知参数（静默忽略） | **不符合 → 已修复**（见 §三.3） |

### E. 仓库自身规范（判定为不适用）

| # | 规范条款出处 | 项目对应位置 | 判定 |
|---|---|---|---|
| R32 | 根 `AGENTS.md`（文档分层 tier、字数预算 `verify-doc-budgets`、i18n 配对、`doc-typecheck`） | 本插件是仓库外独立 npm 包，不进入 dsh 仓库的 `docs/` 树，其文档不由该标准管辖 | 不适用 |
| R33 | `docs/development.md`、`docs/architecture.md`、`docs/subsystems/**`、`docs/tool-catalog.md`、`docs/config-catalog.md` | 约束 dsh 仓库自身的开发流程、架构图与**由源码生成**的目录（`gen-cordis-catalog.ts` 等）；本包不产出这些生成物 | 不适用 |

---

## 三、修复详情（不符合项 → 已修复）

### 三.1 R31：工具未遵守 `exec.signal`（`adding-a-tool.md` L47）

**问题**：`execute` 的整条异步链路（写记忆文件 → 抢锁 → 读索引 → 写索引）没有任何一处观察或转发调用方的 `exec.signal`，违反「Honor `exec.signal`. Cancel in-flight work when it fires.」

**修复**（改动文件：`src/store.js`、`src/index.js`）：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `src/store.js` L224 | `writeFileAtomic(targetPath, content)` | `writeFileAtomic(targetPath, content, signal)`，入口 `throwIfAborted(signal)`；`handle.writeFile(content, { signal })`；`rename` 前再检查一次 |
| `src/store.js` L300 | `readMemoryFileStable(filePath)` | `readMemoryFileStable(filePath, signal)`；`handle.readFile({ encoding, signal })`；`catch` 中 `isAbortError` 时**向上抛**而不是降级为「没有记忆」 |
| `src/store.js` L499（新增） | — | `throwIfAborted(signal)` / `isAbortError(error)`：`lstat`/`rename`/`mkdir` 不接受 signal，故在每个不可中断步骤前显式检查 |
| `src/store.js` L564 | `acquireFileLock(targetPath)` | `acquireFileLock(targetPath, signal)`：等待循环每轮检查取消 |
| `src/store.js` L383 | `save({..., originSessionId})` | `save({..., originSessionId, signal})`，逐层下传 |
| `src/index.js` L269 | `store.save({...})`（无 signal） | `store.save({..., signal: exec.signal })` |

**复验证据**（`test/robustness.mjs` 新增 3 项，全部通过）：

```
✓ 预先取消的 exec.signal 使保存立刻失败且不落盘
✓ 读取路径同样传播 exec.signal（不把取消降级成「没有记忆」）
✓ 未取消的 signal 不影响正常写入（observe 而非一律拒绝）
```

实测：预取消 → `AbortError/ABORT_ERR`，且 `aborted.md` 未落盘；未取消 → 正常写入 `k2.md`。

### 三.2 R10 / R12 / R13：可调值被硬编码，且未导出 Config

**问题**：`config.md` L80 要求「两个部署可能想设成不同」的量必须是配置字段，L92 的判据是「`cordis.yml` 能否在不改代码的情况下改变该值」。以下三个值修复前是硬编码常量，`cordis.yml` 无法改变：

| 常量 | 修复前位置 | 为何属于「可调」 |
|---|---|---|
| `MEMORY_BODY_MAX_CHARS = 8000` | `src/store.js` L51 | 单条记忆容量，不同团队/用途取值不同 |
| `MEMORY_INDEX_LINE_LIMIT = 200` | `src/memory-format.js` L26 | 直接决定每次请求注入的记忆文本量（token 成本），随模型上下文预算变化 |
| `MEMORY_INDEX_CHARACTER_LIMIT = 25000` | `src/memory-format.js` L29 | 同上 |

**修复**（改动文件：`package.json`、`src/index.js`、`src/memory-format.js`、`src/prompt.js`）：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `package.json` L29-31 | 无 `dependencies` | 新增 `"@deepseek-ai/schemastery": "^3.18.2"`（`config.md` L9 指定的 schema 工具） |
| `src/index.js` L63-76 | 无 `Config` | `export const Config = Schema.object({ indexLineLimit, indexCharacterLimit, maxMemoryChars })`，默认值即原常量，各带 `.min(1)` |
| `src/index.js` L142 | `apply(ctx)` | `apply(ctx, config)`，读取三个字段（缺省回落默认常量） |
| `src/index.js` L243-245 | `content.length > MEMORY_BODY_MAX_CHARS` | `content.length > maxMemoryChars` |
| `src/memory-format.js` L47-56（新增） | — | `normalizeIndexLimits(limits)`：缺省回落 ZCode 常量 |
| `src/memory-format.js` L342 `formatMemoryIndexContent` | 用硬编码常量截断 | 接受 `limits` 参数 |
| `src/prompt.js` L78 `renderMemoryContext` | 无 limits 参数 | 透传 `limits` |

**行为等价性**：默认值与原常量逐字一致（`{indexLineLimit: 200, indexCharacterLimit: 25000, maxMemoryChars: 8000}`），不配置时行为不变。

**复验证据**（`test/config.mjs` 新增 9 项，全部通过；另加真实运行验证）：

```
✓ 导出 Config（L9）
✓ Config 默认值写在 schema 上（L9）
✓ Config 实现 Standard Schema 接口（L45）
✓ 非法配置返回 issues（fail loudly，L94-96）
✓ cordis.yml 能改变 indexLineLimit 而不改代码（L78-92）
✓ cordis.yml 能改变 maxMemoryChars 而不改代码（L78-92）
✓ indexCharacterLimit 同样可通过配置收紧（L78-92）
```

真实运行验证（`--patch` 覆盖 `maxMemoryChars: 20`）：

```
$ dsh --profile headless --patch /tmp/pm-config-override.yml "Call save_project_memory … "
LIMIT_ENFORCED          # 退出码 0，stderr 为空
```

### 三.3 R34：声明与行为不一致（`additionalProperties: false`）

**问题**：`parameters` 声明 `additionalProperties: false`（`src/index.js` L209），但原始 JSON Schema 注册不做校验（`adding-a-tool.md` L42），修复前未知参数被静默忽略 —— 声明与行为不一致。

**修复**：`src/index.js` L116 新增 `DECLARED_PARAMETER_NAMES`；L252-257 在 `execute` 中拒绝未声明参数。

**复验证据**：

```
✓ 工具拒绝未声明的参数（与 additionalProperties: false 一致）
✓ 工具对空 key/content 自行校验（raw 注册不代做）
```

### 三.4 附带修复：锁队列条目的死代码清理

**问题**：`withIndexLock` 的 `finally` 判断为 `if (indexLockChains.get(key) === undefined) indexLockChains.delete(key)` —— 该分支永不成立（Map 中始终有值），条目永不回收，随不同项目路径无限增长。关联 R18（插件生命周期内的状态卫生）。

**修复**：`src/store.js` L536-553 改为把队尾 promise 存为局部 `tail`，`if (indexLockChains.get(key) === tail) indexLockChains.delete(key)`。

**复验证据**：`test/robustness.mjs` 的「并发写同一项目：索引不丢条目」仍通过（5 条并发保存 → 索引 ≥5 条），证明回收没有丢掉后排队列。

---

## 四、验收标准 3：检查/构建/测试命令与退出码

**命令来源**：`package.json` L21-23 `scripts.test`。项目无 Makefile、无 CI 配置文件（无 `.github/workflows/`、`.gitlab-ci.yml`）。

| 时点 | 命令 | 退出码 |
|---|---|---|
| 修复前（基线） | `npm test` | **0** |
| 修复后 | `npm test` | **0** |

修复前后均为 0，**不存在「原本就失败」的情况**，故无需修复前后对比。

修复后断言总数：**63 项全部通过**（修复前 49 项）。

```
$ npm test
TEST_EXIT=0
63
注入面检查全部通过
配置符合性检查全部通过
闭环验证全部通过
隔离检查全部通过
健壮性检查全部通过
发布/运行时隔离检查全部通过
```

**插件加载复验**（dsh 真实运行）：

```
$ dsh plugin --profile headless add /path/to/dsh-project-memory                 → EXIT=0
$ dsh --profile headless --dump-config | grep -A2 "id: project-memory"          → EXIT=0，stderr 0 字节
$ dsh --profile headless "Call save_project_memory … "                          → EXIT=0，stdout=OK，stderr 空
$ dsh --profile headless "Quote the exact index line … "                        → EXIT=0，逐字引用索引行
```

---

## 五、不确定点与取舍（保守路径）

1. **新增运行时依赖 `@deepseek-ai/schemastery`（不确定 → 已按文档选择）**
   `config.md` L9 明确规定 Config 用 Schemastery schema，L45 又要求必须实现 Standard Schema 接口。要满足 R10/R12/R13 就必须引入该依赖。取舍：**按文档引入**，因为不引入就只能让 R10/R12/R13 保持不符合。副作用：`npm test` 现在需要先 `npm install`（修复前零依赖即可运行）。已同步更新 README 的验证小节。
   *备选方案（未采用）*：手写一个仅实现 `~standard` 的最小 schema。理由：`config.md` L9 指定了 Schemastery，自创实现偏离文档指定做法。

2. **哪些常量算「可调」属判断而非明文列举（不确定 → 已逐条给理由）**
   `config.md` 未列举具体值，只给「两个部署可能想设成不同」这一判据。本次判定为**可调**：索引行/字符上限（token 成本随模型变化）、单条正文上限。判定为**固定**：`MEMORY_READ_MAX_BYTES`（与 ZCode 安全上限一致的防御性上界，非部署策略）、`LOCK_TIMEOUT_MS`（内部退避时长）、段落/上下文排序值（中心化分配约定）。理由已写入 `src/index.js` L57-62 的注释。

3. **`defineTool` DSL vs 原始 JSON Schema（已确认合法，非违规）**
   `tool.md` L22-28 示例用 `defineTool` DSL，本插件用原始 JSON Schema。`adding-a-tool.md` L42 末句明确承认后者合法（「Raw JSON-Schema tools registered directly own their input validation」）。另一约束：`@deepseek-ai/dsh-tools` 从本包目录**不可解析**（实测 `ERR_MODULE_NOT_FOUND`），改用 `defineTool` 会再引入一个运行时依赖且不带来规范收益。故**保留现状**并记为符合。

4. **仓库自身规范（R32/R33）判为不适用（不确定 → 取保守）**
   根 `AGENTS.md` 等规范面向 dsh 仓库自身的目录与生成物。本包是仓库外独立 npm 包，不受其管辖。此判断属解释性结论，已在此显式记录；若上游认为第三方插件也应遵守该文档标准，则 R32/R33 需重新判定。

5. **本报告未覆盖的方面**
   本次未审计运行时行为正确性（记忆内容语义、模型是否恰当使用工具），只审计**文档规范符合性**。功能正确性由 `test/**` 与端到端验证覆盖。

---

## 六、改动文件清单

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `dependencies.@deepseek-ai/schemastery`；`scripts.test` 加入 `test/config.mjs` |
| `src/index.js` | 新增 `Config` 导出与 `DECLARED_PARAMETER_NAMES`；`apply(ctx, config)`；未知参数拒绝；下传 `exec.signal` |
| `src/store.js` | `writeFileAtomic`/`readMemoryFileStable`/`save`/`readIndex`/`acquireFileLock` 支持 `signal`；新增 `throwIfAborted`/`isAbortError`；修复锁队列回收 |
| `src/memory-format.js` | 索引上限改为可传入的 `limits`（默认值不变） |
| `src/prompt.js` | `renderMemoryContext` 透传 `limits` |
| `README.md` | 新增「配置」小节；验证小节补充 `npm install` 与 `test/config.mjs` |
| `test/config.mjs` | 新增：配置条款符合性（9 项） |
| `test/robustness.mjs` | 新增：`exec.signal`（3 项）、raw 工具自校验（2 项） |
| `docs/conformance-report.md` | 本报告 |

未改动：`cordis.patch.yml`、`LICENSE`、`.gitignore`、`test/injection.mjs`、`test/roundtrip.mjs`、`test/isolation.mjs`、`test/packaging.mjs`。

> 说明：上表记录的是**该次检查当时**的改动范围。此后 `README.md`、`test/packaging.mjs`、`.gitignore`、`LICENSE` 均有后续改动；本报告不追述这些后续变更。
