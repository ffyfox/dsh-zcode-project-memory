# Third-party notices

## ZCode

Portions of this project are derived from [zai-org/ZCode](https://github.com/zai-org/ZCode),
Copyright 2026 Z.AI Co., Ltd, licensed under the Apache License, Version 2.0.

Derived portions — in every case a JavaScript/ESM port of TypeScript source — are:

| This project | Derived from (ZCode) |
|---|---|
| `src/subsystems/manifest.js` | `apps/zcode-cli/packages/core/src/memory/recall/manifest.ts`, `recall/types.ts` |
| `src/subsystems/extraction.js` | `apps/zcode-cli/packages/core/src/memory/extraction.ts` |
| `src/subsystems/summarization.js` | `apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts` |
| `src/store.js` | `apps/zcode-cli/packages/adapters/src/fs/index.ts` (`atomicWrite`), `apps/zcode-cli/packages/services/src/memory/projectMemoryStableRead.ts`, `apps/zcode-cli/packages/core/src/memory/memory-file-path.ts`, `memory/project-root.ts` |
| `src/memory-format.js` | `apps/zcode-cli/packages/core/src/memory/index-content.ts`, `recall/types.ts`, `apps/zcode-cli/packages/services/src/memory/memoryService.ts` |
| `src/prompt.js` | `apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts`, `context/sections/memory.ts`, `context/sections/request-user-context.ts` |

Some strings and constants are reproduced verbatim, including the memory-extraction prompt,
the tool-policy denial messages, and `MEMORY_INDEX_LINE_LIMIT` / `MEMORY_INDEX_CHARACTER_LIMIT`
/ `MANIFEST_FILE_LIMIT` / `MANIFEST_PREVIEW_LINE_LIMIT` / `MINIMUM_USER_WORDS`.

A copy of the Apache License, Version 2.0 is provided in [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0).
The upstream `NOTICE` content is reproduced in [`NOTICE-ZCode.md`](NOTICE-ZCode.md).

### Trademarks

Apache License 2.0 §6 grants no permission to use the Licensor's trade names,
trademarks, service marks, or product names, **except as required for reasonable
and customary use in describing the origin of the Work**.

This project's package name (`dsh-zcode-project-memory`) and documentation use
"ZCode" solely to describe that origin, as permitted by §6. This project is an
**unofficial community work**: it is not affiliated with, authorized,
sponsored, or endorsed by Z.AI Co., Ltd. "ZCode" and "DeepSeek Harness" are the
trademarks of their respective owners.

## Other dependencies

This project depends on `@deepseek-ai/schemastery` (MIT) at runtime.
`@deepseek-ai/cordis` is a peer dependency, not bundled.