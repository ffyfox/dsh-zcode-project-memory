# Changelog

本文件记录本项目的显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `CONTRIBUTING.md`：开发环境、测试与提交约定。
- `CODE_OF_CONDUCT.md`：Contributor Covenant 2.1。
- `.github/workflows/ci.yml`：在 Node 20 / 22 上执行 `npm ci`、`npm test` 与 `npm pack --dry-run`。
- `CHANGELOG.md`：本文件。

### Changed

- `.gitignore`：除 `node_modules/` 与 `*.tgz` 外，补上构建产物、覆盖率、日志、本地配置与密钥、编辑器与操作系统文件的忽略规则。
- `README.md` / `README.en.md`：修正测试项数量（131 → 实测 129）；补充构建与测试、贡献、变更日志、行为准则的入口。
- **包名改为 `@ffyfox/dsh-project-memory`**：npm 上的非 scoped 名 `dsh-project-memory` 已被他人占用（同名但无关的项目，2026-08-16 发布），scoped 名可用。`cordis.patch.yml` 的插件行、`package.json` 的 `name` 与 `exports`、`package-lock.json` 及文档中的安装/导入示例同步更新。GitHub 仓库名保持不变。
- 可发布：移除 `private`，新增 `publishConfig.access = "public"`，并把 `CHANGELOG.md` 加入 `files` 白名单。

### Fixed

- 修正 README 中与实际测试输出不符的检查项数量。
- 修正文档化的子系统导入路径：`exports` 此前只映射 `.` 与 `./package.json`，README 给出的
  `'@ffyfox/dsh-project-memory/src/subsystems/*.js'` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
  现为三个子系统补上对应的 `exports` 子路径，文档示例从装好的包里可真实执行。

## [0.1.0] - 2026-09-22

首次发布。

### Added

- Cordis 宿主插件行：注册 `save_project_memory` 工具，并通过
  `ctx.systemPrompt.section()` 注入记忆指引、通过 `ctx.systemPrompt.context()` 注入记忆索引。
- 项目维度的记忆隔离：记忆目录由项目根目录规范绝对路径的 sha256 派生，同一项目跨进程命中同一份记忆。
- `src/store.js`：记忆读写 —— 路径派生、原子写（`O_EXCL|O_NOFOLLOW` 临时文件 + `fsync` + `rename`）、稳定读、进程内排队与跨进程文件锁。
- `src/memory-format.js`：记忆与索引的渲染、解析与 slug 净化。
- `src/prompt.js`：两个注入面的文本渲染。
- `src/subsystems/`：三个可单独导入、互不 `import` 的子系统 ——
  `manifest.js`（记忆文件清单扫描）、`extraction.js`（自动抽取决策与增量范围）、
  `summarization.js`（后台总结 Agent 循环）。三者**不被** `apply()` 自动启动。
- Schemastery `Config`：`indexLineLimit` / `indexCharacterLimit` / `maxMemoryChars`，
  非法值在插件加载期失败。
- 测试：9 个测试文件、129 项检查，覆盖注入面、配置符合性、跨进程闭环、项目隔离、
  健壮性、三个子系统与打包产物。
- `docs/conformance-report.md`：对 DSH 官方开发文档的逐条符合性判定。
- 发布要素：`LICENSE`（MIT）、`LICENSE-APACHE-2.0`、`NOTICE.md`、
  `NOTICE-ZCode.md`、`cordis.patch.yml`。

[Unreleased]: https://github.com/ffyfox/dsh-project-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ffyfox/dsh-project-memory/releases/tag/v0.1.0