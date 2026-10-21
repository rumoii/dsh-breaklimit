# 结构与设计约束

插件绑定 DeepSeek Harness `0.2.1-rc.2`，提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。目标版本、补丁声明与预哈希清单必须通过对账；源码升级需要单独适配。

## 模块边界

| 模块 | 职责 | 依赖方向 |
| --- | --- | --- |
| `src/plugin.js` | 创建实例状态、登记能力 | 下面全部 |
| `src/patch/` | 补丁声明、预哈希、预检、事务、锁、选择、共用服务 | Node 内置模块 |
| `src/context/` | 共用正文、两档附加段、尾部摘要、模式、规则、自定义提示词读取 | `patch` |
| `src/host/` | 接缝、宿主根、执行层预算、状态、命令与工具、诊断、预检工具 | `context`、`patch` |
| `src/serve/` | HTTP 解析、路由与响应 | `host`、`context`、`patch` |
| `src/cli.js` | 独立命令行 | 各域 |
| `src/client.js` | 宿主设置页（宿主强制单文件） | React、宿主 slots、HTTP |
| `src/bundle.yml` | 装配补丁 | 不调用运行时 |

依赖方向单向：`serve → host → context → patch`。反向导入一律不许。

## 提示词装配

头部 = `inject.md`（用户可覆盖）+ 该模式的 `recommended.md` / `unrestricted.md` + 激活中的规则，折进宿主 `deployment:persona-prefix` 段；尾部 = `tail.md`，独占一段，序号由 `config.order` 决定：缺省 **8999**，装机配置里设 **10300**。宿主第一方段的顺序是结构化输出 9900、harness 源码 10000、Web 表层 10100、`deployment:persona-suffix` 10200，所以 8999 落在它们之前、10300 落在全部原生段之后。组合里没有 persona 前缀段时补一个 `breaklimit:head` 兜底，声明序号 1；落点不靠序号决定——宿主排序发生在装配瀑布之前，之后不再排序，所以兜底段按数组下标插到首位。

两档：`recommended`（推荐，默认）与 `unrestricted`（完全解放）。旧值 `lean` / `architect` / `autonomous` 判非法并回退默认，不迁移。

## 规则存储

一条规则同时是「一份正文」和「一个插进用户文件的落点」。这两件事失败的方式不同，所以分开存：

- `rules.json` 是索引：规则表、当前激活项、落点归属、`revision`。写入按 `revision` 比较并交换，两个进程同时改时后到的那个因版本不符失败重来，而不是覆盖对方刚写下的条目。
- `bodies/<id>.md` 存正文。与索引分开，是为了让「正文很大」和「索引频繁改」互不牵连：切激活状态不重写正文，改正文不碰索引。
- `landings/<target>.txt` 存**第一次接管该落点时的原文**。用户在该文件上做过插件之外的修改时，撤销不能把当前内容当成自己的写回，于是保留归属、报 `skipped`，把处置权交回用户；被外部改过的那份内容不会被新激活覆盖掉原文快照。
- 落点处置是三态（`removed` / `restored` / `skipped`）而不是布尔。「撤销时文件已不是我们写的样子」既不是成功也不是失败：成功要求清空记录，失败要求保留记录，而它要求保留记录并把事实报出来。
- 所有写入走同一个跨进程文件锁。它不是性能优化：宿主命令、HTTP 路由与模型工具会同时到达，而 `rules.json` 的读—改—写不是原子的。
- 激活分两步落盘：先把意图（`pendingActivation`）写进索引，再写落点，最后提交。任何一步失败都回到「落点没被改写」的状态，索引里留下可诊断的痕迹。

对应的失败场景各有测试，见 [自检与验收](docs/verify.md) 的规则恢复链、落点快照所有权、并发锁三项。

### 放在哪，保证什么

| 位置 | 内容 |
| --- | --- |
| `$DSH_HOME/breaklimit/rules.json` | 索引：规则表、激活项、落点归属、`revision` |
| `$DSH_HOME/breaklimit/bodies/<id>.md` | 规则正文 |
| `$DSH_HOME/breaklimit/landings/<target>.txt` | 接管前的原文，只在原文件本来有内容时存在 |
| `$DSH_HOME/AGENTS.md`、`CLAUDE.md` | 落点：插件写入正文的地方 |

