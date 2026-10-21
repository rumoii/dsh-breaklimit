# 免责声明

最后更新：2026-10-21

`dsh-breaklimit`（npm 包名 `rumo-dsh-breaklimit`，下称"本项目"）是 Rumo 个人维护的非营利开源项目，按 MIT 许可发布。下载、安装、运行或传播本项目，即视为已阅读并接受本声明的全部条款；不同意任一条款的，请立即停止使用并销毁已有副本。

## 一、项目定位

本项目仅供学习与研究使用：在使用者自行准备的环境里，对本机 DeepSeek Harness 源码版应用或撤销源码补丁，维护提示词、规则与词表文件，并在受控条件下观察这些本地改动的效果。它不是面向公网的测量、渗透或攻击工具，也不提供此类能力。

## 二、与 DeepSeek 无任何关系

本项目为独立开发，与 DeepSeek 及 DeepSeek Harness 的开发、运营主体之间没有隶属、雇佣、商业合作、授权或官方背书关系。文中的"官方 DeepSeek Harness"仅指使用者本机安装的、由 DeepSeek 发布的原始软件包（`@deepseek-ai` 相关包），用来界定改动对象的范围；这不代表其开发者知晓、认可或担保本项目。

## 三、改动只发生在本机

补丁的应用与回滚、提示词和规则文件的写入与恢复、词表与配置的保存，全部在使用者本机的文件系统和本机进程内完成，作用对象只有本机的宿主源码树、`$DSH_HOME` 数据目录和本机 profile。设置页与插件之间的通信只经过本机的管理接口，按 [SECURITY.md](SECURITY.md) 的要求，该端口不得暴露给不受信任的网络。

运行时唯一的对外访问是版本核对：“每天自动检查一次”开关默认开启（在设置面板的「版本与更新」弹窗中可关闭），打开设置面板或浮窗时触发，至多每天访问一次本插件自己的 GitHub 发布列表（`api.github.com` 上的 `rumoii/dsh-breaklimit`）；“检查更新”按钮只在手动点击时访问同一地址。两种方式都只读取发布信息来比对版本号，除请求头中的插件版本号与来源 IP 外，不发送本地配置、会话内容或其他数据。除此之外，运行时不主动连接任何外部服务器。

使用者不得把本项目当作跳板或入口，对外部主机、网站或网络做访问、探测或其他任何操作。

## 四、允许的使用场景

仅限使用者在自己拥有并有权管理的设备与软件安装上进行本地研究。需要靶标时，靶标只能是使用者自备的离线合成环境、事先取得书面授权的演练靶场或合规实验室环境。凡未获得所有者合法书面授权的系统、公网在线服务与生产业务，一律禁止作为作用对象。

## 五、地域限制

严禁对位于中国大陆、香港、澳门的服务器、网站、网段，以及经域名解析后指向上述地区的任何地址，实施访问、探测或操作。确属使用者本人的服务器，须在操作前以书面记录载明确切 IP 地址或完整主机名，才构成例外；凭据、密钥、网段范围、通配符以及口头说明都不产生例外。使用云服务商的服务不构成豁免理由。

## 六、禁止的用途

使用者不得利用本项目直接或间接实施下列行为，也不得借助本项目规避任何监管要求：

- 违反《中华人民共和国刑法》《中华人民共和国网络安全法》《中华人民共和国数据安全法》《中华人民共和国个人信息保护法》或其他现行有效法律、行政法规与监管规定的行为；
- 未经授权侵入、渗透或破坏计算机信息系统，以及勒索、撞库、批量扫描、投放恶意代码等行为；
- 生成、传播或协助传播危害国家安全、恐怖主义、暴力血腥、淫秽色情、赌博、诈骗、侵犯公民个人信息与知识产权等法律明令禁止的内容；
- 违反 DeepSeek 或其他模型、服务提供方的服务条款与滥用政策。

本仓库发布的代码、文档、补丁声明、默认提示词与规则模板都是本地功能实现，不含木马、后门、勒索软件、撞库脚本或攻击载荷；本项目不生产违法违禁内容，也不教唆、组织或协助他人实施违法犯罪。

## 七、不担保与责任自负

本项目按现状提供，对完整性、安全性、适用性、适销性和不侵权不作任何明示或默示的担保。本项目会修改宿主源码树，并具备自动处理审批的能力；数据丢失、宿主损坏、配置失效、服务中断等风险由使用者自行评估并承担，应用补丁前应按文档完成备份。使用者的下载、部署、运行、修改、传播行为以及由此产生的全部输入输出后果，由使用者独立承担民事、行政及刑事责任；项目作者与贡献者不承担任何直接、间接或连带责任。

## 八、许可的自动终止

使用者违反本声明任一条款的，其依 MIT 协议享有的使用许可自违约行为发生之日起自动终止。该使用者须立即停止使用，并永久销毁本项目的全部代码、文档及衍生数据；由此引发的法律后果由其自行承担。许可终止不影响作者依法律和 MIT 许可另行追究责任的权利。

## 九、声明的效力

