<div align="center">

# dsh-breaklimit

为 DeepSeek Harness 管理宿主补丁、提示词和规则集的插件，提供中英文 Web 设置页。

[![版本](https://img.shields.io/github/v/tags/rumoii/dsh-breaklimit?label=%E7%89%88%E6%9C%AC&color=2a8f7b)](https://github.com/rumoii/dsh-breaklimit/releases)
[![下载量](https://img.shields.io/github/downloads/rumoii/dsh-breaklimit/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F&color=2a8f7b)](https://github.com/rumoii/dsh-breaklimit/releases)
[![Stars](https://img.shields.io/github/stars/rumoii/dsh-breaklimit?label=Stars&color=2a8f7b)](https://github.com/rumoii/dsh-breaklimit/stargazers)
[![许可证](https://img.shields.io/github/license/rumoii/dsh-breaklimit?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&color=2a8f7b)](LICENSE)
![Node](https://img.shields.io/badge/Node-22.19%20%C2%B7%2024-4b6b8a)

**[快速安装](#快速安装windows-powershell)** · [安装、升级与排错](docs/install.md) · [命令与 HTTP 接口](docs/reference.md) · [免责声明](DISCLAIMER.md) · [变更记录](CHANGELOG.md)

<p align="center">
  <a href="https://github.com/paralcor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/paralcor-horizontal-dark.png">
      <img alt="PARALCOR" src="docs/images/brand/paralcor-horizontal-light.png" width="120">
    </picture>
  </a>
  <br>
  <sub>DSH 破限由 @rumoii 开发维护，纳入帕拉珂 / PARALCOR 品牌展示。</sub>
</p>

</div>

当前版本 **0.9.5，内测版**。发布产物和验证边界见 [Releases](https://github.com/rumoii/dsh-breaklimit/releases)；正式版计划为 1.0.0。

## 亮点

- **补丁可控**：逐条选择，应用前检查文件哈希与命中数，失败时尝试事务回滚。
- **提示词可编辑**：提供 `recommended`（推荐）与 `unrestricted`（完全解放）两档，支持自定义正文。
- **规则可切换**：管理多份规则，激活到 `AGENTS.md` 或 `CLAUDE.md`，撤销时检查外部改动。
- **状态可检查**：Web 与宿主命令按磁盘补丁、进程预算、提示词装配、请求前处理和执行权限五层展示只读诊断，明确区分生效、未知与不适用。

## 适用环境

| 项目 | 要求 |
| --- | --- |
| 宿主 | 已能运行的 DeepSeek Harness **源码版** `0.2.1-rc.2` |
| 宿主提交 | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| Node.js | 与宿主一致：`^22.19.0 || >=24.0.0`，推荐 Node 24 |
| 工具 | Git、pnpm；pnpm 必须能从 PATH 调用 |
| 兼容性声明 | `engines.dsh: 0.2.1-rc.2`；DSH 版本不符时安装与启动会跳过本组合包 |
| 使用入口 | 本机 Web；桌面发行版和其他宿主版本尚未验收 |

**应用补丁会修改宿主源码树，需要重启宿主。** 独立 profile 隔离配置；使用同一源码树的其他 profile 也会读到源码补丁。版本或哈希不符时应先排查，不要直接重采哈希绕过阻断。

## 快速安装（Windows PowerShell）

面向已经能启动源码版 DSH 的用户。其他安装细节见 [安装说明](docs/install.md)。以下命令在**同一个 PowerShell 窗口**执行。

### 1. 获取插件并填写宿主路径

在你存放项目的目录执行：

```powershell
git clone --branch v0.9.5 --depth 1 https://github.com/rumoii/dsh-breaklimit.git
$PluginRoot = (Resolve-Path .\dsh-breaklimit).Path
$DshRoot = 'D:\host\deepseek-harness' # 改成你的宿主源码目录
$env:DSH_BREAKLIMIT_HOST_ROOT = $DshRoot

node --version
pnpm --version
git -C "$DshRoot" rev-parse HEAD
```

最后一条应输出上表中的宿主提交。宿主目录中应有 `apps/cli/src/bin.ts`；不同则先停止，确认安装形态与版本。

### 2. 准备独立的 Web profile

沿用启动 DSH 时使用的 `DSH_HOME`；未设置时，以下命令使用用户目录下的 `.dsh`。只在 profile 不存在时创建 Web 模板，已有 profile 不会被覆盖。已有 profile 的 `dsh.profile.bundles` 必须包含 `@deepseek-ai/dsh-web-app`。

<details>
<summary>展开：新建 Web profile 的完整命令（已有 profile 可跳过）</summary>

```powershell
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }
$ProfileManifest = Join-Path $env:DSH_HOME 'profiles\web-breaklimit\package.json'
Set-Location "$DshRoot"
if (-not (Test-Path -LiteralPath $ProfileManifest)) {
    node --import tsx/esm apps/cli/src/bin.ts --profile web-breaklimit --from-default-profile web --dump-default-config
    if ($LASTEXITCODE -ne 0) { throw '创建 Web profile 失败，请停止安装并检查输出。' }
}
```

</details>

设置页缺失时先看 [对应排查步骤](docs/install.md#常见问题)。

### 3. 安装、预检与应用

仍在宿主目录安装，再进入插件目录操作补丁：

```powershell
Set-Location "$DshRoot"
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web-breaklimit add "$PluginRoot"
if ($LASTEXITCODE -ne 0) { throw '插件安装失败，请停止并检查输出。' }

Set-Location "$PluginRoot"
node src/cli.js --doctor
```

`--doctor` 只读，逐项检查 Node、pnpm、git、宿主根、宿主依赖、数据目录、Web 组合与插件注册。到这一步八项都应通过；有失败项时按它给出的指引处理，再继续。

```powershell
node src/cli.js --host-root "$DshRoot" --status
```

预检显示“通过”且没有阻断项后，执行：

```powershell
node src/cli.js --host-root "$DshRoot" --apply
```

预检失败时整批不写入。应用失败时保留报错及 `$DSH_HOME/breaklimit/`，按 [故障恢复](docs/install.md#回退与卸载) 处理。

### 4. 启动并确认

如果这个 profile 正在运行，先按原来的方式将它停止。随后在同一个窗口启动：

```powershell
Set-Location "$DshRoot"
node --import tsx/esm apps/cli/src/bin.ts --profile web-breaklimit --port 3082
```

打开终端打印的登录链接，在会话中输入 `/breaklimit status`。确认：

- 设置页有“破限”入口，英文界面显示对应英文名称。
- 宿主根是你填写的目录，补丁预检为 `ok`。
- `HTTP 接口` 显示“已挂载”。

“待写入 0 个文件”只说明当前补丁目标已满足；它本身不能证明宿主已经重启。

## 第一次使用

1. 在“概览”确认推荐方案并检查应用；需要逐条调整时进入“自定义补丁”。开关只影响后续预检与应用，不撤销已应用的文件改动，回退位于独立的“恢复与维护”区域。
2. 在“提示词”中选择模式或编辑正文。`recommended` 为默认，保存后写入 `$DSH_HOME/breaklimit-inject.md`。
3. 在“规则”中填写规则 ID、写入文件和正文，保存后再激活。撤销时恢复原文件或删除插件创建的文件；外部修改会被保留并报告。
4. 在“词库”中维护目标词替换表，保存后新开会话生效；输入框旁的浮窗可以快速添加，或直接进入词库页。
5. 用 `/breaklimit off` 暂停本次实例的运行时接管；恢复用 `/breaklimit on`。这两个命令不撤销源码补丁。
6. 点设置面板顶栏的版本徽章打开「版本与更新」：手动检查更新、忽略某个版本、开关「每天自动检查一次」（缺省开启，每天至多一次）。有新版时顶栏和浮窗给出可见提示，链接到 GitHub Releases。

提示词模式控制文本装配，宿主的沙箱模式控制实际执行边界，两者不是同一个开关。

## 界面预览

| 概览与安装检查 | 补丁选择与技术细节 |
| --- | --- |
| ![概览](docs/images/overview.png) | ![补丁](docs/images/patches.png) |

[查看英文补丁页](docs/images/patches-en.png)。截图取自 Windows 上真实运行的宿主（DSH 0.2.1-rc.2 · 687f282e，补丁已全部应用），读数由插件后端实时读取；它们只说明界面与状态显示的样子，不代表模型推理或全部沙箱场景已通过验收。

## 回退与卸载

在插件目录撤销宿主源码补丁：

```powershell
node src/cli.js --host-root "$DshRoot" --revert
```

成功后重启宿主。需要移除插件时，再从宿主目录执行：

```powershell
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web-breaklimit remove rumo-dsh-breaklimit
```

不要提前删除插件目录或恢复快照。移除依赖不会自动撤销源码补丁，也不会清除用户规则和注入文件。规则写入文件的恢复方式见 [回退与卸载](docs/install.md#回退与卸载)。

## 联网与隐私

插件在本机运行，不收集遥测，不上传任何用户数据——提示词正文、规则、目标词表、宿主路径都只留在本地磁盘。

唯一的对外请求是检查更新：

- 目标是 `https://api.github.com/repos/rumoii/dsh-breaklimit/releases?per_page=10`（本插件的发布列表），读取后按版本号比较。
- 频率：每天最多一次，触发点是打开设置面板或展开会话浮窗，同一进程内的两个入口共用一次请求。
- 请求头只带插件版本号（`User-Agent: rumo-dsh-breaklimit/<版本>`）；不携带任何本地路径、凭据、词库或规则内容，也不带 Cookie。
- GitHub 能看到这次请求的来源 IP 地址。
- 可以在「版本与更新」弹窗里关闭每天自动检查；关闭后手动检查仍然可用。
- 开关与检查结果保存在 `$DSH_HOME/breaklimit/update.json`；自动检查失败当天不重试，保留上次结果。

网络需要代理时，检查更新会依次读取 `HTTPS_PROXY`（或 `ALL_PROXY`、`HTTP_PROXY`）环境变量、以及 `git config --get http.proxy` 的值。代理只支持 `http://`（CONNECT 隧道），`https://` 代理会被拒绝并提示。宿主支持在 `$DSH_HOME/.env` 里设置 `HTTPS_PROXY`，写在那里能让插件读到。


## 文档与开发

- [安装、升级、回退与常见问题](docs/install.md)
- [命令与 HTTP 接口](docs/reference.md)
- [模块结构与设计约束](DESIGN.md)
- [自检与验收](docs/verify.md)
- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [发布检查清单](docs/releasing.md)

```powershell
npm run check
npm run reconcile -- '<宿主源码树绝对路径>'
npm run check:host -- '<宿主源码树绝对路径>'
```

最后两条读取宿主 HEAD；夹具预检不修改宿主工作树，也不能替代实际安装和浏览器验收。

仓库名是 `dsh-breaklimit`，包名和插件标识是 `rumo-dsh-breaklimit`。安装使用目录路径，卸载使用包名。

## 免责声明

使用本项目即视为接受[免责声明](DISCLAIMER.md)的全部条款，要点如下：

- 非营利开源项目，仅供学习与研究使用；不得用于违法违规用途，违者自行承担全部法律后果。
- 与 DeepSeek 及 DeepSeek Harness 的开发、运营方无任何关联、授权或背书。
- 补丁、提示词与规则的写入和恢复只发生在本机宿主源码树与 `$DSH_HOME`，不作用于任何外部系统；唯一的对外访问是可关闭的检测更新，只读取本插件自己的 GitHub 发布信息。严禁对未授权目标使用，严禁对中国大陆、香港、澳门的网络目标做任何操作。
- 软件按现状提供、不附担保；修改宿主源码的风险由使用者自行评估并承担。
- 违反条款的，使用许可自动终止。

## 许可证

[MIT](LICENSE)