插件的任何状态都在 `breaklimit/` 目录内，落点旁边不放副产物；删掉这个目录，剩下的就是宿主原本的文件。

保证：

- **处置只依据激活那一刻的记录**，不依据当前元数据。`created` 为真就删掉落点，为假就写回 `landings/` 里那份原文。
- **外部改动不覆盖**。落点被插件之外改过时既不写回也不删除，返回 `skipped`。每条跳过记录带原因和两侧指纹：`expected` 是插件认为该文件应当有的内容，`actual` 是它现在的内容（sha256 前 16 位）；两侧不一致就是内容被换过。用户据此判断是不是自己改的，不需要插件替他决定。
- **失败不吞**。`atomicWrite` 失败沿调用链返回结构化失败，`skipped` 里如实记下原因，不改成「已完成」。
- **写入是原子的**。临时文件与目标同目录，改名不跨设备；一次写入要么完整落盘，要么完全不存在。

## 补丁与运行时能力

补丁引擎处理与版本绑定的文件修改；运行时能力处理当前进程内的可变量。二者不重叠：补丁写宿主源码，切模式需要回退后重新应用并重启；运行时能力走 Loader 的 volatile 提交，立即生效。

只有 `danger-full-access` 档接管审批与工具门。其他档位不放宽沙箱；沙箱升级请求被拒绝，普通审批交还宿主。提示词模式控制文本内容，不改变沙箱档位。

## 设置页前端

`src/client.js` 保持宿主要求的单文件交付：`window.__ModuleLoader__.load` 注册，元素全部 `React.createElement`，颜色与字体只取宿主 `--dsw-*` 令牌。设置分区五个页签（概览、补丁、提示词、规则、词库）加会话输入框旁的浮窗，两个挂载点共用模块级 `aliasStore`：

- 词库写入是「操作」而不是「整表提交」——前端按增/改/删描述意图，执行时基于最新列表算出整表再 `PUT /breaklimit/alias`（后端是整表覆盖）。写入串行，过期读取响应按版本号作废，两处挂载点不会拿旧列表互相覆盖；写成功以响应里的规范化列表为准，并通知另一处刷新。
- `GET /breaklimit/alias` 的读取告警随 HTTP 200、`code: "ok"` 放在 `message` 里；前端把它当读取失败处理：保留旧数据并标旧，暂停写入与预览，不当成空词库。保存失败保留草稿；超时/断网只报「结果未知」并重新读取核对，不宣布改动未生效。
- 本地预览复用 `src/host/masks.js` 的替换语义（区分大小写、精确字面、长词优先、按顺序依次替换），与后端逐例一致；它只是预览，不是真实会话命中记录。
- 确认与词条编辑用原生 `<dialog>` 弹窗：Esc 取消、焦点进入与返回、正文滚动时按钮保持可达。
- 浮窗的「管理词库」要直达设置分区的词库页。宿主没有对插件开放「打开设置面板并定位到某个分区」的公开接口（`SettingsOnboardingOwnerProps.openSection` 只面向 onboarding 步骤）；当前从 slots 注册表 `sidebar.settings` 的 store 座位调用 `openSection("breaklimit")`，失败或宿主换壳时退回一句指引，待落地页签由分区挂载时消费。宿主将来提供公开接口后，替换 `openHostSettingsSection` 即可。

## 必须保持的约束

