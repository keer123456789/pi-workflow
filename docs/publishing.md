# 发布手册（维护者指南）

面向**第一次给 `@wangchengshi/pi-workflow` 发包的人**（就是你自己）。每一步都给命令与预期输出；照着从上往下走即可完成首次发布与后续版本迭代。

> 包名、版本与元数据来自 M5 计划冻结裁定 D30：name `@wangchengshi/pi-workflow`、version `0.1.0`、license `ISC`、repository `https://github.com/wangchengshi/pi-workflow`（GitHub 用户名是假设值，见 §7）。发布面（exports / files / scripts）见 D31/D32。

## 0. 前提检查

- 本机 Node ≥ 22、npm 随附（`node -v`、`npm -v` 确认）；
- 工作区干净：`git status` 无未提交改动；
- 主分支全绿：`npm run prepublishOnly`（typecheck + lint + test + build，见附录 A）一次跑通。

## 1. npm 账号与 2FA

1. 注册：打开 <https://www.npmjs.com/signup>，用户名建议直接用 **wangchengshi**——本包的 scope `@wangchengshi/` 就是你的 npm 用户名，两者一致最省事。
2. 开启 2FA：登录后进入 **头像 → Settings → Two-Factor Authentication**，绑定认证器 App（或安全密钥）。建议选择 **auth-and-writes** 模式：`npm publish` 时会要求输入一次性验证码（OTP）。
3. 记下用户名与恢复码（恢复码丢失 = 找不回账号）。

## 2. 登录与身份核验

```bash
npm login
```
按提示在浏览器完成授权（开了 2FA 会要 OTP）。然后核验：

```bash
npm whoami
# 预期输出：wangchengshi
```

输出的用户名必须与包 scope 一致——否则你没有 `@wangchengshi/` 的发布权。

## 3. scope 说明：不需要单独创建

- `@wangchengshi/pi-workflow` 中的 `@wangchengshi` 是 npm **scope**。scope 就是你的用户名（或你所属的组织名），**随账号自动存在，无需、也无法单独"创建"**。
- 关键区别：**scoped 包（`@xxx/yyy`）在 npm 上默认是 private（付费档功能）**；要公开发布，`npm publish` 必须**显式加 `--access public`**，否则报 `402 Payment Required`。首次发布漏掉这一项是最常见的坑。

## 4. 首次发布

发布前最后过一遍检查单：

- [ ] `package.json`：`version` 是你要发的版本（首次为 `0.1.0`）；
- [ ] `repository` 字段确认：当前是 `https://github.com/wangchengshi/pi-workflow`——**若你的 GitHub 用户名不是 `wangchengshi`，先改掉再发**（§7）；
- [ ] `npm whoami` 输出与 scope 一致；
- [ ] `npm run prepublishOnly` 全绿。

然后：

```bash
npm publish --access public
```

过程与预期输出：

1. npm 自动执行 `prepublishOnly` 钩子（typecheck → lint → test → build，附录 A）——任何一步失败，发布中止；
2. 自动执行 `prepack`（`npm run build`）——保证 `dist/` 永远是最新构建（附录 A）；
3. 开了 2FA 时，命令行提示 `Enter OTP:`，输入认证器上的 6 位验证码；
4. 成功输出形如：

```
npm notice
=== Tarball Details ===
npm notice package name:   @wangchengshi/pi-workflow
npm notice package size:   ...
npm notice unpacked size:  ...
npm notice total files:    ...
npm notice
+ @wangchengshi/pi-workflow@0.1.0
```

> 备选：想先看会发什么而不真发，用 `npm publish --access public --dry-run`，或 `npm pack` 本地打包预览（附录 B）。

## 5. 网页核验

打开 <https://www.npmjs.com/package/@wangchengshi/pi-workflow>，逐项确认：

- 版本号显示 `0.1.0`，标签 **Public**（不是 Pro/private）；
- README 正常渲染（Quick start 代码块、表格都在）；
- 右侧 **Repository** 链接指向 GitHub 仓库（若还没 push，见 §7——push 后此链接才真正可点）；
- **Explore files** 里只有 `dist/`、`README.md` 与 `package.json`——`src/`、`tests/`、`docs/`、`examples/` 不在包里（`files` 白名单，D31）；
- `npm install @wangchengshi/pi-workflow` 在任意临时目录装得上、import 得动（附录 B 的冒烟命令）。