本声明中文版为准，随项目文档一起维护，修订后自标注的更新日期起生效。

---

# Disclaimer

Last updated: 2026-10-21

`dsh-breaklimit` (npm package name `rumo-dsh-breaklimit`, "this project" below) is a non-profit open-source project maintained by Rumo and released under the MIT License. Downloading, installing, running, or distributing this project means you have read and accept every term of this notice. If you disagree with any term, stop using it immediately and destroy all copies you hold.

## 1. Purpose

This project is for learning and research only: applying or reverting source patches to a local DeepSeek Harness source checkout you prepared yourself, maintaining prompt, rule, and word-mask files, and observing the effects of those local changes under controlled conditions. It is not a measurement, penetration, or attack tool aimed at public networks and provides no such capability.

## 2. No relationship with DeepSeek

This project is independently developed. It has no affiliation, employment, business cooperation, authorization, or endorsement relationship with the developers or operators of DeepSeek or DeepSeek Harness. "Official DeepSeek Harness" in this notice only means the original packages published by DeepSeek and installed on your own machine (the `@deepseek-ai` packages), used to delimit what may be changed; it does not imply that their developers know about, approve, or guarantee this project.

## 3. Changes stay on your machine

Applying and reverting patches, writing and restoring prompt and rule files, and saving word masks and configuration all happen in the local filesystem and local processes of your machine, and touch nothing beyond your local host source tree, `$DSH_HOME` data directory, and local profiles. The settings page and the plugin communicate only through the local management interface, which must not be exposed to untrusted networks, as [SECURITY.md](SECURITY.md) requires.

The only outbound access the runtime performs is version checking. The "check once a day automatically" switch is on by default (it can be turned off in the "Version and updates" dialog of the settings panel) and triggers at most once per day when the settings panel or the dock opens, reading the release list of this plugin's own GitHub repository (`rumo-dsh-breaklimit` on `api.github.com`). The "Check for updates" button reads the same address only when clicked manually. Both only read release information to compare version numbers and send no local configuration, session content, or other data beyond the plugin version carried in the request header and the source IP. Outside of this, the runtime initiates no connections to any external server.

You must not use this project as a springboard or entry point to access, probe, or otherwise operate on any external host, website, or network.

## 4. Permitted scenarios

Use is limited to local research on devices and software installations you own and are entitled to manage. When a target is needed, it may only be an offline synthetic environment you prepared yourself, an exercise range covered by prior written authorization, or a compliant laboratory environment. Any system, public online service, or production workload whose owner has not given lawful written authorization must never be used as a target.

## 5. Geographic restriction

Accessing, probing, or operating on servers, websites, or network segments located in mainland China, Hong Kong, or Macau, or on any address that resolves into those regions, is strictly prohibited. A server that is genuinely your own counts as the only exception when its exact IP address or full host name is recorded in writing before the operation; credentials, keys, network ranges, wildcards, and verbal statements create no exception. Using a cloud provider is not grounds for exemption.

## 6. Prohibited uses

You must not use this project, directly or indirectly, for any of the following, nor to evade regulatory requirements:

- any act that violates the Criminal Law of the People's Republic of China, the Cybersecurity Law of the People's Republic of China, the Data Security Law of the People's Republic of China, the Personal Information Protection Law of the People's Republic of China, or any other law, administrative regulation, or regulatory rule in force;
- unauthorized intrusion, penetration, or damage to computer information systems, ransomware, credential stuffing, bulk scanning, or delivering malicious code;
- producing, distributing, or helping distribute content prohibited by law, including content that endangers national security, promotes terrorism, violence, pornography, gambling, or fraud, or infringes personal information and intellectual property rights;
- violating the terms of service or abuse policies of DeepSeek or any other model or service provider.

The code, documents, patch declarations, default prompts, and rule templates released in this repository implement local functionality only; they contain no trojans, backdoors, ransomware, credential-stuffing scripts, or attack payloads. This project produces no illegal content and does not instigate, organize, or assist any crime.

## 7. No warranty; responsibility is yours

This project is provided "as is", without any express or implied warranty of completeness, security, fitness, merchantability, or non-infringement. It modifies the host source tree and can process approvals automatically; risks such as data loss, host damage, configuration loss, or service interruption are for you to assess and bear, and you should make backups as the documentation requires before applying patches. You alone bear civil, administrative, and criminal responsibility for your downloads, deployment, runs, modifications, distribution, and all resulting input and output. The author and contributors accept no direct, indirect, or joint liability.

## 8. Automatic termination of the license

If you breach any term of this notice, the rights granted to you under the MIT License terminate automatically on the date of the breach. You must stop using the project immediately and permanently destroy all of its code, documents, and derived data; any legal consequence is yours to bear. Termination does not affect the author's right to pursue further liability under the law and the MIT License.

## 9. Effect of this notice

The Chinese version of this notice is authoritative. The notice is maintained together with the project documentation, and a revision takes effect on the update date it states.

中英文内容不一致时，以中文版为准。If the two language versions conflict, the Chinese version prevails.
