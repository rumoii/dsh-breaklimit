# 命令与 HTTP 接口

## 宿主内命令

| 命令 | 用途 |
| --- | --- |
| `/breaklimit`、`/breaklimit status` | 查看状态与预检结果 |
| `/breaklimit apply` | 应用当前选择的补丁 |
| `/breaklimit revert` | 回退已记录的宿主文件改动 |
| `/breaklimit tier [recommended\|unrestricted]` | 查看或切换提示词模式；缺省为 `recommended` |
| `/breaklimit on`、`/breaklimit off` | 开启或关闭本次插件实例的运行时接管；不撤销已应用补丁 |
| `/breaklimit doctor` | 一条命令报告模式、执行层预算与补丁状态是否一致 |
| `/breaklimit upgrade` | 逐条核对补丁声明里的原文是否还在宿主里，失配时给出定位 |
| `/breaklimit diff` | 当前提示词正文与内置正文的差异 |
| `/breaklimit import <路径>` | 把一份 AGENTS.md 导入成规则（不自动激活） |
| `/breaklimit-rules`、`/breaklimit-rules list`、`/breaklimit-rules status` | 列出规则及激活状态 |
| `/breaklimit-rules read <id>` | 读取规则 |
| `/breaklimit-rules activate <id>` | 激活规则 |
| `/breaklimit-rules deactivate` | 取消激活 |
| `/breaklimit-rules delete <id>` | 删除指定规则 |
| `/breaklimit-rules reset` | 清空规则并取消激活 |

规则可在 Web 设置页创建、编辑和切换。

## 模型工具

| 工具 | 用途 |
| --- | --- |
| `breaklimit_status` | 查询状态、宿主根和补丁预检 |
| `breaklimit_apply` | 预检并应用补丁 |
| `breaklimit_revert` | 检查漂移并回退补丁 |
| `breaklimit_guard` | 只读预检一个路径：文件数、总字节、是否在工作区内、是否 git 仓库、未提交项数 |

## 独立 CLI

可直接使用 `node src/cli.js`；已由包管理器链接命令时，也可使用 `breaklimit`：

```text
breaklimit --status
breaklimit --apply
breaklimit --revert
breaklimit --tier [recommended|unrestricted]
breaklimit --edit
breaklimit --rules
breaklimit --host-root <路径> --status
breaklimit --help
```

`--edit` 打开自定义提示词文件，`--rules` 列出规则。`--host-root` 可与需要宿主根的动作组合使用；无动作参数时显示帮助。CLI 与宿主接口共用补丁引擎，但各进程的宿主根和 `DSH_HOME` 配置须保持一致。诊断用宿主内的 `/breaklimit doctor`；独立 CLI 没有对应开关。

## HTTP 接口

接口挂载在宿主已有 Web 服务的 `/breaklimit` 前缀下，不另开监听端口。路由清单如下：

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| GET | `/breaklimit/status` | 状态与预检结果；`GET /breaklimit` 同样返回状态 |
| GET | `/breaklimit/patches` | 补丁清单与选择状态 |
| POST | `/breaklimit/patches/enabled` | 设置单条补丁开关，请求字段为 `id`、`enabled` |
| POST | `/breaklimit/apply` | 应用当前选择的补丁 |
| POST | `/breaklimit/revert` | 回退宿主文件改动 |
| GET | `/breaklimit/override` | 读取当前注入文本及文件状态 |
| POST | `/breaklimit/override` | 保存用户注入文本，请求字段为 `text` |
| GET | `/breaklimit/tier` | 查看模式 |
| POST | `/breaklimit/tier` | 切换模式，请求字段为 `tier` |
| POST | `/breaklimit/enabled` | 切换运行时接管，请求字段为 `enabled` |
| POST | `/breaklimit/restart` | 返回手动重启命令，不自行重启宿主 |
| GET | `/breaklimit/alias` | 读取目标词表、上限与最近一次命中 |
| PUT | `/breaklimit/alias` | 整表覆盖写词表，请求字段为 `entries`，每项含 `from`、`to` |
| GET | `/breaklimit/rules/status` | 规则列表及激活状态 |
| GET | `/breaklimit/rules/read?id=<id>` | 读取指定规则 |
| POST | `/breaklimit/rules/save` | 保存规则，JSON 包含 `id`、`text`，可带 `name`、`target` |
| POST | `/breaklimit/rules/activate` | 按 `id` 激活规则；空对象或空 `id` 取消激活 |
| POST | `/breaklimit/rules/delete` | 删除规则，请求字段为 `id` |
| POST | `/breaklimit/rules/reset` | 清空规则并取消激活 |
| POST | `/breaklimit/rules/recover-corrupt` | 规则清单损坏时备份并重置为空清单，返回备份路径与字节数 |
| GET | `/breaklimit/update` | 读取更新状态与已装版本（含状态文件是否损坏 `updateState`），纯本地不联网 |
| GET | `/breaklimit/update/auto` | 自动检查更新：每天至多一次，失败不报错，结果带 `lastError` |
| POST | `/breaklimit/update/check` | 手动检查更新，总是访问 GitHub 发布列表 |
| POST | `/breaklimit/update/auto-check` | 开关每日自动检查，请求字段为 `enabled` |
| POST | `/breaklimit/update/dismiss` | 忽略指定版本，请求字段为 `version`（接受 `v` 前缀，落盘归一为 `x.y.z`） |

