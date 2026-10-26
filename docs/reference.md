# 命令与 HTTP 接口

## 宿主内命令

| 命令 | 用途 |
| --- | --- |
| `/breaklimit`、`/breaklimit status` | 查看状态与预检结果 |
| `/breaklimit apply` | 应用当前选择的补丁 |
| `/breaklimit revert` | 回退已记录的宿主文件改动 |
| `/breaklimit tier [recommended\|unrestricted]` | 查看或切换提示词模式；缺省为 `recommended` |
| `/breaklimit on`、`/breaklimit off` | 开启或关闭本次插件实例的运行时接管；不撤销已应用补丁 |
| `/breaklimit doctor` | 报告模式、预算与补丁明细，并给出同源五层运行时诊断 |
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
breaklimit --doctor
breaklimit --tier [recommended|unrestricted]
breaklimit --edit
breaklimit --rules
breaklimit --host-root <路径> --status
breaklimit --help
```

`--edit` 打开自定义提示词文件，`--rules` 列出规则。`--host-root` 可与需要宿主根的动作组合使用；无动作参数时显示帮助。CLI 与宿主接口共用补丁引擎，但各进程的宿主根和 `DSH_HOME` 配置须保持一致。独立 CLI `--doctor` 只检查 Node、pnpm、git、宿主根、依赖、数据目录、Web 组合与插件注册；五层运行时诊断使用宿主内的 `/breaklimit doctor`。

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

`GET /breaklimit/rules/status` 的 `data.pendingActivation` 是中断留下的规则切换记录：未提交的激活意图，或新激活已提交、旧落点待收尾的收尾记录（`phase: "cleanup"`）。字段为 `id`、`target`、`created`、`snapshot`、`previous`、`startedAt` 与可选的 `phase`；没有未完成记录时为 `null`。

`GET /breaklimit/status` 的 `data` 里，`mode` 是审批与工具门实际使用的档位（`sandboxPolicy` 的解析结果，读不到时按 `read-only` 处理）；`sandbox` 说明这个档位是不是真的读到了，字段为 `{ available, mode, error }`。`available` 为 false 表示服务缺失或解析抛错，`error` 给出原因；此时状态文本多一行「档位来源 不可判定」，避免把「真的只读」和「读不到档位」显示成同一个值。`modeSource` 说明档位归因：`'session'` 表示会话档位真的解析了出来，`'default'` 表示没探测到会话、落到部署默认档或档位根本没解析出来——为 `'default'` 时界面徽章显示「档位未探测」，不把部署默认档当会话档展示。`ensure` 是装载时规则首轮收拢的结果（导入了哪条/为何跳过/失败原因），没有收拢动作时为 `null`；它只做可见性，失败不影响插件装载。

`data.diagnostics.layers` 是五层只读诊断，每项包含 `id`、`state`、`scope`、`action`、`detail`、`evidence` 和 `warnings`。`state` 为 `pass`（通过）、`fail`（未生效）、`unknown`（不可判定）或 `not_applicable`（不适用）；`scope` 区分 `current_value`、`last_observation` 和 `process_cumulative`。整层适用时，当前失效优先于未知，未知优先于通过；历史累计告警不归因成当前会话失败，其他权限档的警告也不直接判当前档失败。

| `id` | 层 | `pass` 的必要条件 | 关键边界 |
| --- | --- | --- | --- |
| `disk` | 磁盘补丁 | 选择数大于 0，预检无阻断，`pendingFiles === 0`，findings 全为 `applied` / `satisfied` | `preflight.ok` 同时有待写入文件时为 `fail`；未选择补丁为 `not_applicable` |
| `process` | 进程装载与运行时预算 | `preflight.code === "ok"` 且选择数/待写入数完整，无待写入，应用记录不晚于当前进程启动，Loader 可读，当前模式的适用预算全部匹配，提交无失效或未核实项 | 预检早退或关键字段缺失为 `unknown`；应用时间晚于进程启动、预算缺数或提交 `unverified` 同样不得通过 |
| `assembly` | 系统提示装配 | 注入与档位可读，有装配观测，最终 system/message 未丢弃注入 | 接管关闭为 `not_applicable`；尚无最终消息观测为 `unknown`，不证明模型效果 |
| `request` | 请求前处理观测 | `preStep > 0`，词表配置数量已观测，当前无请求阻断错误 | 声明改写与词表计数是进程累计值；累计 `hardenMisses` 只告警，不单独判当前失败 |
| `execution` | 执行权限与接缝观测 | 当前会话档位与预设可解析、当前预设无前置拒绝，至少一个相关接缝有进程内观测 | 计数为 0 是 `unknown`；只证明接缝观测，不证明工具最终执行成功 |

`preflight.selectedPatches` 提供当前选择数，`budgetExpected` 提供当前模式的预期预算，`processStartedAt` 是与 `applied.updatedAt` 比较装载先后的进程启动时间（毫秒时间戳）。`masks` 只含 `{ configured, hits, lastHits, lastAt }` 统计；`hits` 是进程累计值，`lastHits` / `lastAt` 是本次装载以来最近一次命中，不是当前请求命中。词表词条、替换结果、消息和请求正文不进入状态。

恢复动作按证据分流：`state_corrupt` / `state_version_mismatch` 使用 `check-state`，先检查恢复记录，不引导回退；`recovery_required` 且本进程锁占用时为 `unknown + refresh`，非占用时为 `fail + check-recovery`，先确认没有其他应用或回退，再按可信事务恢复。`warnings` 同时显示在宿主命令和 Web 技术诊断中。

写请求须带 `Origin`，其 URL 的 host（含端口）须与请求头 `Host` 一致；读请求可省略 `Origin`，携带时也执行此校验。不满足校验的请求返回 403。写接口使用 JSON 请求体；响应字段为 `ok`、`code`、`message` 和可选的 `data`。并发冲突与清单损坏返回 409，失败 `code` 为：规则锁被占用 `locked`、清单 revision 冲突 `conflict`、规则清单损坏 `index_corrupt`，以及补丁侧的并发与漂移冲突 `operation_in_progress`、`drift_detected`——这类失败是「有人在并发操作、重试即可」或「文件漂移、核对后再来」，不是调用方的输入错误。预检阻断（`preflight_blocked`）与输入非法（`invalid_json`、`invalid_target`、`rule_invalid` 等）返回 400；规则路由的其余失败（`body_write_failed`、`landing_write_failed`、`index_write_failed`、`index_unreadable` 等）也按实现返回 400，原因在 `message` 里。本方内部故障返回 500：`PUT /alias`、`POST /patches/enabled`、`POST /override`、`POST /tier` 的写盘故障 `write_failed`，补丁引擎的 `apply_failed`、`revert_failed`、`state_corrupt`、`state_version_mismatch`，以及未捕获异常 `internal_error`。`snapshot_corrupt`（回退对账发现快照缺失、不可读或与记录不符，属备份证据损坏、非输入错误）按实现返回 400，调用方以 `code` 分辨。`drifted` 明细用 `kind: 'snapshot' | 'target'` 区分快照故障与目标漂移；混合故障的汇总分别计数，前端展示每项分类、路径与原因。失败 `code` 是否透传随路由而异：`POST /rules/save` 与 `POST /rules/recover-corrupt` 把失败 `code` 原样放进信封；`POST /rules/activate`（含取消激活）、`POST /rules/delete`、`POST /rules/reset` 的失败 `code` 统一为 `rule_invalid`（`index_corrupt` 保留原 `code`），这三条路由上的并发冲突同样返回 409，分流以状态码为准。词库、更新与补丁开关的写入锁冲突沿各域既有失败形状报出（`POST /patches/enabled` 落 500 `write_failed`、更新接口落 500/502，每日自动检查把 `locked` 收进 `lastError`），不带 409；这几个域没有并发写契约，分辨靠 `code` 与 `message`。请求体超过上限返回 413 `too_large`：上限按所承载载荷（规则正文与注入正文）的 6 倍 JSON 转义余量推导，不设固定封顶，所以正文上限调大后请求体上限跟着涨；正文本身超限不走 413：`POST /breaklimit/rules/save` 回 400 `rule_invalid`、`POST /breaklimit/override` 回 400 `too_large`，与请求体超限不是同一件事。检查更新失败返回 502：`code` 为 `update_unreachable`（连不上、超时、非 2xx、限流或代理失败）或 `update_invalid`（响应不是 JSON 或没有合法版本标签）。

HTTP 响应里的绝对路径一律脱敏：盘符、用户目录与中间层级不出现，路径只折成 `…/<最后一段>`；`diagnostics` 内嵌套对象和数组先精确替换本次状态已知的宿主根、注入文件、操作锁、规则索引和词表路径，再按通用路径规则脱敏，覆盖通用正则未包含的 POSIX 根和 UNC 形状。唯一例外是 `POST /breaklimit/restart` 回传的 `data.command`：它必须是可直接粘贴执行的重启命令，真实绝对路径才有意义；该接口同样在 Host 栅栏与同源校验之内，只有本机放行的来源读得到它。

未提供 `webServer` 服务的宿主组合不会挂载这些路由，状态中显示 `http.mounted: false`。Web 设置页的可用性取决于宿主加载的客户端与服务组合。

目标词表存在 `$DSH_HOME/breaklimit/masks.json`：最多 100 条，每条 `from` 与 `to` 各不超过 64 字符，`from` 等于 `to` 的条目被丢弃。替换只在请求交付给模型之前作用于用户消息，精确字面匹配、长词优先；词表为空时不做任何替换。部分词条无效时忽略无效项并报告降级，合法项继续生效；文件或结构不可读、全部词条无效且没有可信快照时，当前请求以 `mask_config_unavailable` 明确失败，不再静默返回 `reject`。改完词表需要新开会话才生效。

`GET /breaklimit/alias` 读取词表文件失败时仍返回 HTTP 200、`code: "ok"`，告警放在 `message` 里（此时 `data.entries` 不可信，可能是空表）；调用方必须识别 `message` 非空的读取告警，不能只凭状态码判断读取正常。`PUT /breaklimit/alias` 是整表覆盖，不是单条增删接口。

更新状态存在 `$DSH_HOME/breaklimit/update.json`：包含每日自动检查开关、上次检查日期、最新版本、发布链接与忽略版本等字段，合并写入；文件缺失或字段类型不对时按空状态处理，不影响其他功能。发现损坏时，下次写入前先把原文件备份到 `$DSH_HOME/dsh-breaklimit-backup/<时间戳>/update.json` 再重建，备份失败则拒绝写入，原文件保持不变。代理只支持 `http://`（CONNECT 隧道），`https://` 代理会被拒绝并提示。


