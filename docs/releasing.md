# 发布流程

发布候选使用已合入 main 的完整提交。标签为 `v<package.json 版本>`；0.9 系列标记为 Pre-release，不设为 Latest。工作流只准备和核验草稿，最终发布由维护者或其明确授权的操作者执行。

1. 同步包版本、CHANGELOG、README 安装版本及 `docs/releases/<版本>.md`。发布说明面向用户，介绍功能、变化、安装与使用限制；测试数字、故障排查经过和验收记录放在 PR、Actions 或验收文档中。提交与 PR 遵循 [贡献指南](../CONTRIBUTING.md)，main 保留维护者直推能力。
2. 在候选提交运行以下检查，并要求 GitHub **Check** 的 Windows、Ubuntu × Node 22.19、24 以及 Fixed host fixture 全部通过。检查本次文件与待发布历史没有凭据、私人数据，代码和素材来源符合许可要求。

   ```powershell
   npm run check
   npm run reconcile -- '<固定宿主源码根>'
   npm run check:host -- '<固定宿主源码根>'
   npm pack --dry-run --ignore-scripts
   git diff --check
   ```

3. 确认候选改动已落入 main，再创建并推送标签，记录完整 40 位源 SHA。已推送标签不移动；候选代码需要修复时使用新版本。打包只读取标签中的 Git 跟踪文件，未提交文件、依赖目录和日常配置不进入附件。
4. 在 main 启动 **Prepare draft release**，填写已有标签和完整源 SHA。工作流检查候选源码后生成源码 ZIP、`release-metadata.json` 和 `SHA256SUMS.txt`，读取候选中的发布说明并上传草稿。已有草稿只补传缺失附件，已有附件须逐字节匹配；内容不符时停止，不覆盖附件或已发布版本。上传中断后先查远端草稿，再决定是否重试。
5. 在 main 启动 **Verify draft release**，填写相同标签和 SHA。它重新下载实际附件，从源提交重建 ZIP 比对全部字节，再在 Windows、Ubuntu × Node 22.19、24 解压执行源码与固定宿主检查，最后确认草稿附件未变。四份 `verification.json` 保存在该次 Actions 产物，记录源 SHA、草稿 ID 与附件哈希。
6. 从实际下载的 ZIP，在独立固定版本宿主、新 `DSH_HOME` 和独立端口按 README 完成安装、doctor、预检、应用、重复应用、启动、HTTP 与浏览器操作、回退和卸载。浏览器检查中英文、补丁选择、规则保存与恢复、确认和取消；回退后核对宿主原文，卸载后核对用户数据保留。夹具与单元测试不能代替实际安装；模型、沙箱、其他系统等未覆盖场景单独注明。
7. 源码、附件和实际安装验收均通过后，核对草稿正文与当前版本发布说明一致。最终文案可以在 main 更新后同步到草稿，无需替换已验证附件；重新运行准备工作流会再次读取候选中的旧正文，需重新同步。验证证据留在 PR、Actions 或验收记录中，正文末尾简述源提交与哈希附件。
8. 发布草稿；0.9 系列保留 Pre-release，关闭 Set as latest。检查未登录访问的发布页面、三个附件下载及 SHA-256。npm 发布和自动部署不包含在此流程中。

工作流工具来自启动时的 main 提交，候选源码来自标签。发布工具修正在 main 合入后，使用更新后的工具重新核验草稿，记录工具提交与候选提交；不要为工具更新移动候选标签。任何附件变化都需要重新核验。

GitHub 读取草稿需要写权限。下载和最终元数据核对任务只运行 main 工具，四组解压检查任务只读，不接收草稿 token。打包使用 Git、Node；Windows 解压使用系统 tar，Ubuntu 使用 unzip。本地草稿操作另需已登录且有仓库写权限的 GitHub CLI。

本地等价操作（使用当前 main 的工具，输出目录须为新目录或内容完全相同）：

```powershell
$ReleaseTag = 'v0.9.5'
$SourceSha = git rev-parse "$ReleaseTag^{}"
$AssetsDir = Join-Path $env:TEMP "dsh-release-$ReleaseTag"
node tools/release.mjs pack . $ReleaseTag $SourceSha $AssetsDir
node tools/release.mjs verify . $ReleaseTag $SourceSha $AssetsDir
node tools/github-release.mjs prepare . $ReleaseTag $SourceSha $AssetsDir docs/releases/0.9.5.md
node tools/github-release.mjs verify . $ReleaseTag $SourceSha '<固定宿主源码根>' '<验收记录路径>/verification.json'
```

发布范围为受信任的本机 Web 环境，管理接口尚未接入宿主登录认证。完整验收边界与检查方法见 [自检与验收](verify.md)。
