# Contributing

感谢参与 `@ffyfox/dsh-project-memory`。本文件说明本仓库实际使用的开发流程 —— 下面每一条都对应仓库里真实存在的脚本或文件，没有额外流程要求。

## 开发环境

| 项 | 要求 | 依据 |
|---|---|---|
| Node.js | `>=20` | `package.json` 的 `engines.node` |
| 包管理器 | npm（仓库带 `package-lock.json`） | `package-lock.json` |
| 运行时依赖 | 仅 `@deepseek-ai/schemastery` | `package.json` 的 `dependencies` |

```sh
git clone https://github.com/ffyfox/dsh-project-memory.git
cd dsh-project-memory
npm ci
npm test
```

本包是**纯 JavaScript（ESM）**，没有转译或构建步骤：`src/` 下的源码就是发布产物。因此仓库里不存在 `build` 脚本，也不需要 `prepare`。

## 测试

```sh
npm test                # 全量：9 个测试文件，129 项检查
npm run test:subsystems # 只跑三个子系统的最小可执行用例
```

`npm test` 逐个运行 `test/*.mjs`，全部以退出码 0 结束才算通过。请保证提交前 `npm test` 为 0；CI 会在 Node 20 与 22 上跑同一条命令（`.github/workflows/ci.yml`）。

测试文件与其覆盖面的对应关系见 README 的「测试」一节。

### 写测试的约定

- 测试用 `node:test` / `node:assert/strict` 与裸 `node` 运行，不引入测试框架依赖。
- `test/packaging.mjs` 用 `npm pack --dry-run` 校验真实产物。**新增不该发布的文件请放在 `files` 白名单之外**；放进去的顶层文件会被该测试拦下。
- 三个子系统各自有一份最小可执行用例，在 stdout 打印一行可解析 JSON 并以 0 退出，便于单独调用。

## 代码约定

- 源码注释与 README 以**中文**为主，`README.en.md` 是英文对照版。两者改一处就要改另一处。
- 与 ZCode 的对应关系是刻意维持的：移植自上游的文件在 `NOTICE.md` 里逐文件登记，改这些文件时请同步更新该表。
- 移植自 ZCode 的字符串常量（抽取 Prompt、工具拒绝文案、各 `LIMIT` 常量）**逐字符对齐上游**，有测试断言其一致性。修改前先确认上游是否也改了。
- 不做与发布无关的行为改动；读取记忆失败一律降级为空，不向上抛异常 —— 这是插件的既有约定。

## 提交

提交信息用祈使句、说明「为什么」。仓库历史里的既有风格可以直接参考。

## 许可证

本项目整体为 **MIT AND Apache-2.0**（自有代码 MIT；`src/subsystems/` 与部分文件移植自 Apache-2.0 的 [zai-org/ZCode](https://github.com/zai-org/ZCode)）。

提交贡献即表示你同意以同样的许可证分发。**移植新的上游代码时，必须同时在 `NOTICE.md` 登记来源文件**，否则上游的归属声明就不完整。

## 行为准则

参与本项目请遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。