## 规则切换的收尾状态

`GET /breaklimit/status` 与 `GET /breaklimit/rules/status` 的 `pendingActivation.phase: "cleanup"` 表示新激活已提交、旧落点仍待收尾，`previous` 保留旧归属。激活成功响应的 `cleanupPending: true` 具有相同含义。读取或写入故障解决后，启动或下次规则写操作会重试；仍失败时规则写入口返回 409（失败 `code` 按各路由既有归一：`/rules/save` 透传 `conflict`，激活/取消/删除/重置归一为 `rule_invalid`），不会覆盖恢复记录。没有 phase 的旧激活意图不会被当成已提交的收尾。

同落点切换不先恢复原文再接管，`snapshotKept` 如实反映沿用首次快照。取消激活返回 `deactivate_kept` 时规则仍生效，不能按 HTTP 200 推断已取消。


## 配置读取与事务恢复

- `/override` 保持 HTTP 200；`data.effective.ok=false` 表示正文未知，不能编辑、保存、复制或恢复。修复原文件后重新读取；保存使用原子替换。
- 档位与词表不可读或损坏时，同一插件实例沿用最近成功读取的配置并告警。部分词条无效时合法项也可进入快照；没有可信配置时暂停受影响操作并给出可见错误，不把未知内容当成默认档、空词表或内置正文。文件不存在仍表示默认档位或空词表。CLI 不共享运行进程的快照。档位修复或变化后，装载期与提示词装配会补交对应执行预算，同一实例的进行中提交去重；实际提交前在串行队列里重读最新档位，非禁用跳过或读回不一致不会记为成功，后续装配可重试。
- `GET /tier` 的 `source` 为 `disk`、`cached` 或 `unavailable`；不可用时 `tier=null`，`error` 给出原因。`POST /tier` 返回 `budget` 与 `budgetVerified`。`tier_saved_budget_unconfirmed` 表示档位已保存，但不能确认执行预算生效。
- 规则清单存在但为空时保持为空；仅清单不存在时自动收拢落点。保存规则省略 `target` 时保留原落点。
- 新补丁事务写 `state.json` v2，新代码读取 v1/v2。`pendingAfter` 在目标写入前记录本批计划哈希；中断后应用返回 HTTP 409 / `recovery_required`，先回退，再重新应用。旧 v1 事故缺少充分证据时保留现场，使用重建工具核对，不能强行接管。
- 有 v2 记录时不能直接降级旧代码；先用新版完成回退并确认记录清除。旧代码会拒绝 v2，而非猜测恢复。事务目录和快照不能因降级而删除。
- 文本补丁只接受可无损往返的 UTF-8；非法编码整体拒写。快照与恢复按原始字节处理，保留 BOM。备份读失败、快照缺失和写前内容变化均拒绝覆盖。
