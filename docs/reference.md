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

CLI 的动作参数一次只接受一个：`--status --apply` 这类多动作组合被拒绝，报错并以退出码 2 结束，不按书写顺序取最后一个执行。未知参数（含拼错的开关与多余参数）同样报错退出，错误信息指出参数本身；`--host-root`、`--tier` 后面的取值不按未知参数处理。`--help`（或 `-h`）不受影响，正常显示帮助并退出 0。

CLI 退出码：`0` 动作成功，或 `--status` 预检通过；`1` 预检阻断、回退漂移拒绝、非法档位、`--doctor` 有失败项、`apply`/`revert` 失败，以及「应用记录不可读」导致的预检跳过；`2` 参数错误（未知参数、多个动作）或宿主根未配置。`--status` 在宿主根未配置时跳过补丁预检，退出码为 2，输出注明「预检被跳过 ≠ 通过」；两种预检跳过都不以 0 退出，脚本只认 0。宿主根已配置时 `--status` 其余行为不变：预检通过退出 0，阻断退出 1。

维护工具 `tools/collect-hashes.mjs <宿主根>` 在生成 `src/patch/hashes.json` 前先做归属校验：宿主 HEAD 必须等于 `DSH_TARGET.commit`，不是同一份提交就报错退出（退出码 1）且不生成哈希表；生成的记录里 `dsh.commit` 写实际采样的 HEAD。这样从别的树采出的哈希表不再会被对账当成对的，错归属在采集时就报出来。

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

`GET /breaklimit/status` 的 `data` 里，`mode` 是审批与工具门实际使用的档位（`sandboxPolicy` 的解析结果，读不到时按 `read-only` 处理）；`sandbox` 说明这个档位是不是真的读到了，字段为 `{ available, mode, error }`。`available` 为 false 表示服务缺失或解析抛错，`error` 给出原因；此时状态文本多一行「档位来源 不可判定」，避免把「真的只读」和「读不到档位」显示成同一个值。`modeSource` 说明档位归因：`'session'` 表示会话档位真的解析了出来，`'default'` 表示没探测到会话、落到部署默认档或档位根本没解析出来——为 `'default'` 时界面徽章显示「档位未探测」，不把部署默认档当会话档展示。

写请求须带 `Origin`，其 URL 的 host（含端口）须与请求头 `Host` 一致；读请求可省略 `Origin`，携带时也执行此校验。不满足校验的请求返回 403。写接口使用 JSON 请求体；响应字段为 `ok`、`code`、`message` 和可选的 `data`。并发冲突与清单损坏返回 409，失败 `code` 为：规则锁被占用 `locked`、清单 revision 冲突 `conflict`、规则清单损坏 `index_corrupt`，以及补丁侧的并发与漂移冲突 `operation_in_progress`、`drift_detected`——这类失败是「有人在并发操作、重试即可」或「文件漂移、核对后再来」，不是调用方的输入错误。预检阻断（`preflight_blocked`）与输入非法（`invalid_json`、`invalid_target`、`rule_invalid` 等）返回 400；规则路由的其余失败（`body_write_failed`、`landing_write_failed`、`index_write_failed`、`index_unreadable` 等）也按实现返回 400，原因在 `message` 里。本方内部故障返回 500：`PUT /alias`、`POST /patches/enabled`、`POST /override`、`POST /tier` 的写盘故障 `write_failed`，补丁引擎的 `apply_failed`、`revert_failed`、`state_corrupt`、`state_version_mismatch`，以及未捕获异常 `internal_error`。`snapshot_corrupt`（回退对账发现快照与记录不符，属备份证据损坏、非输入错误）按实现返回 400，调用方以 `code` 分辨。失败 `code` 是否透传随路由而异：`POST /rules/save` 与 `POST /rules/recover-corrupt` 把失败 `code` 原样放进信封；`POST /rules/activate`（含取消激活）、`POST /rules/delete`、`POST /rules/reset` 的失败 `code` 统一为 `rule_invalid`（`index_corrupt` 保留原 `code`），这三条路由上的并发冲突同样返回 409，分流以状态码为准。词库、更新与补丁开关的写入锁冲突沿各域既有失败形状报出（`POST /patches/enabled` 落 500 `write_failed`、更新接口落 500/502，每日自动检查把 `locked` 收进 `lastError`），不带 409；这几个域没有并发写契约，分辨靠 `code` 与 `message`。请求体超过上限返回 413 `too_large`：上限按所承载载荷（规则正文与注入正文）的 6 倍 JSON 转义余量推导，不设固定封顶，所以正文上限调大后请求体上限跟着涨；正文本身超限不走 413：`POST /breaklimit/rules/save` 回 400 `rule_invalid`、`POST /breaklimit/override` 回 400 `too_large`，与请求体超限不是同一件事。检查更新失败返回 502：`code` 为 `update_unreachable`（连不上、超时、非 2xx、限流或代理失败）或 `update_invalid`（响应不是 JSON 或没有合法版本标签）。

HTTP 响应里的绝对路径一律脱敏：盘符、用户目录与中间层级不出现，路径只折成 `…/<最后一段>`。唯一例外是 `POST /breaklimit/restart` 回传的 `data.command`：它必须是可直接粘贴执行的重启命令，真实绝对路径才有意义；该接口同样在 Host 栅栏与同源校验之内，只有本机放行的来源读得到它。

未提供 `webServer` 服务的宿主组合不会挂载这些路由，状态中显示 `http.mounted: false`。Web 设置页的可用性取决于宿主加载的客户端与服务组合。

目标词表存在 `$DSH_HOME/breaklimit/masks.json`：最多 100 条，每条 `from` 与 `to` 各不超过 64 字符，`from` 等于 `to` 的条目被丢弃。替换只在请求交付给模型之前作用于用户消息，精确字面匹配、长词优先；词表为空时不做任何替换。改完词表需要新开会话才生效。

`GET /breaklimit/alias` 读取词表文件失败时仍返回 HTTP 200、`code: "ok"`，告警放在 `message` 里（此时 `data.entries` 不可信，可能是空表）；调用方必须识别 `message` 非空的读取告警，不能只凭状态码判断读取正常。`PUT /breaklimit/alias` 是整表覆盖，不是单条增删接口。

更新状态存在 `$DSH_HOME/breaklimit/update.json`：包含每日自动检查开关、上次检查日期、最新版本、发布链接与忽略版本等字段，合并写入；文件缺失或字段类型不对时按空状态处理，不影响其他功能。发现损坏时，下次写入前先把原文件备份到 `$DSH_HOME/dsh-breaklimit-backup/<时间戳>/update.json` 再重建，备份失败则拒绝写入，原文件保持不变。代理只支持 `http://`（CONNECT 隧道），`https://` 代理会被拒绝并提示。