规则落点为 `$DSH_HOME/AGENTS.md` 或 `CLAUDE.md`，读写按原字节：内容不变不重写，非 UTF-8 的旧文件不自动收拢、原样保留。激活会把新正文写进落点；落点上的内容被插件之外改过时，被覆盖的字节先存副本 `landings/<target>.external-<时间戳>-*.txt`，路径在响应 `data.externalCopy` 里报出，副本写不出来则取消激活。落点或规则清单存在但读不到时，操作直接失败（`landing_unreadable` / `index_unreadable`），不按“文件不存在”处理。

`GET /breaklimit/rules/status` 的 `data.pendingActivation` 是中断留下的未提交激活意图，字段为 `id`、`target`、`created`、`snapshot`、`previous`、`startedAt`；没有未完成激活时为 `null`。

`GET /breaklimit/status` 的 `data` 里，`mode` 是审批与工具门实际使用的档位（`sandboxPolicy` 的解析结果，读不到时按 `read-only` 处理）；`sandbox` 说明这个档位是不是真的读到了，字段为 `{ available, mode, error }`。`available` 为 false 表示服务缺失或解析抛错，`error` 给出原因；此时状态文本多一行「档位来源 不可判定」，避免把「真的只读」和「读不到档位」显示成同一个值。

写请求须带 `Origin`，其 URL 的 host（含端口）须与请求头 `Host` 一致；读请求可省略 `Origin`，携带时也执行此校验。不满足校验的请求返回 403。写接口使用 JSON 请求体；响应字段为 `ok`、`code`、`message` 和可选的 `data`。操作并发或文件漂移返回 409；预检阻断和输入非法通常返回 400；写入或记录损坏等内部失败返回 500。请求体超过上限返回 413 `too_large`：上限按所承载载荷（规则正文与注入正文）的 6 倍 JSON 转义余量推导，不设固定封顶，所以正文上限调大后请求体上限跟着涨；正文本身超限不走 413：`POST /breaklimit/rules/save` 回 400 `rule_invalid`、`POST /breaklimit/override` 回 400 `too_large`，与请求体超限不是同一件事。检查更新失败返回 502：`code` 为 `update_unreachable`（连不上、超时、非 2xx、限流或代理失败）或 `update_invalid`（响应不是 JSON 或没有合法版本标签）。

HTTP 响应里的绝对路径一律脱敏：盘符、用户目录与中间层级不出现，路径只折成 `…/<最后一段>`。唯一例外是 `POST /breaklimit/restart` 回传的 `data.command`：它必须是可直接粘贴执行的重启命令，真实绝对路径才有意义；该接口同样在 Host 栅栏与同源校验之内，只有本机放行的来源读得到它。

未提供 `webServer` 服务的宿主组合不会挂载这些路由，状态中显示 `http.mounted: false`。Web 设置页的可用性取决于宿主加载的客户端与服务组合。

目标词表存在 `$DSH_HOME/breaklimit/masks.json`：最多 100 条，每条 `from` 与 `to` 各不超过 64 字符，`from` 等于 `to` 的条目被丢弃。替换只在请求交付给模型之前作用于用户消息，精确字面匹配、长词优先；词表为空时不做任何替换。改完词表需要新开会话才生效。

`GET /breaklimit/alias` 读取词表文件失败时仍返回 HTTP 200、`code: "ok"`，告警放在 `message` 里（此时 `data.entries` 不可信，可能是空表）；调用方必须识别 `message` 非空的读取告警，不能只凭状态码判断读取正常。`PUT /breaklimit/alias` 是整表覆盖，不是单条增删接口。

更新状态存在 `$DSH_HOME/breaklimit/update.json`：包含每日自动检查开关、上次检查日期、最新版本、发布链接与忽略版本等字段，合并写入；文件缺失或字段类型不对时按空状态处理，不影响其他功能。发现损坏时，下次写入前先把原文件备份到 `$DSH_HOME/dsh-breaklimit-backup/<时间戳>/update.json` 再重建，备份失败则拒绝写入，原文件保持不变。代理只支持 `http://`（CONNECT 隧道），`https://` 代理会被拒绝并提示。