- **预检零写入**：目标缺失、整文件哈希失配或命中数异常时整批停止。哈希清单缺失也阻断。
- **可重复应用**：先识别事务记录中的应用后内容；不靠子串包含判定。
- **恢复有依据**：写源码前保存快照与事务记录；写入失败尝试回滚，回滚失败保留恢复记录与原始错误。
- **漂移不覆盖**：回退前对账整批文件，外部改动导致整体拒绝；当前补丁开关不改变既有事务的恢复范围。
- **两层互斥**：实例内锁与基于同一 `DSH_HOME` 的跨进程锁共同保护应用与回退。
- **规则保留所有权**：激活前把写入文件的原文存进独立文件并记哈希；撤销时未变则恢复或删除，变了则保留并报告。
- **执行层预算只提交 config**：`loader.resolve(id).update({ config })` 只在 volatile-only 时原地生效；条件不成立会重挂载并打断子代理，因此提交只带必要键、失败只记录不重试。
- **请求体上限随载荷走**：HTTP 请求体上限由规则正文与注入正文上限推导（6 倍 JSON 转义余量），不设不随载荷变化的固定封顶；两个正文上限本身不因此放宽。
- **配置可追踪**：状态报告宿主根来源、模式、执行层预算现值与偏差，不依据配置宣称已生效。

## 与 DSH 插件规范的偏差

宿主没有一份叫「插件开发规范」的单文档，可判定的硬要求集中在 `docs/user/develop/basic/`（`Config` 是 Standard Schema、组合包声明 `engines.dsh`、客户端半侧为 lazy-CJS）与 `docs/capability-seams.zh.md`（可用的服务清单）。

已对齐：`engines.dsh: 0.2.1-rc.2` 由宿主在安装与启动时判定；`src/plugin-config.js` 导出 Standard Schema 形式的 `Config`，装载前校验并补默认值；浏览器半侧经 `dsh.client` 声明、按 lazy-CJS 注册；`ctx.systemPrompt`、`ctx.sandboxPolicy`、`ctx.webServer`、`ctx.tools`、`ctx.commands` 都在公开服务清单内。

仍偏离三处，都是有意的：

| 偏离 | 位置 | 理由 |
| --- | --- | --- |
| 改宿主源码树 | `src/patch/`、`src/host/seams.js` | 规范只提供 Cordis 接缝与 bundle patch 改配置两条通道，改 `packages/**` 不在插件模型内。这是本插件的功能本体，靠预哈希、命中数守卫与事务回滚约束，README 已写明绑定宿主提交、需要重启。 |
| 读写 Loader 条目 config | `src/host/capabilities.js` 的 `updateEntry` | `ctx.loader` 是 vendor 服务，不在插件文档的服务清单里；执行层预算没有公开写入通道。条件不成立时退回 `src/bundle.yml` 的装载期基线，失败记入状态不重试。 |
| 浏览器侧取设置面板的 store 座位 | `src/client.js` 的 `openHostSettingsSection` | 宿主未开放「打开设置分区」接口（`SettingsOnboardingOwnerProps.openSection` 只面向 onboarding）。当前从 slots 注册表读 `sidebar.settings` 的座位调用 `openSection`，失败退回一句文字指引；宿主提供公开接口后替换此函数即可。 |
| `--dump-config-schema` 不认手写 schema | `src/plugin-config.js` | 宿主的 schema 投影只接受带 `Symbol.for('schemastery')` 标记的原生 schema，本行会记为 `unsupported` 并使该命令退出 1。`--dump-config` 与真实装载不受影响。换成 Schemastery 要新增依赖与安装步骤，与零依赖安装冲突，因此接受这个诊断代价。 |

## 数据与兼容

恢复记录、快照、规则、模式、补丁选择位于 `$DSH_HOME/breaklimit/`。自定义提示词默认为 `$DSH_HOME/breaklimit-inject.md`，可由 `injectFile` 配置覆盖。规则写入文件为 `$DSH_HOME/AGENTS.md` 或 `CLAUDE.md`。

事务格式版本不匹配必须停止恢复；偏好格式异常退回默认并报告。模块搬迁不改变持久格式、HTTP 路径、响应外壳或包导出。

宿主根的插件解析顺序是配置、环境变量、宿主进程入口推导。CLI 的解析顺序是显式参数、环境变量、profile 装配文件、本包装配文件。

## 证据边界

仓库测试覆盖引擎、入口契约与纯函数诊断；固定版本夹具覆盖补丁与宿主 HEAD 的对齐；实际装载、浏览器交互与各沙箱档位需要单独验收。步骤与当前记录见 [自检与验收](docs/verify.md)，历史部署记录见 [重构前验收](docs/acceptance-history.md)。