## 6. 后续版本迭代

日常修 bug / 加功能后：

```bash
npm version patch    # 0.1.0 → 0.1.1（修复）
npm version minor    # 0.1.0 → 0.2.0（向后兼容的新功能）
npm version major    # 0.1.0 → 1.0.0（破坏性变更）
```

`npm version` 会一次做完：改 `package.json` 的 `version` → `git commit` → 打 git tag（`v0.1.1` 等）。要求工作区干净。

然后推代码与标签并发布：

```bash
git push && git push --tags
npm publish --access public    # --access public 之后的版本仍建议带上，习惯成自然
```

> 版本语义参考：v0.x 阶段（当前） minor 可含行为变化；到 1.0.0 后按 semver 严格区分。设计文档的目标版本是 v0.1（M0–M5），见 docs/design.md §13。

## 7. GitHub 关联（repository 字段）

`package.json` 的 `repository` 字段当前是**假设 URL**：

```json
"repository": "https://github.com/wangchengshi/pi-workflow"
```

**push 前必须确认**：如果你的 GitHub 用户名不是 `wangchengshi`，先改 `package.json` 里的 URL 再推送（改了的话，下次 `npm publish` 才会同步到 npm 页面——npm 的 Repository 链接是发布时从 `repository` 字段渲染的）。

首次推送：

```bash
git remote add origin git@github.com:wangchengshi/pi-workflow.git
# HTTPS 方式：git remote add origin https://github.com/wangchengshi/pi-workflow.git
git push -u origin main --tags
```

推送完成后：

- GitHub 上出现仓库（记得在 GitHub 页面确认默认分支是 `main`）；
- npm 包页面的 **Repository** 链接生效，点击直达仓库；
- （可选）给 0.1.0 补一个 GitHub Release：标签 `v0.1.0` 已由 `npm version` / 首发时的 tag 打好（若首发没打 tag，可 `git tag v0.1.0 && git push --tags`）。

## 附录 A：prepublishOnly 链与 prepack 双保险

`package.json` 里两个与发布强相关的 script：

```json
"prepack": "npm run build",
"prepublishOnly": "npm run typecheck && npm run lint && npm test && npm run build"
```

- **`prepublishOnly`**：`npm publish` 时**自动**执行，顺序 typecheck → lint → test → build；任何一步非零退出，发布中止。这是"发布出去的东西一定是全绿构建出来的"的硬保证。
- **`prepack`**：`npm pack` 与 `npm publish` 打包前**自动**执行 `npm run build`，是双保险——即使绕过 prepublishOnly（比如只 `npm pack`），tarball 里的 `dist/` 也是刚构建的，不会把旧产物发出去。
- 两个钩子都不需要手动调用；日常本地验证直接跑 `npm run prepublishOnly` 即可等价体验发布链。

## 附录 B：npm pack 本地预览与安装冒烟

发布前想在不碰网络的情况下验收包内容：

```bash
npm pack
# 生成 wangchengshi-pi-workflow-0.1.0.tgz（自动触发 prepack → 重建 dist）
```

核对 tarball 结构（`dist/` 与 `README.md` 在，`src/`、`tests/`、`docs/`、`examples/` 不在）：

```bash
tar -tf wangchengshi-pi-workflow-0.1.0.tgz
```

临时目录安装冒烟（模拟真实消费者，离线可跑的 fnNode 图断言 state）：

```bash
mkdir /tmp/pi-workflow-smoke && cd /tmp/pi-workflow-smoke
npm init -y
npm install <仓库绝对路径>/wangchengshi-pi-workflow-0.1.0.tgz
node -e "import('@wangchengshi/pi-workflow').then(m => console.log(typeof m.StateGraph, typeof m.fnNode))"
# 预期输出：function function
node -e "import('@wangchengshi/pi-workflow/runtime').then(m => console.log(m.isPiAiAvailable, m.isPiSdkAvailable))"
# 预期输出：true true（在本仓库 devDependencies 装了对等包的环境里）或 false false（干净环境）——两者都是合法值，关键是 import 不抛
```
