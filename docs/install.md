# 安装、升级、回退与常见问题

## 安装前确认

本指南面向已经能运行 DeepSeek Harness 源码版的用户。插件绑定 `0.2.1-rc.2`、提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，Node 要求 `^22.19.0 || >=24.0.0`。宿主源码树的依赖和运行环境应已准备好。

安装会涉及三处：

| 位置 | 改动 |
| --- | --- |
| `$DSH_HOME/profiles/web-breaklimit/` | 宿主管理的插件依赖、bundles 与 profile 配置 |
| `$DSH_HOME/breaklimit/` | 插件状态、事务快照、规则与模式 |
| 指定的宿主源码树 | 通过预检后才写入的补丁 |

用户注入文本默认为 `$DSH_HOME/breaklimit-inject.md`。激活规则还会写 `$DSH_HOME/AGENTS.md` 或 `CLAUDE.md`；激活前的原内容由规则状态保存。

独立 profile 隔离配置，不隔离共享源码。不要同时用不同的 `DSH_HOME` 对同一宿主应用补丁：跨进程锁和恢复记录位于数据目录，两份数据目录不会共享它们。

## 推荐安装流程

完整 PowerShell 命令见 [README 快速安装](../README.md#快速安装windows-powershell)。保持以下顺序：

1. 获取插件，填写 `$PluginRoot`、`$DshRoot`；可用 `node src/cli.js --doctor` 就地检查 Node、pnpm、git 与宿主提交。
2. 沿用日常启动器使用的 `DSH_HOME`，并设置 `DSH_BREAKLIMIT_HOST_ROOT`。环境变量必须由执行 CLI 和启动宿主的进程共同继承。
3. 创建独立 Web profile，再由 `dsh plugin` 安装本地插件。
4. 在插件目录运行 `--status`，确认预检通过后执行 `--apply`。
5. 停止原 profile 的宿主进程，启动同一 profile，打开终端打印的登录链接。
6. 查看 `/breaklimit status` 和设置页，再开始使用。

已在 PATH 中配置 `dsh` 时，可以用它替换 `node --import tsx/esm apps/cli/src/bin.ts`；后者必须在宿主根执行。不要用 `pnpm dsh plugin ...` 代替，pnpm 可能先消费宿主参数。

### 为什么要先准备 Web profile

宿主会按名字识别内置模板。自定义名称 `web-breaklimit` 直接通过插件命令初始化时，默认只有 base，缺少 Web 组合。

对**尚不存在**的 profile，在宿主根执行：

```powershell
node --import tsx/esm apps/cli/src/bin.ts --profile web-breaklimit --from-default-profile web --dump-default-config
```

成功后，profile 的 `package.json` 中应同时有 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`。`--from-default-profile` 会替换指定的自定义 profile，只用于首次创建；已有 profile 应检查和补齐其配置，不要重复执行该命令。

安装插件用宿主命令，避免手工创建 junction 或编辑依赖：

```powershell
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web-breaklimit add "$PluginRoot"
```

成功后 bundles 应包含 `rumo-dsh-breaklimit`，依赖应指向你的插件目录。不要移动或删除该目录，否则本地链接会失效。

### 宿主根怎么传

独立 CLI 推荐始终显式传参：

```powershell
node src/cli.js --host-root "$DshRoot" --status
```

插件进程读取 `hostRoot` 配置，其次读取 `DSH_BREAKLIMIT_HOST_ROOT`，最后从宿主进程入口向上查找三个宿主标记路径。独立 CLI 不做进程入口推导；它依次读取 `--host-root`、环境变量、profile 装配文件、本包装配文件。

只在一个终端里设置变量不会改变另一个已经运行的宿主。使用 Desktop、服务或自定义启动脚本时，要检查启动器真正传入的环境；这些安装形态尚未完成本项目验收。

## 升级

### 只升级插件

先查看 [变更记录](../CHANGELOG.md) 和待升级版本的宿主兼容声明。保存自己的修改，再更新插件源码；按发布说明决定是否需要回退并重新应用补丁。重新安装依赖和重启前，核对 profile 仍指向正确目录。

不要对有本地修改的目录直接覆盖文件，也不要为升级删除事务快照。

### 升级宿主

宿主版本绑定是刻意的保护：旧补丁不能因为“原文大致相同”就继续应用。先在原版本回退，再在隔离副本中适配新版本。

维护者需要检查目标路径、原文、命中数和预期行为，更新版本声明，再运行 `tools/collect-hashes.mjs` 从目标 HEAD 采集哈希，最后执行对账、夹具与真实安装验收。这个命令会重写仓库清单，不是用户遇到冲突时的通用修复。

## 回退与卸载

1. 停止正在使用该 profile 的会话操作。
2. 若要恢复规则写入文件，先在设置页取消激活，或执行 `/breaklimit-rules deactivate`；检查是否报告外部修改被保留。
3. 在插件目录执行 `node src/cli.js --host-root "$DshRoot" --revert`。
4. 成功后，从宿主根执行 `node --import tsx/esm apps/cli/src/bin.ts plugin --profile web-breaklimit remove rumo-dsh-breaklimit`。
5. 重启宿主，再确认插件已从该 profile 移除。

回退依据已保存的事务，当前补丁开关不会缩小恢复范围。任一目标发生外部漂移时，整批回退拒绝；保留快照和报错，核对差异后人工决定下一步，不要直接覆盖目标文件。

### 应用记录丢失后重建

`$DSH_HOME/breaklimit/` 被删掉时，宿主上已经应用的改动还在，而应用和回退两头都不认它：预检把每个目标报成「整文件预哈希不符」，回退则报没有应用记录。确认宿主内容就是本插件写入的那一版之后，可以从宿主的 git HEAD 重建记录：

```powershell
node tools/rebuild-state.mjs "$DshRoot"
```

它只采纳同时满足三条的文件：HEAD 这份原文被声明的预哈希承认、把当前内容按声明还原后逐字节等于该原文、当前内容与该原文确实不同。宿主上还有别处改动、或哈希表不是给这棵树采的，都会被拒绝并列出理由。写入只发生在 `$DSH_HOME/breaklimit/` 下：新增一份合并快照目录与一份新记录，旧记录备份为 `state.json.bak`，宿主源码一个字节都不改。重建不替代回退，也不能替外部改动背书。

卸载保留规则、自定义提示词与快照。需要清理数据时，先确认规则写入文件已按预期恢复，再自行处理相应文件。移除插件本身不等于取消激活，也不等于撤销源码补丁。

## 常见问题

| 现象 | 先检查 | 下一步 |
| --- | --- | --- |
| 环境不确定或启动报错 | 运行 `node src/cli.js --doctor` | 逐项核对 Node、pnpm、git、宿主根、宿主依赖、DSH 数据目录、Web 组合与插件注册状态 |
| `pnpm not found` | 同一终端运行 `pnpm --version` | 按宿主安装要求配置 pnpm，确认 PATH 后重新安装插件 |
| 找不到 `tsx` 或宿主包 | 是否在宿主根，源码版是否已安装依赖 | 先恢复宿主原本能运行的环境，不在插件目录安装宿主依赖 |
| 设置页没有入口 | profile 是否含 `@deepseek-ai/dsh-web-app` 和本插件 | 停止该 profile，保留现有字段，补齐缺少的 Web bundle 后重启 |
| `host_root_unconfigured` | 宿主进程是否继承变量 | 通过同一终端启动，或填写插件 `hostRoot`；CLI 使用显式参数 |
| 预哈希不符 | 宿主 HEAD、`git status --short`、插件恢复记录 | 确认升级或外部修改来源，不要直接重采哈希；若内容确是本插件写入而记录已丢失，见[应用记录丢失后重建](#应用记录丢失后重建) |
| `state_corrupt` | 数据目录中恢复记录是否损坏 | 保留整个 `breaklimit/` 及报错，停止继续应用和回退 |
| `operation_in_progress` | 是否有另一进程正在应用或回退 | 等原操作结束；不要手工删活动锁 |
| 回退报告漂移 | 目标是否被其他工具改动 | 保留目标与快照，人工核对差异 |
| 端口被占用 | 是否仍有该 profile 实例或其他服务 | 停止自己启动的旧实例，或换空闲端口 |
| 模式或接缝不符 | 实际沙箱档位、接管开关、权限告警 | 检查 profile 和 home 的后置配置覆盖 |
| 检查更新提示连不上 GitHub | 网络是否需要代理 | 设置 `HTTPS_PROXY`（可写在 `$DSH_HOME/.env`）或 `git config --get http.proxy`；自动检查当天失败不重试，可手动检查 |

profile 和 home 的 `cordis.patch.yml` 位于 bundle 之后，同名配置可能整体覆盖插件声明。`/breaklimit status` 展示解析后的权限现值；`approval: never` 会让审批在插件接缝之前被拒绝。

宿主启动失败时先看具体错误。bundle 解析失败通常应修正 profile 的链接和依赖；源码错误可能需要回退。不要停止全部 Node 进程，避免中断其他 profile 或项目。

## 其他系统

独立 CLI 使用 Node 内置模块；仓库 CI 覆盖 Windows 和 Ubuntu 的测试，实际宿主安装支持以 [验收记录](verify.md) 为准。其他系统可以沿用相同步骤，使用对应 shell 的绝对路径与环境变量语法；未验收的平台不作安装成功承诺。
