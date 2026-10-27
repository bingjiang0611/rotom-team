# Git 提交文件大小检查

在仓库根目录安装一次：

```sh
npm run hooks:install
```

正常执行 `git add`、`git commit` 即会触发检查。Git 不同步本地启用配置；新 clone 或首次 pull 到此功能后需安装一次。`npm ci` 不会自动安装 hook。Node.js 必须在提交进程的 `PATH` 中。

## 检查规则

- 仅检查本次新增、修改、复制、重命名文件的**完整暂存版本**，不读取工作区版本，也不只计算新增行。
- 单文件超过 **20,000 字节**就拒绝提交，即按 `bytes / 4` 估算超过 5,000 tokens。这是体积预算，不是真实 tokenizer 计数。
- 已有大文件被修改后同样受限；未修改文件和删除项不检查。
- 跳过符号链接、子模块、锁文件：`package-lock.json`、`npm-shrinkwrap.json`、`yarn.lock`、`pnpm-lock.yaml`、`Package.resolved`。
- 二进制资源按扩展名排除：`.png`、`.woff2`。文本 SVG 仍检查。
- 当前没有额外的生成源码豁免。
- 新生成物需审查并更新 `scripts/check-staged-file-size.mjs` 中的明确列表。不按作者身份猜测，不整体豁免 `generated/`、源码目录或测试。

超限时，错误会列出路径、字节数、估算 tokens，并给出固定的拆分指引：按职责提取组件、领域逻辑或测试套件，复用已有模块，避免循环依赖和空包装层。更新引用与测试、验证行为，再重新暂存提交；不要按行数机械切片。脚本不调用模型，具体拆分方案仍由开发者或 Agent 决定。

## 手动检查与验证

```sh
npm run check:staged-file-size
node --test test/check-staged-file-size.test.ts
```

测试使用隔离临时 Git 仓库，覆盖阈值边界、部分暂存、特殊文件名、豁免、重命名、存量大文件、真实提交拦截和原有 hook 的保留。
测试已由现有 `npm test` 入口发现。

## 安装范围和限制

安装器只修改当前仓库的本地 `core.hooksPath`，指向 Git 目录中的 `rotom-team-hooks`；不修改全局配置。其他已有 hook 通过符号链接保留，已有 pre-commit 则拒绝覆盖，需先人工整合。安装时保留的 hook 列表不会自动发现上游新 hook；需要更新时，先恢复安装前的 `core.hooksPath`、删除 Git 目录内的 `rotom-team-hooks`，再重新安装。

本地 hook 可被 `git commit --no-verify` 跳过，不是安全边界或服务端门禁。脚本读取 Git 元数据的单次输出上限为 16 MiB；超出会失败而非放行。若确需提交更大规模的文件列表，应先评估并改为流式读取，不静默关闭检查。
