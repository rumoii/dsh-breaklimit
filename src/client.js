// rumo-dsh-breaklimit 浏览器半：宿主设置页里的一个分区。
//
// 宿主用 window.__ModuleLoader__.load 直接加载这个文件，不经过打包，所以它只依赖
// react，元素全部用 createElement 手写。
//
// 设计约束：
//   1. 颜色、圆角、字体只取宿主令牌（--dsw-*），浅色深色跟着宿主切换。
//   2. 每屏一个主操作；会改磁盘的动作先写清后果与规模，再就地确认。
//   3. 结论只来自后端（预检、应用记录、规则索引）；前端只把它翻译成一句话和下一步。
//   4. 后端的 message 是写给终端的中文，这里一律不展示，按 code 与 data 自己出文案。
//
// 文案守卫 tools/check-client.mjs 从英文包起点一直扫到文件末尾，所以 TEXT 之后的
// 代码里不能出现中文字面量；中文只放在注释和 zh 包里。
//
// 测试桩只提供 useState / useEffect / useCallback / useRef，并把 Section 当普通函数
// 调用、不展开子组件，所以 tablist 必须直接写在 Section 的返回树里。
window.__ModuleLoader__.load({ id: "rumo-dsh-breaklimit", factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

  const react = require("react")
  const h = react.createElement
  const { useState, useEffect, useCallback, useRef } = react

  const name = "rumo-dsh-breaklimit"
  const inject = ["slots"]
  const SECTION_ID = "breaklimit"
  const SECTION_ORDER = 45
  // 与 package.json 同步，发版时两处一起改。不运行时读 package.json。
  const PLUGIN_VERSION = "0.9.3"
  const API = "/breaklimit"
  const REQUEST_TIMEOUT_MS = 20000
  const NOTICE_OK_MS = 5000
  // 对齐 frontend.v2.html:307 的 toast 停留时长。
  const TOAST_MS = 4200
  const CLOCK_MS = 30000
  const STYLE_ID = "bkl-scoped-style"
  const TAB_KEYS = ["overview", "patches", "prompt", "rules", "words"]
  const TAB_ICON = { overview: "grid", patches: "patch", prompt: "text", rules: "file", words: "dictionary" }
  const MODES = ["recommended", "unrestricted"]
  const RULE_TARGETS = ["AGENTS.md", "CLAUDE.md"]
  const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
  const LIST_LIMIT = 5
  // 词库上限与 host/masks.js 一致（MAX_MASKS / MAX_MASK_TERM）；
  // GET /alias 会带回后端实测的 limits，取到后用后端的值。
  const WORDS_MAX = 100
  const WORD_TERM_MAX = 64
  // 浮窗与设置页是两个挂载点、两份 state。浮窗改了档位，设置页那份就旧了；
  // 用一个自定义事件把「后端状态变了」传过去，不把 load 从设置页里导出来。
  const STATE_CHANGED_EVENT = "bkl:state-changed"
  // 浮窗的「管理词库」要把设置分区切到词库页。设置分区挂载时才有 state，
  // 所以除了事件，还在模块级记一份待落地的页签，设置分区一挂载就消费它。
  const NAVIGATE_EVENT = "bkl:navigate"

  // ---- 宿主令牌 ------------------------------------------------------------
  //
  // 只引用宿主已有的令牌。--dsw-font-* 是 font 简写（如 13px/20px family），必须
  // 写在 font 上而不是 fontSize。主按钮那对填充色/前景色与宿主 ui-primitives 的
  // Button 一致；错误色没有 tertiary，柔和底色用 color-mix 从主色混出来。
  const tk = {
    label: "var(--dsw-alias-label-primary)",
    label2: "var(--dsw-alias-label-secondary)",
    label3: "var(--dsw-alias-label-tertiary)",
    caption: "var(--dsw-alias-label-caption)",
    line1: "var(--dsw-alias-border-l1)",
    line2: "var(--dsw-alias-border-l2)",
    line3: "var(--dsw-alias-border-l3)",
    line4: "var(--dsw-alias-border-l4)",
    bg: "var(--dsw-alias-bg-base)",
    layer1: "var(--dsw-alias-bg-layer-1)",
    layer2: "var(--dsw-alias-bg-layer-2)",
    layer3: "var(--dsw-alias-bg-layer-3)",
    // 浅色主题下 layer-1/2/3 都是纯白，嵌在卡片里的凹槽用主文字色混一层薄底，深浅色都能分出层次。
    well: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)",
    accent: "var(--dsw-alias-state-business-primary)",
    accentSoft: "var(--dsw-alias-state-business-tertiary)",
    ok: "var(--dsw-alias-state-success-primary)",
    okSoft: "var(--dsw-alias-state-success-tertiary)",
    warn: "var(--dsw-alias-state-warn-primary)",
    warnSoft: "var(--dsw-alias-state-warn-tertiary)",
    error: "var(--dsw-alias-state-error-primary)",
    errorSoft: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)",
    fill: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary))",
    onFill: "var(--dsw-alias-label-primary-foreground)",
    rXs: "var(--dsw-radius-xs)",
    rSm: "var(--dsw-radius-sm)",
    rMd: "var(--dsw-radius-md)",
    rLg: "var(--dsw-radius-lg)",
    rXl: "var(--dsw-radius-xl)",
    fontTitle: "var(--dsw-font-base-16)",
    font: "var(--dsw-font-xs-13)",
    fontStrong: "var(--dsw-font-xs-strong-13)",
    fontSmall: "var(--dsw-font-xxs-12)",
    fontSmallStrong: "var(--dsw-font-xxs-strong-12)",
    mono: "var(--dsw-font-mono, var(--ds-font-family-code, ui-monospace, Consolas, monospace))",
    // 字号四档：宿主令牌只有 16/13/12 三档，页面标题与区块标题这一级需要自己定值。
    // 应用名比页面标题小一号，这样进到任何一页，第一眼看到的是页面标题而不是产品名。
    fontApp: "17px",
    fontPage: "22px",
    fontSection: "15px",
    fontBody: "14px",
    fontLabel: "13px",
    fontHelp: "12px",
    fontMicro: "11px",

    // 状态细边框（用于徽章、渐变高光卡片边缘、虚线引导框）
    accentLine: "var(--dsw-alias-state-business-secondary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent))",
    okLine: "var(--dsw-alias-state-success-secondary, color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, transparent))",
    warnLine: "var(--dsw-alias-state-warn-secondary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, transparent))",
    errorLine: "var(--dsw-alias-state-error-secondary, color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent))",

    // 交互前景色与反色层
    onDanger: "var(--dsw-alias-button-danger-foreground, #ffffff)",
    tooltipBg: "var(--dsw-alias-bg-inverse, var(--dsw-alias-label-primary))",
    tooltipText: "var(--dsw-alias-label-inverse, var(--dsw-alias-bg-base))",
    toastIcon: "var(--dsw-alias-state-success-primary)",
    overlay: "color-mix(in srgb, #000 48%, transparent)",
    scrollShade: "color-mix(in srgb, #000 16%, transparent)",

    // 空间层级阴影系统
    shadowSm: "0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent), 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)",
    shadowPop: "0 24px 60px -12px color-mix(in srgb, #000 35%, transparent), 0 0 0 1px var(--dsw-alias-border-l1)",
    shadowUp: "0 -8px 20px -12px color-mix(in srgb, #000 25%, transparent)",
    knobShadow: "0 1px 2px color-mix(in srgb, #000 25%, transparent)",

    gapField: "14px",
    gapLabel: "6px",
    gapBlock: "28px",
    padCard: "20px",
    padRow: "16px",
  }

  const TONE_COLOR = { ok: tk.ok, warn: tk.warn, error: tk.error, info: tk.accent, accent: tk.accent, idle: tk.line4 }
  const TONE_SOFT = { ok: tk.okSoft, warn: tk.warnSoft, error: tk.errorSoft, info: tk.accentSoft, accent: tk.accentSoft, idle: tk.well }
  const TONE_LINE = { ok: tk.okLine, warn: tk.warnLine, error: tk.errorLine, info: tk.accentLine, accent: tk.accentLine, idle: tk.line2 }
  const DISK_TONE = { pending: "accent", ready: "ok", blocked: "error", skipped: "idle", unknown: "idle" }
  const STEP_TONE = { done: "ok", todo: "accent", warn: "warn", error: "error" }

  const S = {
    root: { display: "flex", flexDirection: "column", gap: "16px", font: tk.font, color: tk.label, minWidth: 0 },
    header: { display: "flex", alignItems: "flex-start", gap: "12px" },
    headText: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
    title: { margin: 0, fontSize: tk.fontApp, lineHeight: 1.35, fontWeight: 600, letterSpacing: "-0.2px", color: tk.label },
    // 顶栏品牌块与标题行：品牌 38px 圆角图标块 + 标题/版本徽章同排。
    brandMark: {
      display: "grid", placeItems: "center", width: "38px", height: "38px",
      borderRadius: tk.rMd, background: tk.accentSoft, color: tk.accent, flexShrink: 0,
    },
    titleRow: { display: "flex", alignItems: "center", gap: "8px" },
    lead: { margin: 0, fontSize: tk.fontLabel, color: tk.label3 },
    headAside: { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 },
    stamp: { font: tk.fontSmall, color: tk.caption, whiteSpace: "nowrap" },

    // 每页顶部：页面标题是这一屏的第一眼，应用名只在顶栏出现一次。
    pageHeadWrap: { display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 },
    pageHead: { display: "flex", alignItems: "flex-start", gap: "12px", minWidth: 0 },
    pageHeadText: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
    pageTitle: { margin: 0, fontSize: tk.fontPage, lineHeight: 1.35, fontWeight: 650, letterSpacing: "-0.3px", color: tk.label },
    pageDesc: { margin: 0, fontSize: tk.fontLabel, color: tk.label2, maxWidth: "62ch" },
    whenTag: {
      flexShrink: 0, alignSelf: "center", padding: "2px 9px", borderRadius: "999px",
      border: `0.5px solid ${tk.line2}`, background: tk.well, fontSize: tk.fontHelp,
      color: tk.label3, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center",
    },
    pageTip: {
      display: "flex", alignItems: "flex-start", gap: "11px",
      padding: "11px 12px 11px 14px", marginBottom: "4px",
      border: `1px dashed ${tk.line2}`, borderRadius: tk.rMd,
      background: tk.layer1, fontSize: tk.fontLabel, color: tk.label2,
    },
    pageTipIcon: { color: tk.accent, marginTop: "2px", flexShrink: 0 },
    pageTipContent: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
    pageTipLead: { color: tk.label, fontWeight: 600, marginRight: "6px" },
    pageTipText: { color: tk.label2 },
    pageTipPitfall: { display: "block", marginTop: "3px", color: tk.caption, fontSize: tk.fontHelp },
    pageTipClose: {
      margin: "-3px -4px -3px 0", padding: "4px", background: "transparent",
      border: "none", cursor: "pointer", color: tk.caption, borderRadius: "4px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    },

    tablist: { display: "flex", columnGap: "24px", overflowX: "auto", scrollbarWidth: "thin", borderBottom: `0.5px solid ${tk.line2}` },
    tab: {
      appearance: "none", background: "transparent", border: "none", borderBottom: "2px solid transparent",
      margin: 0, padding: "8px 0 7px", cursor: "pointer", font: tk.font, color: tk.label3,
      display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap",
    },
    tabOn: { font: tk.fontStrong, color: tk.label, borderBottom: `2px solid ${tk.accent}` },
    // 页签角标：待写入计数（accent 药丸）与错误/脏点的包装（含 sr-only 文本）。
    tabCount: {
      minWidth: "18px", padding: "0 5px", borderRadius: tk.rXl,
      background: tk.accentSoft, color: tk.accent,
      fontSize: tk.fontMicro, fontWeight: 700, lineHeight: "17px", textAlign: "center",
    },
    tabBadge: {
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: "16px", height: "16px", padding: "0 4px", borderRadius: tk.rXl,
      background: tk.errorSoft, color: tk.error,
      fontSize: tk.fontMicro, fontWeight: 700, lineHeight: 1,
    },
    tabTagWrap: { display: "inline-flex", alignItems: "center" },
    panel: { display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 },

    card: {
      display: "flex", flexDirection: "column", gap: "12px", padding: "16px",
      background: tk.layer1, border: `0.5px solid ${tk.line2}`, borderRadius: tk.rMd, minWidth: 0,
    },
    cardHead: { display: "flex", alignItems: "flex-start", gap: "12px" },
    cardHeadText: { display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 auto", minWidth: 0 },
    cardTitle: { margin: 0, fontSize: tk.fontSection, lineHeight: 1.45, fontWeight: 600, color: tk.label },
    eyebrow: { display: "inline-flex", alignItems: "center", gap: "6px", font: tk.fontSmallStrong, color: tk.label3 },
    bigTitle: { margin: 0, fontSize: tk.fontSection, lineHeight: 1.45, fontWeight: 650, color: tk.label },

    text: { margin: 0, color: tk.label2 },
    small: { margin: 0, fontSize: tk.fontHelp, color: tk.label3 },
    caption: { fontSize: tk.fontHelp, color: tk.caption },
    savedMark: { display: "inline-flex", alignItems: "center", gap: "5px", fontSize: tk.fontHelp, color: tk.ok },
    strong: { font: tk.fontStrong, color: tk.label },
    row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
    spacer: { flex: "1 1 auto" },

    btn: {
      appearance: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px",
      minHeight: "30px", padding: "5px 12px", margin: 0, borderRadius: tk.rSm,
      border: `0.5px solid ${tk.line3}`, background: tk.layer1, color: tk.label,
      font: tk.fontStrong, cursor: "pointer", whiteSpace: "nowrap", textDecoration: "none",
    },
    btnPrimary: { background: tk.fill, border: "0.5px solid transparent", color: tk.onFill },
    btnDanger: { background: tk.error, border: "0.5px solid transparent", color: tk.onFill },
    btnQuiet: { background: "transparent", border: "0.5px solid transparent", color: tk.label2, padding: "5px 8px" },
    btnQuietDanger: { background: "transparent", border: "0.5px solid transparent", color: tk.error, padding: "5px 8px" },
    // 文字链：无边框底色，accent 着色；hover 下划线见 SCOPED_CSS（内联写不出 :hover）。
    btnLink: { background: "transparent", border: "none", color: tk.accent, padding: "2px 0", minHeight: 0, font: tk.fontStrong, gap: "5px", justifyContent: "flex-start" },
    // 纯图标钮：透明圆角，hover 变底色见 SCOPED_CSS。
    btnIcon: { background: "transparent", border: "none", color: tk.label2, padding: "6px", minWidth: 0, borderRadius: tk.rSm },
    btnSmall: { minHeight: "26px", padding: "3px 10px", font: tk.fontSmallStrong },
    btnOff: { opacity: 0.45, cursor: "not-allowed" },

    tag: {
      display: "inline-flex", alignItems: "center", gap: "4px", minHeight: "18px", padding: "0 6px",
      borderRadius: tk.rXs, border: `0.5px solid ${tk.line2}`, font: tk.fontSmall, color: tk.label3, whiteSpace: "nowrap",
    },
    tagTone: { border: "0.5px solid currentColor" },
    dot: { display: "inline-block", width: "6px", height: "6px", borderRadius: tk.rXs, flexShrink: 0 },

    switchTrack: {
      appearance: "none", position: "relative", display: "inline-block", width: "32px", height: "18px",
      padding: 0, margin: 0, border: "none", borderRadius: tk.rXl, background: tk.line4, cursor: "pointer", flexShrink: 0,
    },
    switchOn: { background: tk.fill },
    switchKnob: {
      position: "absolute", top: "2px", left: "2px", width: "14px", height: "14px",
      borderRadius: tk.rXl, background: "#fff", transform: "translateX(0)",
    },
    // 打开态的轨道是主按钮填充色（深色主题下接近白色），滑块跟主按钮文字取同一个前景色。
    switchKnobOn: { transform: "translateX(14px)", background: tk.onFill },

    banner: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: tk.rMd, border: `0.5px solid ${tk.line2}` },
    bannerHead: { display: "flex", alignItems: "center", gap: "8px" },
    bannerTitle: { margin: 0, font: tk.fontStrong, color: tk.label, flex: "1 1 auto", minWidth: 0 },
    list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" },
    pathList: { margin: 0, padding: "6px 10px", listStyle: "none", display: "flex", flexDirection: "column", gap: "2px", borderRadius: tk.rSm, background: tk.well },
    pathItem: { font: tk.fontSmall, fontFamily: tk.mono, color: tk.label2, wordBreak: "break-all" },
    pathMore: { font: tk.fontSmall, color: tk.label3 },
    codeBlock: {
      margin: 0, padding: "8px 10px", borderRadius: tk.rSm, background: tk.well, border: `0.5px solid ${tk.line1}`,
      font: tk.fontSmall, fontFamily: tk.mono, color: tk.label2, whiteSpace: "pre-wrap", wordBreak: "break-all",
      maxHeight: "180px", overflow: "auto",
    },
    mono: { fontFamily: tk.mono, wordBreak: "break-all" },
    code: { font: tk.fontSmall, fontFamily: tk.mono, color: tk.caption },

    rows: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" },
    rowItem: { display: "grid", gridTemplateColumns: "minmax(84px, 120px) minmax(0, 1fr) auto", alignItems: "start", columnGap: "12px", padding: "10px 0", borderTop: `0.5px solid ${tk.line1}` },
    rowFirst: { borderTop: "none", padding: "0 0 10px" },
    rowKey: { color: tk.label3, paddingTop: "1px" },
    rowVal: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
    rowValue: { display: "inline-flex", alignItems: "center", gap: "6px", color: tk.label, wordBreak: "break-word" },

    steps: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "2px" },
    step: {
      appearance: "none", display: "flex", alignItems: "flex-start", gap: "12px", width: "100%", margin: 0,
      padding: "8px 10px", border: "none", borderRadius: tk.rSm, background: "transparent", color: tk.label,
      font: tk.font, textAlign: "left", cursor: "pointer",
    },
    stepMark: {
      display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "20px",
      borderRadius: tk.rXl, border: "1px solid", font: tk.fontSmallStrong, flexShrink: 0,
    },
    stepBody: { display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 auto", minWidth: 0 },
    stepTitleRow: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
    stepChevron: { color: tk.caption, paddingTop: "1px" },

    legend: { margin: 0, padding: "10px 12px", listStyle: "none", display: "flex", flexDirection: "column", gap: "4px", borderRadius: tk.rSm, background: tk.well },
    legendItem: { margin: 0, font: tk.fontSmall, color: tk.label2 },
    legendKey: { font: tk.fontSmallStrong, color: tk.label, marginRight: "4px" },

    patch: { display: "flex", flexDirection: "column", gap: "8px", padding: "14px 16px", background: tk.layer1, border: `0.5px solid ${tk.line2}`, borderRadius: tk.rMd },
    patchHead: { display: "flex", alignItems: "flex-start", gap: "16px" },
    patchMain: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
    patchTitle: { font: tk.fontStrong, color: tk.label, overflowWrap: "anywhere" },
    patchSwitch: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", flexShrink: 0, paddingTop: "1px" },
    switchHint: { font: tk.fontSmall, color: tk.label3, whiteSpace: "nowrap" },
    patchMeta: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", font: tk.fontSmall, color: tk.label3 },
    metaItem: { display: "inline-flex", alignItems: "center", gap: "6px" },
    inlineNote: { margin: 0, padding: "6px 10px", borderRadius: tk.rSm, background: tk.warnSoft, font: tk.fontSmall, color: tk.label2 },
    detail: { display: "flex", flexDirection: "column", gap: "10px", paddingTop: "10px", borderTop: `0.5px solid ${tk.line1}` },
    detailBlock: { display: "flex", flexDirection: "column", gap: "4px" },
    targetPath: { font: tk.fontSmallStrong, fontFamily: tk.mono, color: tk.label, wordBreak: "break-all" },

    actionBar: {
      position: "sticky", bottom: 0, zIndex: 1, display: "flex", flexDirection: "column", gap: "8px",
      padding: "12px 0 4px", background: tk.bg, borderTop: `0.5px solid ${tk.line2}`,
    },

    radioGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px" },
    radioCard: {
      appearance: "none", display: "flex", flexDirection: "column", gap: "6px", margin: 0, padding: "12px 14px",
      borderRadius: tk.rSm, border: `0.5px solid ${tk.line3}`, background: tk.layer1, color: tk.label,
      font: tk.font, textAlign: "left", cursor: "pointer", minWidth: 0,
    },
    radioCardOn: { border: `1px solid ${tk.accent}`, padding: "11.5px 13.5px", background: tk.accentSoft },
    radioHead: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
    radioMark: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "14px", height: "14px", borderRadius: tk.rXl, border: `1px solid ${tk.line4}`, flexShrink: 0 },
    radioMarkOn: { border: `1px solid ${tk.accent}` },
    radioMarkDot: { width: "6px", height: "6px", borderRadius: tk.rXl, background: tk.accent },
    segment: { display: "flex", flexDirection: "column", gap: "6px" },

    field: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
    fieldLabel: { font: tk.fontSmallStrong, color: tk.label2 },
    input: {
      width: "100%", boxSizing: "border-box", margin: 0, padding: "6px 10px", borderRadius: tk.rSm,
      border: `0.5px solid ${tk.line3}`, background: tk.bg, color: tk.label, font: tk.font, outlineOffset: "1px",
    },
    inputLocked: { background: tk.well, color: tk.label3 },
    textarea: { minHeight: "180px", resize: "vertical" },
    fieldError: { margin: 0, font: tk.fontSmall, color: tk.error },
    fieldWarn: { margin: 0, font: tk.fontSmall, color: tk.label2 },
    editor: { display: "flex", flexDirection: "column", gap: "12px", padding: "14px", borderRadius: tk.rSm, background: tk.well, border: `0.5px solid ${tk.line2}` },
    fieldGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" },

    // 规则页三面：列表 / 详情 / 编辑。窄屏时两列自动折成上下两行。
    ruleLayout: { display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" },
    ruleNav: { flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: "8px" },
    rulePane: { flex: "2 1 320px", minWidth: 0 },
    ruleList: {
      margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column",
      border: `0.5px solid ${tk.line2}`, borderRadius: tk.rSm, overflow: "hidden",
    },
    ruleItem: {
      display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "2px", width: "100%",
      padding: "10px 12px", border: "none", borderTop: `0.5px solid ${tk.line1}`, background: "transparent",
      color: tk.label, font: tk.font, textAlign: "left", cursor: "pointer",
    },
    ruleItemOn: { background: tk.accentSoft },
    helpBox: {
      display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px",
      padding: "10px 12px", borderRadius: tk.rSm, background: tk.well,
    },
    helpBoxTitle: { margin: 0, fontSize: tk.fontLabel, fontWeight: 600, color: tk.label },
    helpBoxList: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", margin: 0, fontSize: tk.fontHelp },
    helpBoxKey: { color: tk.label3 },
    statusFooter: {
      marginTop: "14px", paddingTop: "12px", borderTop: `0.5px solid ${tk.line2}`,
      fontSize: tk.fontMicro, color: tk.label3, display: "flex", alignItems: "center", gap: "6px",
    },

    empty: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px", padding: "16px", borderRadius: tk.rSm, border: `0.5px dashed ${tk.line3}` },
    ol: { margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "4px", color: tk.label2 },

    // 弹窗：正文自己滚动，页脚常驻；::backdrop 与 :modal 见 SCOPED_CSS。
    dialog: {
      padding: 0, width: "min(560px, calc(100vw - 32px))", maxHeight: "85vh", border: `0.5px solid ${tk.line2}`,
      borderRadius: tk.rLg, background: tk.layer1, color: tk.label, font: tk.font,
    },
    dialogInner: { display: "flex", flexDirection: "column", maxHeight: "85vh", minHeight: 0 },
    dialogHead: { display: "flex", alignItems: "flex-start", gap: "12px", padding: "16px 18px 12px", borderBottom: `0.5px solid ${tk.line1}`, flex: "none" },
    dialogTitle: { margin: 0, font: tk.fontStrong, color: tk.label, flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" },
    dialogBody: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 18px", overflowY: "auto", minHeight: 0 },
    dialogFoot: {
      display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap",
      padding: "12px 18px", borderTop: `0.5px solid ${tk.line1}`, background: tk.well, flex: "none",
    },
    dialogNote: { margin: 0, font: tk.fontSmall, color: tk.label3, flex: "1 1 160px", minWidth: 0 },
    pair: {
      display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", alignItems: "center",
      gap: "8px", padding: "8px 10px", borderRadius: tk.rSm, background: tk.well, font: tk.fontSmall,
    },
    pairCell: { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap", color: tk.label },

    // 词库页：左列表右预览，窄屏折成一列（flex 换行，不靠媒体查询）。
    wordLayout: { display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" },
    wordMain: { flex: "2 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: "12px" },
    wordAside: { flex: "1 1 260px", minWidth: 0 },
    wordToolbar: { display: "flex", alignItems: "center", gap: "8px" },
    wordSearchWrap: { position: "relative", flex: "1 1 auto", minWidth: 0 },
    wordSearch: { paddingLeft: "28px", paddingRight: "30px" },
    wordSearchIcon: { position: "absolute", left: "8px", top: "8px", color: tk.label3, font: tk.fontSmall, pointerEvents: "none" },
    wordSearchClear: { position: "absolute", right: "2px", top: "2px" },
    wordList: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", border: `0.5px solid ${tk.line2}`, borderRadius: tk.rSm, overflow: "hidden" },
    wordHead: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", fontSize: tk.fontHelp, color: tk.label3 },
    wordRow: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderTop: `0.5px solid ${tk.line1}`, flexWrap: "wrap" },
    wordRowFirst: { borderTop: "none" },
    wordCells: { flex: "1 1 240px", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", gap: "8px", alignItems: "center" },
    wordCell: { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap", font: tk.fontSmall, color: tk.label },
    wordActions: { display: "flex", alignItems: "center", gap: "2px", flexShrink: 0 },
    wordStale: { opacity: 0.65 },
    wordPreviewBox: {
      margin: 0, padding: "10px 12px", borderRadius: tk.rSm, background: tk.well, border: `0.5px solid ${tk.line2}`,
      font: tk.fontSmall, color: tk.label, whiteSpace: "pre-wrap", overflowWrap: "anywhere", minHeight: "84px",
    },
    wordChips: { display: "flex", flexDirection: "column", gap: "4px" },
    wordChip: { padding: "4px 8px", borderRadius: tk.rXs, background: tk.accentSoft, color: tk.accent, font: tk.fontSmall, overflowWrap: "anywhere" },
    wordCounter: { font: tk.fontSmall, color: tk.caption, whiteSpace: "nowrap" },
    wordEditorFields: { display: "flex", flexDirection: "column", gap: "12px" },

    // Dialog 增强
    dialogIcon: {
      display: "grid", placeItems: "center", width: "32px", height: "32px",
      borderRadius: tk.rSm, background: tk.accentSoft, color: tk.accent, flexShrink: 0,
    },
    dialogIconDanger: { background: tk.errorSoft, color: tk.error },
    consequence: {
      display: "flex", alignItems: "flex-start", gap: "8px", margin: "4px 0 0",
      fontSize: tk.fontHelp, fontWeight: 600,
    },
    consequenceDanger: { color: tk.error },
    consequenceOk: { color: tk.ok },
    ackLabel: {
      display: "flex", alignItems: "flex-start", gap: "10px", margin: "4px 0 0",
      padding: "10px 12px", border: `1px solid ${tk.warn}`, background: tk.warnSoft,
      borderRadius: tk.rSm, fontSize: tk.fontLabel, cursor: "pointer",
    },
    ackDanger: { border: `1px solid ${tk.error}`, background: tk.errorSoft },
    ackChecked: { border: `1px solid ${tk.ok}`, background: tk.okSoft },
    ackInput: { margin: "3px 0 0", width: "15px", height: "15px", flexShrink: 0 },
    ackText: { color: tk.label, lineHeight: 1.4 },
    confirmWordBox: { display: "flex", flexDirection: "column", gap: "6px", margin: "4px 0 0" },
    confirmWordLabel: { fontSize: tk.fontHelp, color: tk.label2 },
    confirmWordTarget: { fontFamily: tk.mono, color: tk.error, padding: "0 4px", background: tk.errorSoft, borderRadius: tk.rXs },
    confirmWordInput: { maxWidth: "260px", fontFamily: tk.mono },
    // 成功说明块：弹窗内告诉用户「成功长什么样」或「可以撤销」的绿框。
    successSign: {
      display: "flex", flexDirection: "column", gap: "2px", margin: "4px 0 0",
      padding: "10px 12px", border: `1px solid ${tk.okLine}`, background: tk.okSoft,
      borderRadius: tk.rSm, fontSize: tk.fontHelp, color: tk.label2,
    },
    successSignTitle: { color: tk.ok, fontSize: tk.fontHelp },

    // StateBlock 居中四态
    stateBlock: {
      display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center",
      gap: "8px", padding: "40px 24px 36px", borderRadius: tk.rMd, background: tk.layer1,
      border: `1px solid ${tk.line2}`,
    },
    stateEmpty: { border: `1px dashed ${tk.line3}`, background: "transparent" },
    stateWarn: { border: `1px solid ${tk.warn}`, background: tk.warnSoft },
    stateError: { border: `1px solid ${tk.error}`, background: tk.errorSoft },
    stateLoading: { border: `1px solid ${tk.accent}`, background: tk.accentSoft },
    stateCompact: { padding: "20px 16px", border: "none", background: "transparent" },
    stateIcon: {
      width: "48px", height: "48px", borderRadius: tk.rMd, display: "grid", placeItems: "center",
      background: tk.accentSoft, color: tk.accent, marginBottom: "4px",
    },
    stateIconError: { background: tk.errorSoft, color: tk.error },
    stateIconWarn: { background: tk.warnSoft, color: tk.warn },
    stateTitle: { margin: 0, fontSize: tk.fontSection, fontWeight: 650, color: tk.label },
    stateBody: { margin: 0, fontSize: tk.font, color: tk.label2, maxWidth: "46ch" },
    stateActions: { display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap", marginTop: "12px" },
    stateExtra: { width: "100%", maxWidth: "520px", textAlign: "left", marginTop: "14px" },

    // Notice 左右分栏升级
    noticeBox: {
      display: "flex", alignItems: "flex-start", gap: "12px", padding: "12px 14px",
      borderRadius: tk.rSm, background: tk.well, border: `0.5px solid ${tk.line2}`,
      borderLeft: `3px solid ${tk.line4}`,
    },
    noticeInfo: { borderLeft: `3px solid ${tk.accent}`, background: tk.accentSoft },
    noticeWarn: { borderLeft: `3px solid ${tk.warn}`, background: tk.warnSoft },
    noticeError: { borderLeft: `3px solid ${tk.error}`, background: tk.errorSoft },
    noticeSuccess: { borderLeft: `3px solid ${tk.ok}`, background: tk.okSoft },
    noticeLoading: { borderLeft: `3px solid ${tk.accent}`, background: tk.accentSoft },
    noticeIconBox: {
      width: "26px", height: "26px", borderRadius: "50%", display: "grid", placeItems: "center",
      flexShrink: 0, background: tk.layer1, border: `0.5px solid ${tk.line2}`,
    },
    noticeGrow: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: "4px" },
    noticeHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
    noticeTitle: { margin: 0, font: tk.fontStrong, lineHeight: "24px" },
    noticeBodyText: { margin: 0, font: tk.fontSmall, color: tk.label2 },
    noticeDataCenter: { display: "inline-flex", alignItems: "center", gap: "6px", margin: "4px 0 0", font: tk.fontSmall, color: tk.label },
    noticeDataLeft: { display: "inline-flex", alignItems: "center", gap: "6px", margin: "4px 0 0", font: tk.fontSmall, color: tk.label },
    noticeActionRow: { display: "flex", alignItems: "center", gap: "8px", marginTop: "6px" },

    // Term
    term: {
      borderBottom: `1px dashed ${tk.line4}`, cursor: "help", position: "relative",
      display: "inline", textDecoration: "none", outlineOffset: "2px",
    },
    spinner: {
      display: "inline-block", width: "18px", height: "18px", border: `2px solid ${tk.accent}`,
      borderRightColor: "transparent", borderRadius: "50%", animation: "bkl-spin 0.8s linear infinite",
    },
    spinnerSm: {
      display: "inline-block", width: "13px", height: "13px", border: `2px solid currentColor`,
      borderRightColor: "transparent", borderRadius: "50%", animation: "bkl-spin 0.8s linear infinite",
    },

    // 底部 toast：fixed 相对视口，宿主设置面板内也落屏幕底部居中。
    // 模态 <dialog> 在 top layer，z-index 盖不过它；当前弹窗内没有复制入口，
    // 弹窗内若要加复制反馈，需把 toast 渲染进弹窗或改用 Notice。
    toast: {
      position: "fixed", bottom: "25px", left: "50%", transform: "translateX(-50%)", zIndex: 40,
      display: "flex", alignItems: "center", gap: "10px",
      maxWidth: "min(560px, calc(100vw - 32px))", padding: "10px 18px 10px 12px",
      borderRadius: tk.rMd, background: tk.tooltipBg, color: tk.tooltipText,
      boxShadow: tk.shadowPop, font: tk.font,
    },
    toastText: { minWidth: 0, overflowWrap: "anywhere" },
    srOnly: {
      position: "absolute", width: "1px", height: "1px", margin: "-1px", padding: 0,
      overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
    },
  }

  // 只放伪类与动效：内联样式做不到 :hover / :focus-visible / 减弱动态。背景类
  // 规则带 !important，是因为内联样式的优先级高于样式表。焦点环沿用宿主
  // ui-theme/focus.css 的写法，指针操作时宿主会把 --dsw-focus-ring-color 置成透明。
  const SCOPED_CSS = [
    ".bkl-root :focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }",
    // 弹窗的遮罩只能走样式表：内联样式写不出 ::backdrop。
    ".bkl-root .bkl-dialog::backdrop { background: color-mix(in srgb, #000 48%, transparent); }",
    ".bkl-root .bkl-dialog[open] { animation: bkl-pop 160ms cubic-bezier(0.16, 1, 0.3, 1); }",
    ".bkl-root .bkl-btn, .bkl-root .bkl-tab, .bkl-root .bkl-hover, .bkl-root .bkl-radio, .bkl-root .bkl-switch { transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease, box-shadow 120ms ease; }",
    ".bkl-root .bkl-btn-plain:not([aria-disabled=\"true\"]):hover, .bkl-root .bkl-hover:hover { background-color: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)) !important; }",
    ".bkl-root .bkl-btn-fill:not([aria-disabled=\"true\"]):hover { opacity: 0.90; filter: brightness(1.05); }",
    ".bkl-root .bkl-btn-link:not([aria-disabled=\"true\"]):hover { text-decoration: underline; text-underline-offset: 3px; }",
    ".bkl-root .bkl-btn-icon:not([aria-disabled=\"true\"]):hover { background-color: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)) !important; color: var(--dsw-alias-label-primary) !important; }",
    ".bkl-root .bkl-btn-icon.bkl-word-del:not([aria-disabled=\"true\"]):hover { color: var(--dsw-alias-state-error-primary) !important; }",
    ".bkl-root .bkl-tab:hover { color: var(--dsw-alias-label-primary) !important; }",
    ".bkl-root .bkl-radio:not([aria-checked=\"true\"]):hover { border-color: var(--dsw-alias-border-l4) !important; }",
    ".bkl-root .bkl-knob { transition: transform 120ms ease; }",
    ".bkl-root .bkl-input:focus { border-color: var(--dsw-alias-state-business-primary) !important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent); outline: none; }",
    ".bkl-root .bkl-input[aria-invalid=\"true\"] { border-color: var(--dsw-alias-state-error-primary) !important; background-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }",
    ".bkl-root .bkl-input[aria-invalid=\"true\"]:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent); }",
    ".bkl-root .bkl-input::placeholder { color: var(--dsw-alias-label-caption); }",
    // 术语 Tooltip
    ".bkl-root .bkl-term { border-bottom: 1px dashed var(--dsw-alias-label-tertiary); cursor: help; position: relative; display: inline; text-decoration: none; }",
    ".bkl-root .bkl-term:hover::after, .bkl-root .bkl-term:focus-visible::after { content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); width: max-content; max-width: min(280px, 72vw); padding: 8px 12px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-inverse, var(--dsw-alias-label-primary)); color: var(--dsw-alias-label-inverse, var(--dsw-alias-bg-base)); font: var(--dsw-font-xxs-12, 12px/1.55 var(--dsw-font-mono, sans-serif)); font-weight: 400; letter-spacing: 0; white-space: normal; text-align: left; text-transform: none; word-break: break-word; z-index: 60; box-shadow: 0 16px 48px color-mix(in srgb, #000 35%, transparent); pointer-events: none; animation: bkl-fade 120ms ease-out; }",
    "html[data-guide=\"off\"] .bkl-root .bkl-term { border-bottom: none; cursor: inherit; }",
    "html[data-guide=\"off\"] .bkl-root .bkl-term::after { display: none !important; }",
    // 居中状态块
    ".bkl-root .bkl-state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 40px 24px; border-radius: var(--dsw-radius-lg, 12px); border: 1px dashed var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); }",
    ".bkl-root .bkl-state.error { border-style: solid; border-color: var(--dsw-alias-state-error-secondary, color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent)); background: linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent), var(--dsw-alias-bg-layer-1) 75%); }",
    ".bkl-root .bkl-state.warn { border-style: solid; border-color: var(--dsw-alias-state-warn-secondary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, transparent)); background: linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent), var(--dsw-alias-bg-layer-1) 75%); }",
    ".bkl-root .bkl-state.loading { border-style: solid; border-color: var(--dsw-alias-state-business-secondary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent)); background: linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent), var(--dsw-alias-bg-layer-1) 75%); }",
    // 页面提示条 (PageTip)
    ".bkl-root .bkl-tip { display: flex; align-items: flex-start; gap: 11px; padding: 11px 12px 11px 14px; margin-bottom: 4px; border: 1px dashed var(--dsw-alias-border-l3, #cbd5e1); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); font-size: 13px; color: var(--dsw-alias-label-secondary); }",
    ".bkl-root .bkl-tip-icon { color: var(--dsw-alias-state-business-primary, #3b82f6); margin-top: 2px; flex-shrink: 0; }",
    ".bkl-root .bkl-tip-content { flex: 1 1 auto; min-width: 0; }",
    ".bkl-root .bkl-tip-lead { color: var(--dsw-alias-label-primary); font-weight: 600; margin-right: 6px; }",
    ".bkl-root .bkl-tip-pitfall { display: block; margin-top: 3px; color: var(--dsw-alias-label-caption); font-size: 12px; }",
    ".bkl-root .bkl-tip-close { margin: -3px -4px -3px 0; padding: 4px; background: transparent; border: none; cursor: pointer; color: var(--dsw-alias-label-caption); border-radius: 4px; }",
    ".bkl-root .bkl-tip-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)); }",
    "html[data-guide=\"off\"] .bkl-root .bkl-tip { display: none !important; }",
    // 动画
    ".bkl-root .bkl-fade { animation: bkl-fade 160ms ease-out; }",
    ".bkl-root .bkl-pop { animation: bkl-pop 160ms cubic-bezier(0.16, 1, 0.3, 1); }",
    "@keyframes bkl-fade { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }",
    "@keyframes bkl-pop { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }",
    "@keyframes bkl-spin { to { transform: rotate(360deg); } }",
    "@media (prefers-reduced-motion: reduce) { .bkl-root *, .bkl-root *::before, .bkl-root *::after { animation: none !important; transition: none !important; } }",

    // ---- 阶段三样式 --------------------------------------------------------
    // 4 阶段进度流
    ".bkl-root .bkl-flow { list-style: none; margin: 0 0 24px; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }",
    ".bkl-root .bkl-flow li { --tone: var(--dsw-alias-border-l2); padding: 10px 12px 0; border-top: 3px solid var(--tone); display: flex; gap: 9px; align-items: flex-start; min-width: 0; }",
    ".bkl-root .bkl-flow .bkl-flow-num { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; flex: none; border: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-1); }",
    ".bkl-root .bkl-flow .bkl-flow-num svg { width: 13px; height: 13px; stroke-width: 2.4; }",
    ".bkl-root .bkl-flow strong { display: block; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); line-height: 22px; }",
    ".bkl-root .bkl-flow span.bkl-sub { display: block; font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }",
    ".bkl-root .bkl-flow li.done { --tone: var(--dsw-alias-state-success-primary); }",
    ".bkl-root .bkl-flow li.done .bkl-flow-num { background: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary-foreground, #ffffff); }",
    ".bkl-root .bkl-flow li.current { --tone: var(--dsw-alias-state-business-primary); }",
    ".bkl-root .bkl-flow li.current .bkl-flow-num { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)); box-shadow: 0 0 0 3px var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent)); }",
    ".bkl-root .bkl-flow li.current strong { color: var(--dsw-alias-label-primary); }",
    ".bkl-root .bkl-flow li.blocked { --tone: var(--dsw-alias-state-error-primary); }",
    ".bkl-root .bkl-flow li.blocked .bkl-flow-num { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }",
    ".bkl-root .bkl-flow li.blocked strong, .bkl-root .bkl-flow li.blocked span.bkl-sub { color: var(--dsw-alias-state-error-primary); }",
    ".bkl-root .bkl-flow li.todo { --tone: var(--dsw-alias-border-l2); }",
    ".bkl-root .bkl-flow li.todo strong { color: var(--dsw-alias-label-tertiary); }",
    "@media (max-width: 640px) { .bkl-root .bkl-flow { grid-template-columns: repeat(2, minmax(0, 1fr)); } }",

    // 响应式双栏网格
    ".bkl-root .bkl-columns { display: grid; grid-template-columns: minmax(0, 1fr) 290px; gap: 24px; align-items: start; }",
    "@media (max-width: 840px) { .bkl-root .bkl-columns { grid-template-columns: minmax(0, 1fr); } }",

    // 三步引导（Guide）：展开态进度 + 步骤行；关闭态是 link 按钮，无需样式。
    ".bkl-root .bkl-guide { padding: 4px 20px; }",
    ".bkl-root .bkl-guide-title { padding: 14px 0 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }",
    ".bkl-root .bkl-guide-title h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }",
    ".bkl-root .bkl-guide-progress { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }",
    ".bkl-root .bkl-guide-bar { width: 72px; height: 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; }",
    ".bkl-root .bkl-guide-bar span { display: block; height: 100%; background: var(--dsw-alias-state-success-primary); border-radius: 5px; }",
    ".bkl-root .bkl-guide-item { display: flex; align-items: flex-start; gap: 12px; padding: 14px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }",
    ".bkl-root .bkl-guide-item.is-current { margin: 0 -20px; padding-inline: 20px; background: var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)); border-top-color: var(--dsw-alias-state-business-secondary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent)); }",
    ".bkl-root .bkl-step-num { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--dsw-alias-border-l4); border-radius: 50%; font-size: 11px; font-weight: 700; flex: none; margin-top: 1px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-1); }",
    ".bkl-root .bkl-step-num svg { width: 13px; height: 13px; }",
    ".bkl-root .bkl-step-num.done { border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary-foreground, #ffffff); }",
    ".bkl-root .bkl-step-num.current { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }",
    ".bkl-root .bkl-guide-item strong { display: block; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }",
    ".bkl-root .bkl-guide-item p { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin: 2px 0 0; }",
    ".bkl-root .bkl-guide-item .bkl-btn-link { margin-left: auto; flex: none; align-self: center; font-size: 12px; }",

    // 主行动卡片
    ".bkl-root .bkl-action-card { --tone: var(--dsw-alias-state-business-primary); --toneSoft: var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)); --toneLine: var(--dsw-alias-state-business-secondary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent)); padding: 24px 26px; border: 1px solid var(--toneLine); border-radius: var(--dsw-radius-lg, 12px); position: relative; overflow: hidden; background: linear-gradient(160deg, var(--toneSoft), var(--dsw-alias-bg-layer-1) 62%); }",
    ".bkl-root .bkl-action-card::before { content: \"\"; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--tone); }",
    ".bkl-root .bkl-action-card.warn { --tone: var(--dsw-alias-state-warn-primary); --toneSoft: var(--dsw-alias-state-warn-tertiary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)); --toneLine: var(--dsw-alias-state-warn-secondary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, transparent)); }",
    ".bkl-root .bkl-action-card.error { --tone: var(--dsw-alias-state-error-primary); --toneSoft: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); --toneLine: var(--dsw-alias-state-error-secondary, color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent)); }",
    ".bkl-root .bkl-action-card.ok { --tone: var(--dsw-alias-state-success-primary); --toneSoft: var(--dsw-alias-state-success-tertiary, color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)); --toneLine: var(--dsw-alias-state-success-secondary, color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, transparent)); }",
    ".bkl-root .bkl-action-eyebrow { display: flex; align-items: center; gap: 8px; color: var(--tone); font-size: 12px; font-weight: 650; }",
    ".bkl-root .bkl-action-eyebrow .bkl-icon-wrap { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 0 0 1px var(--toneLine); flex-shrink: 0; }",
    ".bkl-root .bkl-action-card h2 { font-size: 20px; margin: 12px 0 6px; letter-spacing: -0.3px; font-weight: 650; color: var(--dsw-alias-label-primary); }",
    ".bkl-root .bkl-action-card p { font-size: 13px; color: var(--dsw-alias-label-secondary); max-width: 60ch; line-height: 1.6; margin: 0; }",
    ".bkl-root .bkl-action-card .bkl-action-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 20px; }",

    // 核心配置清单
    ".bkl-root .bkl-summary-list { display: flex; flex-direction: column; }",
    ".bkl-root .bkl-summary-row { display: flex; align-items: flex-start; gap: 14px; padding: 14px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }",
    ".bkl-root .bkl-summary-row:last-child { border-bottom: none; padding-bottom: 0; }",
    ".bkl-root .bkl-summary-row:first-child { padding-top: 0; }",
    ".bkl-root .bkl-summary-icon { color: var(--dsw-alias-label-tertiary); margin-top: 2px; flex-shrink: 0; }",
    ".bkl-root .bkl-summary-content { flex: 1 1 auto; min-width: 0; }",
    ".bkl-root .bkl-summary-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-bottom: 1px; }",
    ".bkl-root .bkl-summary-row strong { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }",
    ".bkl-root .bkl-summary-row p { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }",

    // 环境权限卡片
    ".bkl-root .bkl-status-lines { font-size: 12px; display: grid; gap: 12px; }",
    ".bkl-root .bkl-status-lines > div { display: flex; align-items: center; gap: 8px; justify-content: space-between; }",
    ".bkl-root .bkl-status-lines .bkl-status-key { color: var(--dsw-alias-label-secondary); font-weight: 550; }",

    // 补丁统一外壳与行样式
    ".bkl-root .bkl-patch-list { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); overflow: clip; background: var(--dsw-alias-bg-layer-1); }",
    ".bkl-root .bkl-patch-row { padding: 14px 20px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); position: relative; transition: background 120ms ease; }",
    ".bkl-root .bkl-patch-row:last-child { border-bottom: none; }",
    ".bkl-root .bkl-patch-row.selected { background: linear-gradient(90deg, var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)), var(--dsw-alias-bg-layer-1) 28%); }",
    ".bkl-root .bkl-patch-row.selected::before { content: \"\"; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--dsw-alias-state-business-primary); }",
    ".bkl-root .bkl-patch-row.inactive { background: var(--dsw-alias-bg-layer-2, color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent)); opacity: 0.72; }",
    ".bkl-root .bkl-patch-row.inactive h3, .bkl-root .bkl-patch-row.inactive p { color: var(--dsw-alias-label-tertiary); }",
    ".bkl-root .bkl-patch-icon { padding: 8px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }",
    ".bkl-root .bkl-patch-row.selected .bkl-patch-icon { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-state-business-secondary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent)); }",

    // 悬浮固定底部操作栏
    ".bkl-root .bkl-sticky-footer { position: sticky; bottom: 0; z-index: 10; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); border-top: 0.5px solid var(--dsw-alias-border-l2); box-shadow: 0 -8px 20px -12px color-mix(in srgb, #000 25%, transparent); margin-top: 24px; border-radius: 0 0 var(--dsw-radius-md, 8px) var(--dsw-radius-md, 8px); }",
    ".bkl-root .bkl-foot-copy { flex: 1 1 180px; min-width: 180px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }",
    ".bkl-root .bkl-foot-copy strong { display: block; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }",
    ".bkl-root .bkl-foot-copy.blocked strong { color: var(--dsw-alias-state-error-primary); }",
    ".bkl-root .bkl-foot-reason { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }",

    // 补丁分界标题与折叠清单
    ".bkl-root .bkl-section-label { font-size: 13px; color: var(--dsw-alias-label-primary); font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 18px 0 10px; }",
    ".bkl-root .bkl-section-label > span:last-child { font-size: 12px; color: var(--dsw-alias-label-tertiary); font-weight: 400; }",
    ".bkl-root details.bkl-disclosure { border-top: 0.5px solid var(--dsw-alias-border-l2); margin-top: 14px; padding-top: 10px; font-size: 12px; }",
    ".bkl-root details.bkl-disclosure summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-weight: 550; user-select: none; }",
    ".bkl-root details.bkl-disclosure summary:hover { color: var(--dsw-alias-label-primary); }",
    ".bkl-root .bkl-file-list { list-style: none; padding: 0; margin: 10px 0; display: grid; gap: 6px; }",
    ".bkl-root .bkl-file-list li { display: flex; gap: 8px; align-items: flex-start; font-family: var(--dsw-font-mono, monospace); font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; background: var(--dsw-alias-bg-layer-2, #f7f8fa); border: 1px solid var(--dsw-alias-border-l2, #e1e5eb); border-radius: 6px; padding: 6px 9px; }",

    // ---- 阶段四样式 --------------------------------------------------------
    // 模式网格与模式卡片
    ".bkl-root .mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-bottom: 12px; }",
    "@media (max-width: 640px) { .bkl-root .mode-grid { grid-template-columns: minmax(0, 1fr); } }",
    ".bkl-root .mode-card { border: 1.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); padding: 16px; background: var(--dsw-alias-bg-layer-1); cursor: pointer; display: flex; flex-direction: column; gap: 8px; position: relative; transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease; text-align: left; }",
    ".bkl-root .mode-card:hover { border-color: var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-2); }",
    ".bkl-root .mode-card.selected { border-color: var(--dsw-alias-state-business-primary); background: linear-gradient(170deg, var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent)), var(--dsw-alias-bg-layer-1) 50%); box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary); }",
    ".bkl-root .mode-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
    ".bkl-root .mode-title { font-size: 14px; font-weight: 650; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 6px; }",
    ".bkl-root .tradeoff { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.55; display: flex; flex-direction: column; gap: 4px; }",
    ".bkl-root .tradeoff-good { color: var(--dsw-alias-label-secondary); }",
    ".bkl-root .tradeoff-cost { color: var(--dsw-alias-label-caption); }",
    ".bkl-root .mode-budget { margin-top: auto; padding-top: 8px; border-top: 0.5px dashed var(--dsw-alias-border-l2); font-size: 11px; font-family: var(--dsw-font-mono, monospace); color: var(--dsw-alias-label-tertiary); display: flex; align-items: center; gap: 6px; }",
    ".bkl-root .mode-card.selected .mode-budget { color: var(--dsw-alias-state-business-primary); }",

    // 模式横向对比表
    ".bkl-root .compare { width: 100%; border-collapse: collapse; font-size: 12px; margin: 12px 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); overflow: hidden; }",
    ".bkl-root .compare th, .bkl-root .compare td { padding: 9px 12px; text-align: left; border-bottom: 0.5px solid var(--dsw-alias-border-l2); border-right: 0.5px solid var(--dsw-alias-border-l2); }",
    ".bkl-root .compare th:last-child, .bkl-root .compare td:last-child { border-right: none; }",
    ".bkl-root .compare tr:last-child td { border-bottom: none; }",
    ".bkl-root .compare th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; color: var(--dsw-alias-label-primary); }",
    ".bkl-root .compare td { color: var(--dsw-alias-label-secondary); }",
    ".bkl-root .compare td.col-target { font-weight: 600; color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent)); }",

    // Prompt 编辑器脏状态
    ".bkl-root .editor-card.dirty { border-color: var(--dsw-alias-state-warn-secondary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)) !important; box-shadow: 0 0 0 1px var(--dsw-alias-state-warn-secondary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, transparent)); }",
    ".bkl-root .editor-card.dirty .bkl-card-head { box-shadow: inset 3px 0 0 var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-state-warn-tertiary, color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)); }",
  ].join("\n")

  const TEXT = {
    zh: {
      nav: "破限",
      title: "破限",
      lead: "调宽宿主过紧的限制、切换提示词档位、管理写给模型的长期规则。",
      tabsLabel: "破限设置",
      tabOverview: "概览",
      tabPatches: "补丁",
      tabPrompt: "提示词",
      tabRules: "规则",
      tabWords: "词库",
      // 每页顶部：标题、一句说明、生效时机。生效标签在标题旁，回答「我改完什么时候有用」。
      pageOverviewTitle: "从这里开始",
      pageOverviewDesc: "先看当前状态，再完成需要做的那一步。",
      pagePatchesTitle: "选择你需要的改动",
      pagePatchesDesc: "先挑选，再统一应用。关闭开关会保留已写入的源码改动。",
      pagePromptTitle: "让模型按你的方式协作",
      pagePromptDesc: "选择附加指令模式，或编辑两档共用的正文。",
      pageRulesTitle: "管理长期规则",
      pageRulesDesc: "保存是存下来；激活才会写入指令文件。同一时间激活一条。",
      pageWordsTitle: "管理目标词",
      pageWordsDesc: "消息交给模型前，把原词换成替换词。保存后新开会话生效。",
      // 阶段二新增：新手提示系统（PageTips）与页面描述分段
      pageTipRegionLabel: "页面提示",
      pageTipHeading: "这页做什么",
      pageTipDismiss: "收起这条提示",
      tipOverviewText: "这页告诉你现在卡在哪一步。",
      tipOverviewPitfall: "常见误区：卡片提示差一步时，照着最上方的主操作卡片执行即可，无需盲目重启或重复应用。",
      tipPatchesText: "先打开需要的开关，再点右下角「检查并应用」才会真正改文件。",
      tipPatchesPitfall: "常见误区：关掉开关不等于撤销，已写入的改动要用「回退」恢复。",
      tipPromptText: "模式决定附加约束的松紧，正文是两档共用的附加指令。",
      tipPromptPitfall: "常见误区：推荐模式不会降低实际执行权限，权限由宿主沙箱决定。",
      tipRulesText: "规则先「保存」，再「激活」才会写进指令文件。同一时间只激活一条。",
      tipRulesPitfall: "常见误区：保存后没激活，模型是读不到的。",
      tipWordsText: "消息交给模型前，把原词换成替换词。右侧可以先试效果。",
      tipWordsPitfall: "常见误区：保存后要新开会话，当前会话不会回头替换。",
      patchesHeadPrefix: "先挑选，再统一应用。每条",
      patchesHeadMid: "都会改",
      patchesHeadSuffix: "源码；关闭开关不会撤销已写入的改动。",
      promptHeadPrefix: "选择附加指令模式，或编辑两档",
      promptHeadSuffix: "。",
      rulesHeadPrefix: "保存是存下来；",
      rulesHeadMid: "才会写入",
      rulesHeadSuffix: "。同一时间激活一条。",
      whenTag: (label) => `生效：${String(label)}`,
      whenRestart: "重启宿主后",
      whenNextTurn: "下一轮对话",
      whenActivate: "激活后写入",
      whenNewSession: "新开会话",
      refresh: "刷新",
      refreshedAt: (s) => `更新于${String(s)}`,
      agoJust: "刚刚",
      agoMin: (n) => `${String(n)} 分钟前`,
      agoHour: (n) => `${String(n)} 小时前`,
      loading: "正在读取插件状态…",
      loadingHint: "通常一两秒。如果一直停在这里，点右上角的「刷新」。",
      retry: "重试",
      recheck: "重新检查",
      dismiss: "关闭这条提示",
      dismissShort: "关闭",
      cancel: "取消",
      working: "处理中…",
      saving: "正在保存…",
      copied: "已复制到剪贴板",
      copyFailed: "没能复制",
      copyFailedNext: "浏览器不允许访问剪贴板，请手动选中上面的文字复制。",
      copyCommand: "复制这行命令",
      errorCode: (c) => `错误代码 ${String(c)}`,
      andMore: (n) => `以及另外 ${String(n)} 个`,
      unknown: "未知",
      sep: "：",
      bytes: (n) => `${String(n)} 字节`,
      timeUnknown: "时间未知",

      goOverview: "回到概览",
      goPatches: "打开补丁页",
      goPatchesSee: "去补丁页看是哪几处",
      goPatchesPick: "去挑选补丁",
      goPatchesApply: "去补丁页应用",
      goPrompt: "去提示词页",
      goRules: "去规则页",
      goWords: "去词库页",

      nextStep: "下一步",
      nsRulesCorruptTitle: "规则清单读不出来",
      nsRulesCorruptBody: (path) => `规则清单文件（$DSH_HOME/${String(path)}）无法读取或版本不符，插件已停止写入以保护原数据。已有的正文文件完好保留在 $DSH_HOME/breaklimit/bodies/ 目录中。你可以备份原清单并重置为空清单重新开始。`,
      recoverRules: "备份并重置清单",
      confirmRecoverRulesTitle: "确认备份并重置规则清单？",
      confirmRecoverRulesBody: "会将当前的损坏清单复制备份到 dsh-breaklimit-backup 目录下，并初始化一份空的规则清单。之前的正文文件仍在 bodies/ 中，重新创建同名规则会覆盖它们。",
      confirmRecoverRulesYes: "备份并重置",
      doneRecoverRules: "规则清单已重置",
      doneRecoverRulesNext: (path) => `原损坏清单已备份至 $DSH_HOME/${String(path)}。正文文件仍在 $DSH_HOME/breaklimit/bodies/ 目录下。`,
      nsBrokenTitle: "上次的应用记录读不出来",
      nsBrokenBody: "为了不把宿主改乱，插件暂停了应用和回退。不要反复点按钮；按安装说明里「回退与卸载」一节处理 DSH 数据目录下的 breaklimit 文件夹，再回来点「重新检查」。",
      nsRootTitle: "先告诉插件宿主源码在哪",
      nsRootBody: "插件要改的是 DeepSeek Harness 源码里的几个文件，但现在不知道它放在哪。在启动宿主的 PowerShell 窗口里先运行下面这行（换成你自己的目录），再重启宿主。",
      nsRootSnippet: "$env:DSH_BREAKLIMIT_HOST_ROOT = 'D:\\你的目录\\deepseek-harness'",
      nsLockTitle: "另一个操作正在进行",
      nsLockBody: "可能是别的窗口或命令行正在应用、回退补丁。等它结束后点「重新检查」。",
      nsBlockedTitle: (n) => `宿主里有 ${String(n)} 处和补丁预期对不上`,
      nsBlockedBody: "这种情况下插件一个文件都不会写，宿主是安全的。最常见的原因是宿主版本不对，或源码被手动改过。",
      nsNoneTitle: "所有补丁都关着",
      nsNoneBody: "现在应用不会写任何东西。去补丁页打开你需要的几条；以前写入过的内容不会因此撤掉，要撤掉请用「回退」。",
      nsPendingTitle: (n) => `还有 ${String(n)} 个文件等着写入`,
      nsPendingBody: "你选好的补丁还没写进宿主。去补丁页确认一遍，再点「应用」。",
      nsDoneTitle: "补丁已就位",
      nsDoneBody: "宿主文件已经是补丁后的样子。如果是刚刚才应用的，记得确认宿主已经重启过。",

      stepsTitle: "三步走完",
      stepsDesc: "按顺序来，点任意一步可以直接跳过去。",
      step1Title: "选提示词模式",
      step1Desc: "决定模型拿到哪一档附加指令，随时可换。",
      step2Title: "挑补丁",
      step2Desc: "打开想要的改动。拨开关不会改任何文件。",
      step3Title: "应用并重启宿主",
      step3Desc: "写进宿主源码之后，要重启宿主才生效。",
      stepState: (s) => (s === "done" ? "已完成" : s === "error" ? "有问题" : s === "warn" ? "差一步" : "未完成"),
      pickedOf: (a, b) => `已开 ${String(a)} / 共 ${String(b)} 条`,
      blockedN: (n) => `${String(n)} 处对不上`,
      pendingN: (n) => `待写入 ${String(n)} 个文件`,
      stepBroken: "应用记录损坏",
      stepNoRoot: "未配置宿主目录",
      stepWaitRestart: "已写入，等你重启",
      stepInPlace: "已就位",

      statusTitle: "现在的状态",
      statusDesc: "都是后端此刻读到的真实值。",
      rowHost: "目标宿主",
      rootSource: (s) => (s === "config" ? "来自插件配置" : s === "env" ? "来自环境变量" : s === "derived" ? "由宿主进程推导" : "未配置"),
      rootMissingShort: "还不知道宿主源码在哪",
      rowMode: "提示词模式",
      rowModeHint: "只影响模型拿到的指令与自我约束，不改变宿主执行权限。",
      rowSandbox: "沙箱档位",
      sandboxTakeover: "完全权限（默认）：宿主已自动放行日常命令审批，工具与编辑受插件规则管控。",
      sandboxHost: "这一档下插件不放宽沙箱，审批交还宿主。",
      rowPreflight: "补丁预检",
      preOk: (n) => (Number(n) === 0 ? "通过，没有待写入的文件" : `通过，待写入 ${String(n)} 个文件`),
      preBlocked: (n) => `未通过：${String(n)} 处对不上`,
      preNoRoot: "无法检查：不知道宿主在哪",
      preBroken: "无法检查：应用记录损坏",
      preHint: "预检只读不写，每次刷新都会重做。",
      rowApplied: "应用记录",
      appliedValue: (n, t) => `${String(n)} 个文件 · ${String(t)}`,
      appliedNone: "还没有应用过",
      opId: (id) => `操作编号 ${String(id)}`,
      rowRules: "规则",
      rulesNone: "还没有规则",
      rulesActive: (n, label) => `${String(n)} 条，激活中：${String(label)}`,
      rulesInactive: (n) => `${String(n)} 条，都没有激活`,
      rowPrompt: "共用正文",
      promptMine: (s) => `你的版本 · ${String(s)}`,
      promptBuiltin: "内置正文",
      rowTakeover: "运行时接管",
      takeoverHint: "立即生效，只管这一次运行；重启宿主后回到配置里的值。它不会撤掉已写入的补丁。",
      takeoverLabel: "运行时接管开关",
      takeoverState: (on) => (on ? "开" : "关"),
      doneTakeover: (on) => (on ? "运行时接管已打开" : "运行时接管已关闭"),
      warnTitle: "宿主的审批设置会绕过插件",
      warnPresetNever: (p) => `「${String(p)}」档的审批策略是 never：宿主直接拒绝，插件收不到询问。`,
      warnPolicyNever: "审批默认策略是 never：新会话的审批不会到达插件。",
      warnOther: (c) => `宿主报告了一条权限提示（${String(c)}）。`,
      warnNext: "如果希望插件来处理审批，请在宿主的权限设置里改成 ask。",

      patchesTitle: "补丁",
      patchesLead: "每条补丁只改宿主源码里一处确定的地方。先挑，再一次性应用。",
      legendSwitch: "开关",
      legendSwitchDesc: "下次点「应用」时带不带这一条。拨动它不会改任何文件。",
      legendDisk: "磁盘状态",
      legendDiskDesc: "宿主源码此刻的样子：待写入、已就位，或对不上。",
      patchesSummary: (a, b, n) => `已选 ${String(a)} / ${String(b)} 条 · 全部补丁共涉及 ${String(n)} 个文件`,
      patchesEmptyTitle: "读不到补丁清单",
      kindReplace: "改写",
      kindVerify: "只检查",
      switchOnHint: "下次应用会带上",
      switchOffHint: "下次应用会跳过",
      diskState: (s) => (s === "pending" ? "待写入" : s === "ready" ? "已就位" : s === "blocked" ? "对不上" : s === "skipped" ? "本次不参与" : "暂时无法判断"),
      touchesFiles: (n) => `改 ${String(n)} 个文件`,
      detailsShow: "技术细节",
      detailsHide: "收起细节",
      whyLabel: "为什么要改",
      before: "改前",
      after: "改后",
      offButWritten: "关掉只影响下次应用。以前写进宿主的内容还在，要撤掉请用下面的「回退」。",
      blockedTitle: (n) => `预检没通过：${String(n)} 处对不上`,
      blockedBody: "插件不会写任何文件，宿主保持原样。先确认宿主是 README 写明的版本、源码没被手动改过；仍然不行，就把下面的清单复制给作者。",
      copyList: "复制清单",
      findingState: (s) => (s === "conflict" ? "原文和预期不一致" : s === "applied_other" ? "应用的是上一次声明的版本，需先回退" : s === "unsatisfied" ? "缺少预期的内容" : s === "missing" ? "文件不存在或缺少校验记录" : "判定未通过"),
      apply: "应用",
      applyN: (n) => `应用改动（${String(n)} 个文件）`,
      applyHint: "写之前会先给每个文件做快照；写完要重启宿主才生效。",
      revert: "回退",
      revertHint: (n) => `回退会把上次写入的 ${String(n)} 个文件恢复成原样。`,
      whyBusy: "正在处理上一个操作，稍等。",
      whyToggling: "开关还在保存，等它完成。",
      whyNoRoot: "插件还不知道宿主源码在哪，见概览。",
      whyBroken: "应用记录损坏，插件暂停了写入，见概览。",
      whyLock: "另一个应用或回退正在进行。",
      whyBlocked: (n) => `预检有 ${String(n)} 处对不上，应用会被整体拒绝。`,
      whyNoneSelected: "一条补丁都没开，没有可写的内容。",
      whyNothing: "没有需要写入的文件：选中的补丁都已就位。",
      whyNotApplied: "还没有应用记录，没有可回退的内容。",
      whyRulesCorrupt: "规则清单损坏，已暂停写入，请先备份并重置。",
      rulesCorruptNotice: (path) => `规则清单读不出来（$DSH_HOME/${String(path)}），插件已停止写入以保护原数据。已有的正文文件完好保留在 $DSH_HOME/breaklimit/bodies/ 目录中。`,
      confirmDiscardRuleTitle: "当前有未保存的规则草稿",
      confirmDiscardRuleBody: "离开或切换后，未保存的规则改动将会丢失。确认放弃这些改动吗？",
      confirmDiscardYes: "放弃修改",
      confirmOverwriteRuleTitle: (id) => `确认覆盖规则「${String(id)}」？`,
      confirmOverwriteRuleBody: "规则 ID 已存在。保存将替换原有的规则名称与正文，覆盖后原内容无法恢复。",
      confirmOverwriteRuleYes: "确认覆盖",
      openExistingRule: "打开已有的这条规则",
      confirmApplyTitle: (n) => `确认写入 ${String(n)} 个宿主源码文件？`,
      confirmApplyBody: "会改动下面这些文件。写之前先做快照；只要有一处对不上就整批不写；写完需要重启宿主。之后随时可以用「回退」恢复。",
      confirmApplyYes: (n) => `写入 ${String(n)} 个文件`,
      confirmRevertTitle: (n) => `确认把 ${String(n)} 个文件恢复原样？`,
      confirmRevertBody: "会把上次写入的文件恢复成应用前的内容。只要其中有一个被别的程序改过，就整体取消、磁盘不动。完成后需要重启宿主。",
      confirmRevertYes: (n) => `恢复 ${String(n)} 个文件`,
      doneApplied: (n) => `已写入 ${String(n)} 个文件`,
      doneAppliedNext: "还差一步：重启宿主。",
      doneAlready: "无需写入：全部已就位",
      doneReverted: (n) => `已恢复 ${String(n)} 个文件`,
      doneRevertNothing: "没有需要恢复的文件，应用记录已清除",

      restartTitle: "还差一步：重启宿主",
      restartBodyApply: (n) => `刚才写入了 ${String(n)} 个文件，但正在运行的宿主还在用旧代码。重启之后改动才生效。`,
      restartBodyRevert: (n) => `刚才恢复了 ${String(n)} 个文件，但正在运行的宿主还在用补丁后的代码。重启之后才回到原样。`,
      copyRestart: "复制重启命令",
      restartHow: "怎么重启",
      restartDismiss: "我知道了",
      restartStep1: "回到启动宿主的那个终端窗口，按 Ctrl+C 停止它。",
      restartStep2: "在同一个窗口里重新运行启动命令（就是上面这条）。",
      restartStep3: "重新打开这个设置页，概览里显示「补丁已就位」就成功了。",
      restartCaveat: "插件没法自己重启宿主，也没法判断你是否已经重启过，所以这条提示会一直留着，直到你点「我知道了」。",
      restartCommandLabel: "本次启动宿主用的命令",
      restartNoCommand: "没拿到启动命令，请按你平时的方式启动宿主。",

      modeTitle: "提示词模式",
      modeDesc: "两档共用同一份破限正文；差别只有附加的自我约束和执行层上限。注意：提示词模式仅调整模型的自我约束，不降低宿主执行权限。切换不用重启，从下一轮对话开始生效。",
      modeRecommended: "推荐（常用破限）",
      modeUnrestricted: "完全解放（彻底破限）",
      modeRecommendedShort: "推荐模式",
      modeUnrestrictedShort: "完全解放模式",
      tagDefault: "默认（提示词）",
      tagCurrent: "正在使用",
      tagPending: "待确认",
      modeRecFit: "破限正文照常生效，额外保留三条自我约束：不擅自扩大改动范围、不可逆操作先说后果、交付前给出验证证据。",
      modeRecChange: "执行层按保守值：命令 20 分钟、工具输出 0.5 MB、子命令深度 2。",
      modeUnrFit: "破限正文同样生效，但解除上面三条约束：不自我设限、不给替代方案、不加免责。",
      modeUnrChange: "执行层放开：9999 秒、1 MB、深度 5。",
      confirmModeTitle: (label) => `切换到「${String(label)}」？`,
      confirmModeBody: "从下一轮对话开始生效，不用重启；正在进行的那一轮不受影响。会写 DSH 数据目录里的 breaklimit/tier.json，随时可以切回来。",
      confirmModeYes: "切换",
      doneMode: (label) => `已切换到「${String(label)}」`,
      doneModeNext: "从下一轮对话开始生效。",

      promptTitle: "共用正文",
      promptDesc: "两档模式共用的这段正文放在模型指令的最前面。保存后用你的版本替换内置正文；模式的附加段不受影响。",
      promptUsingMine: (s) => `正在用你的版本 · ${String(s)}`,
      promptUsingBuiltin: "正在用内置正文",
      promptPlaceholder: "在这里写给模型的长期指令…",
      promptCount: (chars, size) => `${String(chars)} 字 · ${String(size)}`,
      promptDirty: "有未保存的改动",
      save: "保存",
      copyAll: "复制全文",
      resetBuiltin: "恢复内置",
      discard: "放弃改动",
      whyNoChange: "没有改动，不用保存。",
      whyEmptyPrompt: "正文是空的。想回到内置正文，请用「恢复内置」。",
      whyAlreadyBuiltin: "现在用的就是内置正文。",
      saveHint: "保存后从下一轮对话开始生效。",
      confirmResetTitle: "删除你的版本，回到内置正文？",
      confirmResetBody: (s) => `你保存的 ${String(s)} 内容会被删除，之后无法找回。建议先点「复制全文」留个备份。`,
      confirmResetYes: "删除并恢复内置",
      donePromptSaved: (s) => `已保存（${String(s)}）`,
      donePromptReset: "已恢复内置正文",
      injectBad: (c) => (c === "inject_too_large" ? "正文文件超过大小上限，宿主现在拿到的是空正文。" : c === "inject_not_file" ? "正文路径不是一个文件，宿主现在拿到的是空正文。" : "正文文件读不出来，宿主现在拿到的是空正文。"),
      injectBadNext: "删减内容后保存，或用「恢复内置」。",

      rulesTitle: "规则",
      rulesDesc: "规则是一份写给模型的长期指令（比如编码规范）。激活后写进 DSH 数据目录的 AGENTS.md 或 CLAUDE.md，宿主每次对话都会读。同一时间只激活一条。",
      rulesCount: (n) => `${String(n)} 条`,
      newRule: "新建规则",
      rulesEmptyTitle: "还没有规则",
      rulesEmptyBody: "新建一条，写下你希望模型一直遵守的事。保存后点「激活」才会生效。",
      newFirstRule: "新建第一条规则",
      ruleActiveTag: "激活中",
      ruleMeta: (target, size) => `写入 ${String(target)} · ${String(size)}`,
      edit: "编辑",
      activate: "激活",
      deactivate: "取消激活",
      del: "删除",
      editRule: (label) => `编辑规则 ${String(label)}`,
      activateRule: (label) => `激活规则 ${String(label)}`,
      deactivateRule: (label) => `取消激活规则 ${String(label)}`,
      deleteRule: (label) => `删除规则 ${String(label)}`,
      editorNewTitle: "新建规则",
      editorEditTitle: (label) => `编辑「${String(label)}」`,
      fieldId: "规则 ID",
      fieldIdHint: "字母或数字开头，可用字母、数字、点、下划线、连字符，最多 64 个字符。",
      fieldIdLocked: "ID 创建后不能改；想换 ID 请新建一条。",
      ruleIdCount: (n) => `${String(n)} / 64`,
      fieldName: "显示名称（可选）",
      fieldNameHint: "留空就用 ID。",
      fieldTarget: "写入哪个文件",
      targetAgents: "大多数情况选它，宿主默认读这个文件。",
      targetClaude: "只在你的环境读 CLAUDE.md 时选。",
      fieldText: "规则正文",
      fieldTextHint: "写给模型看的指令，可以用 Markdown。",
      ruleIdBad: "ID 格式不对：要以字母或数字开头，只能用字母、数字、点、下划线、连字符。",
      ruleIdTaken: "已有同 ID 的规则，保存会覆盖它。",
      ruleActiveEditing: (t) => `这条正在激活，保存会立刻同步写入 ${String(t)}。`,
      saveRule: "保存规则",
      whyNeedId: "先填规则 ID。",
      whyBadId: "规则 ID 格式不对。",
      whyNeedText: "规则正文是空的。",
      ruleSaved: "规则已保存",
      ruleSavedInactive: "规则已保存，还没激活",
      ruleSavedInactiveNext: "点这条规则的「激活」，它才会写进文件。",
      ruleSavedSynced: (t) => `规则已保存，并同步写入 ${String(t)}`,
      ruleSavedMoved: (t) => `规则已保存，并改为写入 ${String(t)}`,
      ruleSavedStale: (t) => `规则已保存，但 ${String(t)} 被别的程序改过，插件没有覆盖它`,
      confirmActivateTitle: (label) => `激活「${String(label)}」？`,
      confirmActivateBody: (t, s) => `会把这条规则的正文（${String(s)}）写进 ${String(t)}。${String(t)} 原来的内容会先备份，取消激活时还原。`,
      confirmActivateSwap: (label) => `正在激活的「${String(label)}」会先被撤下，它写进的文件会还原。`,
      confirmActivateYes: "激活",
      confirmDeactivateTitle: (label) => `取消激活「${String(label)}」？`,
      confirmDeactivateBody: (t) => `${String(t)} 会还原成激活前的样子；如果它被别的程序改过，插件会原样保留。规则本身不会删除。`,
      confirmDeactivateYes: "取消激活",
      confirmDeleteTitle: (label) => `删除规则「${String(label)}」？`,
      confirmDeleteBody: "规则正文会被删除，无法找回。",
      confirmDeleteActiveBody: (t) => `规则正文会被删除，无法找回。它正在激活：${String(t)} 会先还原成激活前的样子（被别的程序改过则保留）。`,
      confirmDeleteYes: "删除",
      doneActivated: (label, t) => `已激活「${String(label)}」，写入 ${String(t)}`,
      doneActivatedNext: "从下一轮对话开始生效。",
      doneDeactivated: "已取消激活",
      landingRestored: (t) => `${String(t)} 已还原成原来的内容。`,
      landingRemoved: (t) => `插件创建的 ${String(t)} 已删除。`,
      landingSkipped: (n) => `${String(n)} 个文件被别的程序改过，插件原样保留了。`,
      doneDeleted: (label) => `已删除「${String(label)}」`,

      errNetwork: "连不上插件后端",
      errNetworkNext: "确认宿主还在运行，然后重试。",
      errTimeout: "后端太久没有回应",
      errTimeoutNext: "宿主可能正忙，等几秒再重试。",
      errMissing: "宿主里找不到这个插件的接口",
      errMissingNext: "确认插件已经装进当前 profile，并且重启过宿主。",
      errOrigin: "请求被宿主拦下了",
      errOriginNext: "写操作只接受这个页面本身发出的请求。刷新浏览器页面后再试。",
      errNoRoot: "插件不知道宿主源码在哪",
      errNoRootNext: "按概览里的提示设置宿主目录，然后重启宿主。",
      errBlocked: (n) => `预检没通过，一个文件都没写（${String(n)} 处对不上）`,
      errBlockedNext: "宿主保持原样。对不上的位置见下面，或补丁页顶部。",
      errBusy: "另一个应用或回退正在进行",
      errBusyNext: "等它结束后点「重新检查」。",
      errDrift: (n) => `${String(n)} 个文件被别的程序改过，回退已整体取消`,
      errDriftNext: "磁盘没有被改动。先把这些文件恢复原样（或重新安装宿主），再回退。",
      errNotApplied: "没有应用记录，不需要回退",
      errNotAppliedNext: "宿主文件没有被插件改过。",
      errWriteHalf: "写到一半失败了，插件已尝试撤回",
      errWriteHalfNext: "不要反复重试。保留 DSH 数据目录里的 breaklimit 文件夹，按安装说明的「回退与卸载」处理。",
      errState: "应用记录损坏或版本不符，插件拒绝继续",
      errStateNext: "按安装说明的「回退与卸载」一节处理 breaklimit 文件夹。",
      errTooLarge: "内容太长，超过了上限",
      errTooLargeNext: "删减一些再保存。",
      errWrite: "写不进磁盘",
      errWriteNext: "检查 DSH 数据目录的权限和剩余空间，再试一次。",
      errRequest: "请求格式不对（插件内部问题）",
      errRequestNext: "点「重新检查」后再试；仍然出现，请把错误代码报给作者。",
      errUnknownPatch: "后端不认识这条补丁",
      errUnknownPatchNext: "补丁清单可能已经变了，点「重新检查」刷新。",
      errRule: "规则操作被拒绝",
      errRuleNext: "这条规则可能已被删除，或文件读不出来。点「重新检查」刷新列表。",
      errRuleBodyWrite: "写入规则正文文件失败",
      errRuleBodyWriteNext: "请检查磁盘空间或数据目录权限，原规则清单未被改动。",
      errRuleIndex: "更新规则清单失败",
      errRuleIndexNext: "请检查数据目录中的 rules.json 权限。",
      errRuleIndexWithBody: "正文已保存，但未能更新规则清单",
      errRuleIndexWithBodyNext: "新正文已写入 bodies/ 目录，但 rules.json 未能同步更新，建议重新保存一次。",
      errRuleLanding: "正文与清单已保存，但未能同步写入目标文件",
      errRuleLandingNext: "规则已落盘并生效于清单，但写入 AGENTS.md 或 CLAUDE.md 时失败，请检查该文件是否被外部占用或写保护。",
      errRuleConflict: "规则清单在保存过程中被别的窗口改过",
      errRuleConflictNext: "这次保存没有覆盖它。点「重新检查」看最新内容，再保存一次。",
      errRuleTarget: "写入目标只能是 AGENTS.md 或 CLAUDE.md",
      errRuleTargetNext: "重新打开这条规则，在「写入哪个文件」里选一个。",
      errRuleBodyRemove: "规则已从列表移除，但正文文件没删掉",
      errRuleBodyRemoveNext: "列表里不会再出现它；正文仍留在 bodies/ 目录，需要时可以手动删。",
      errServer: "插件后端出错了",
      errServerNext: "点「重新检查」；反复出现，请把错误代码报给作者。",
      errUnknown: "操作没有成功",
      errUnknownNext: "点「重新检查」看看当前状态；反复出现，请把错误代码报给作者。",
      breaklimitButton: "破限",
      dockPopoverTitle: "破限快捷设置",
      dockModeTitle: "提示词模式",
      dockTierFailed: "切换失败，当前仍是原来那档。",
      confirmOverwriteAlias: (from) => `词条「${String(from)}」已存在，确定覆盖吗？`,
      confirmDeleteAlias: (from) => `确定删除词条「${String(from)}」吗？`,
      aliasTitle: "目标词表",
      aliasDesc: "在请求交给模型前，替换用户消息中的目标词。保存后请新开会话使用。",
      aliasStateEmpty: "词表未配置",
      aliasStateFailed: "词表读取失败",
      aliasStateMiss: "本轮未替换",
      aliasStateHit: (n) => `词表 ${String(n)} 条`,
      aliasLoading: "词表读取中…",
      aliasEmptyList: "暂无条目",
      aliasFrom: "原词",
      aliasTo: "替换成",
      aliasAdd: "添加",
      aliasRemove: "删除",
      aliasConfirmDelete: "确认删除？",
      aliasFoot: "改动只对之后的新会话生效",
      aliasSaveFailed: "保存失败，改动没有生效",
      aliasClose: "关闭",

      // 五页版新增：词库页、提示词读取失败、规则详情。
      guideHide: "收起步骤",
      guideShow: "展开步骤",
      rowWords: "目标词库",
      wordsSummaryCount: (n) => `${String(n)} 条已保存`,
      wordsSummaryEmpty: "还没有词条",
      wordsSummaryFailed: "读取失败，写入已暂停",
      wordsSummaryHint: "在请求交给模型前，替换用户消息中的目标词。保存后请新开会话使用。",
      manageWords: "管理",
      doneAlreadyNext: "这次没有写入文件。是否已经重启过，本页无法判断。",
      promptReadFailedTitle: "共用正文读取失败",
      promptReadFailedNext: "正文内容未知，不能当作空正文或内置正文。为避免覆盖，编辑与保存已暂停；重新读取成功后才能继续。",
      promptReadRetry: "重新读取正文",
      promptUnknownPlaceholder: "（读取失败，内容未知）",
      promptCountUnknown: "内容未知",
      savedMark: "已保存",
      whyPromptUnread: "正文还没读取成功，不能编辑或保存。",
      promptSavingHint: "正在保存已提交的内容，你可以继续编辑；新输入会保留。",
      donePromptSavedMore: "已保存提交的内容；编辑器里还有新的未保存修改",
      donePromptSavedMoreNext: "保存期间输入的内容仍在编辑器里，可以继续编辑或再次保存。",
      confirmDiscardPromptTitle: "放弃正文修改？",
      confirmDiscardPromptBody: "会回到上次保存的内容，当前未保存的输入会丢失。",
      confirmDiscardPromptYes: "放弃修改",
      ruleDetailsTitle: "规则详情",
      ruleDetailActive: (t) => `正文已写入 ${String(t)}；保存编辑会同步过去。`,
      ruleDetailInactive: (t) => `保存后不会自动生效；激活才会写入 ${String(t)}。`,
      ruleBodyLoading: "正在读取正文…",
      ruleBodyFailed: "正文读不出来",
      ruleBodyFailedNext: "规则仍在列表里。可以重试读取，或直接编辑它。",
      ruleBodyRetry: "重试读取",
      ruleSelect: (label) => `查看规则 ${String(label)}`,
      activateNow: "现在激活",
      wordsTitle: "词库",
      wordsLead: "在请求交给模型前，替换用户消息中的目标词。保存后请新开会话使用。",
      wordsScope: "只处理用户消息里的文字。聊天界面原文、系统提示词和工具结果都不会被修改；本地预览也不代表真实会话已经发生替换。",
      wordsReadFailedTitle: "词库读取失败，写入与预览已暂停",
      wordsReadFailedStale: (n) => `下方保留上次读取的 ${String(n)} 条数据，并标记为旧数据。重新读取成功后才能继续。`,
      wordsReadFailedUnknown: "下方内容未知，不能当作空词库。重新读取成功后才能继续。",
      wordsRetryRead: "重新读取词库",
      wordsReadOk: "词库已重新读取",
      wordsCount: (n, max) => `${String(n)} / ${String(max)} 条`,
      wordsStaleTag: "旧数据",
      wordsAdd: "添加词条",
      wordsLimitNote: (max) => `已达到 ${String(max)} 条上限。仍可编辑、删除已有词条，或用相同原词覆盖保存。`,
      wordsSearchLabel: "搜索原词或替换词",
      wordsSearchClear: "清除搜索",
      wordsNoMatchTitle: "没有找到匹配的词条",
      wordsNoMatchBody: "试试原词或替换词里的其他字。搜索只影响列表，不改变替换范围。",
      wordsEmptyTitle: "还没有词条",
      wordsEmptyBody: "把想替换的目标词配一个新名称。保存后请新开会话使用。",
      wordsEmptyAdd: "添加第一条词条",
      wordsEditLabel: (from) => `编辑词条 ${String(from)}`,
      wordsDeleteLabel: (from) => `删除词条 ${String(from)}`,
      wordsColFrom: "原词",
      wordsColTo: "替换为",
      wordsColActions: "操作",
      wordsEachSave: "每次操作单独保存。搜索只影响列表，不改变替换范围与处理顺序。",
      wordsPreviewTitle: "试一试替换效果",
      wordsPreviewDesc: "使用已保存的词库，文字只在本页处理。",
      wordsPreviewInput: "示例文本",
      wordsPreviewPlaceholder: "输入包含原词的一句话…",
      wordsPreviewOutput: "替换后",
      wordsPreviewLocal: "本地预览",
      wordsPreviewPaused: "预览已暂停：读取成功后才能试。",
      wordsPreviewEmptyList: "词库为空，添加并保存后可以试用。",
      wordsPreviewInputHint: "输入一段示例文字。",
      wordsPreviewHit: (n) => `命中 ${String(n)} 个词条，仅为本地预览。`,
      wordsPreviewMiss: "没有词条匹配这段文本。",
      wordsPreviewRulesTitle: "替换规则与生效范围",
      wordsPreviewRules1: "区分大小写，精确字面匹配，长原词优先。按顺序处理时，替换结果可能继续匹配后面的词条。",
      wordsPreviewRules2: "本地预览不保存词条，也不产生真实会话命中记录。保存后请新开会话使用。",
      wordEditorAddTitle: "添加词条",
      wordEditorEditTitle: "编辑词条",
      wordEditorHint: "首尾空白会去掉。原词和替换词各最多 64 个字符。",
      wordFromLabel: "原词（必填）",
      wordToLabel: "替换为（必填）",
      wordFromPlaceholder: "例如：示例旧称",
      wordToPlaceholder: "例如：示例新称",
      wordErrFromEmpty: "请填写原词。",
      wordErrToEmpty: "请填写替换词。",
      wordErrSame: "原词与替换词不能相同。",
      wordErrFromLong: (n) => `原词最多 64 个字符，现在 ${String(n)} 个。`,
      wordErrToLong: (n) => `替换词最多 64 个字符，现在 ${String(n)} 个。`,
      wordErrLimit: (max) => `词库已达到 ${String(max)} 条上限，请先编辑或删除已有词条，或用相同原词覆盖。`,
      wordCap: (n) => `${String(n)} / 64`,
      wordSave: "保存词条",
      wordNoChange: "没有改动，不用保存。",
      wordSaveNote: "首尾空白会去掉，保存成功后才更新词库。",
      wordSavingNote: "正在保存，请稍候。",
      wordSaveFailedTitle: "保存失败，草稿已保留",
      wordSaveFailedNext: "已保存的词库没有改变。确认后可以再试一次。",
      wordSaveUnknownTitle: "保存没有回执，结果未知",
      wordSaveUnknownNext: "网络中断或超时不代表后端没有写入。草稿已保留；先重新读取核对，再决定要不要重试。",
      wordSaved: "词条已保存",
      wordSavedMerged: "词条已合并并保存",
      wordSavedNext: "保存后请新开会话使用。",
      wordDeleteTitle: (from) => `删除词条「${String(from)}」？`,
      wordDeleteBody: "删除会立即保存新的词库。取消会保留原词条。",
      wordDeleteYes: "删除词条",
      wordDeleted: "词条已删除",
      wordOverwriteTitle: (from) => `覆盖词条「${String(from)}」？`,
      wordOverwriteBody: "同一个原词已有记录，确认后使用新的替换词。",
      wordOverwriteYes: "确认覆盖",
      wordMergeTitle: "合并并覆盖同名词条？",
      wordMergeBody: "修改后的原词与另一条已有记录相同，确认后两条合并为一条。",
      wordMergeYes: "确认合并覆盖",
      wordMergeCurrent: "正在编辑的原记录",
      wordMergeDuplicate: "将被覆盖的已有记录",
      wordMergeFinal: "最终保留一条",
      wordBackEdit: "返回编辑",
      wordDiscardTitle: "放弃词条草稿？",
      wordDiscardBody: "未保存的原词与替换词会丢失，已保存的词库保持不变。",
      wordDiscardYes: "放弃草稿",
      wordKeepEdit: "继续编辑",
      wordsManage: "管理词库",
      wordsFromChatReturn: "返回会话",
      wordsNavHint: "请在设置里打开「破限」，会直接停在词库页。",

      // 阶段一组件：Dialog 安全把手与提示
      dialogGuardAckRequired: "先勾选上面的确认项，确认按钮才可用。",
      dialogGuardWordRequired: (word) => `输入「${String(word)}」后，确认按钮才可用。`,
      dialogGuardReady: "确认后立即执行。",
      dialogConsequenceReversible: "可以撤销",
      dialogConsequenceIrreversible: "此操作无法撤销",
      dialogConfirmWordLabel: (word) => `输入 ${String(word)} 以确认`,

      // 阶段一组件：StateBlock 与数据安全声明
      dataProtectedDisk: "磁盘上的文件没有被修改。",
      dataProtectedRules: "已有规则正文仍在 bodies/ 目录，没有被删除。",
      stateActionRetry: "重新读取",
      stateActionDetails: "查看保留了哪些数据",

      // 阶段一组件：术语词典
      termHost: "宿主",
      tipHost: "运行插件的 DeepSeek Harness 程序本体。源码补丁改的就是它的文件。",
      termPatch: "补丁",
      tipPatch: "对宿主源码的一组小改动。应用 = 写进磁盘文件，重启宿主后才会加载。",
      termPreflight: "预检",
      tipPreflight: "写入前的自动核对：源码与补丁预期一致才写，不一致就整批停下，不会只写一半。",
      termTakeover: "接管",
      tipTakeover: "插件在本次运行中介入提示词与审批处理。关掉立即停止介入，但不撤销已写入磁盘的补丁。",
      termActivate: "激活",
      tipActivate: "把一条规则写进指令文件（AGENTS.md / CLAUDE.md），之后每次对话都会读到。",
      termSharedPrompt: "共用正文",
      tipSharedPrompt: "推荐、完全解放两档模式共用的附加指令。模式各自的附加段另外生效。",
      termUnrestricted: "完全解放",
      tipUnrestricted: "完全解放模式：解除附加自我约束，提高执行层超时与命令输出上限。",
      termInstructions: "指令文件",
      tipInstructions: "模型每次对话开始时读取的约定文件，例如 AGENTS.md、CLAUDE.md。",

      // 阶段三组件与模型：4 阶段进度流
      flowStep1Title: "配置宿主目录",
      flowStep1Done: "已找到宿主源码",
      flowStep1Current: "告诉插件源码在哪",
      flowStep2Title: "选择补丁",
      flowStep2Done: (n) => `已选 ${String(n)} 条`,
      flowStep2Current: "还没有选择",
      flowStep2Todo: "配置目录后进行",
      flowStep3Title: "检查并应用",
      flowStep3Blocked: "预检未通过，未写入",
      flowStep3Revert: "已回退源码",
      flowStep3Done: "已写入磁盘",
      flowStep3Current: (n) => `待写入 ${String(n)} 个文件`,
      flowStep3Todo: "选好补丁后进行",
      flowStep4Title: "重启宿主",
      flowStep4Current: "等你按原方式重启",
      flowStep4Done: "已完成",
      flowStep4Todo: "应用后进行",

      // 阶段三：主行动卡片
      actionCardLabelUrgent: "需要先处理",
      actionCardLabelNextRoot: "下一步 · 配置环境",
      actionCardLabelRestart: "还差一步 · 重启宿主",
      actionCardLabelNextApply: "下一步 · 应用补丁",
      actionCardLabelOptional: "按需选择",
      actionCardLabelPass: "磁盘检查通过",
      actionCardRulesCorruptTitle: "规则清单读不出来",
      actionCardRulesCorruptBody: "已暂停规则写入，保护现有清单和正文。先查看恢复方式，补丁与提示词仍可独立管理。",
      actionCardRulesCorruptBtn: "查看规则恢复",
      actionCardBrokenTitle: "状态记录无法读取",
      actionCardBrokenBody: "补丁记录损坏或版本不符，已暂停写入以保护源码。",
      actionCardRootTitle: "先告诉插件宿主源码在哪里",
      actionCardRootBody: "目前无法检查补丁。按原启动方式配置宿主目录，重启后再回来检查。",
      actionCardRootBtn: "查看配置步骤",
      actionCardBlockedTitle: "有一处源码与补丁预期不一致",
      actionCardBlockedBody: "本次预检已阻断。先核对宿主版本和外部修改，再重新检查；不要直接覆盖源码。",
      actionCardBlockedBtn: "查看阻断原因",
      actionCardRestartRevertTitle: "文件已恢复，接下来重启宿主",
      actionCardRestartApplyTitle: "补丁已写入，接下来重启宿主",
      actionCardRestartBody: "磁盘内容已经更新，正在运行的宿主可能仍在使用旧代码。刷新网页不会重启宿主。",
      actionCardRestartBtn: "查看重启步骤",
      actionCardPendingTitle: "把选好的改动应用到宿主",
      actionCardPendingBody: (enabled, pending) => `已选择 ${String(enabled)} 条补丁，预检通过。应用前，你可以逐项查看用途与将修改的 ${String(pending)} 个文件。`,
      actionCardPendingBtn: "查看并应用补丁",
      actionCardNoneTitle: "当前没有选择补丁",
      actionCardNoneBody: "你仍可管理提示词与规则。补丁开关关闭后，之前已经写入的源码改动会保留，撤销请用回退。",
      actionCardNoneBtn: "去挑选补丁",
      actionCardDoneTitle: "所选补丁已在磁盘上就位",
      actionCardDoneBody: "当前没有待写入文件。此检查不代表宿主已经重启，也不代表所有运行行为都已验收。",
      actionCardDoneBtn: "调整提示词",

      // 阶段三：技术诊断
      diagCommit: "宿主提交",
      diagHostRoot: "宿主根",
      diagHttp: "插件 HTTP",
      diagHttpMounted: "已挂载",
      diagHttpUnmounted: "未挂载",
      diagRulesIndex: "规则清单",
      diagRulesCorrupt: "损坏",
      diagRulesReadable: "可读",
      diagLock: "操作锁",
      diagLockBusy: "操作中",
      diagLockIdle: "空闲",
      diagApplied: "应用记录",
      diagAppliedCount: (n) => `${String(n)} 个文件`,
      diagAppliedNone: "无",
      diagPreflight: "补丁预检",
      diagRuntime: "运行行为",
      diagRuntimeNotVerified: "未由此页面验证",

      // 阶段三：概览与补丁扩展
      overviewFlowLabel: "补丁生效进度",
      overviewConfigTitle: "核心配置与接管",
      overviewConfigDesc: "这几项互相独立，按需要调整。",
      overviewEnvTitle: "环境与权限",
      overviewEnvDesc: "提示词模式决定附加指令与执行层上限，不能代替沙箱权限设置。",
      overviewEffectTitle: "改动什么时候生效？",
      overviewEffectPatches: "源码补丁",
      overviewEffectPatchesDesc: "应用后重启宿主",
      overviewEffectPrompt: "提示词",
      overviewEffectPromptDesc: "下一轮对话",
      overviewEffectRules: "规则",
      overviewEffectRulesDesc: "激活后写入指令文件",
      overviewEffectWords: "词库",
      overviewEffectWordsDesc: "保存后新开会话",
      overviewDiagTitle: "查看技术诊断",
      overviewDiagNote: "含本机路径，不含凭据",
      overviewDiagCopy: "复制诊断信息",
      overviewDiagCopied: "诊断信息已复制，不含凭据",
      patchFootPending: (n) => `预计写入 ${String(n)} 个文件`,
      patchFootNone: "没有待写入文件",
      patchFootBlocked: "预检未通过，不会写入",
      patchFootReasonDefault: "写入前会保存快照；完成后需要重启宿主。",

      // 阶段三：PatchesPage 与 OverviewPage 重塑文案
      patchesSelectedBadge: (n) => `已选 ${String(n)} 条`,
      sourcePatchesLabel: "源码补丁",
      currentPromptModePrefix: "当前提示词模式：",
      diskInPlace: "已就位",
      diskPending: "待写入",
      diskConflict: "有冲突",
      diskUnapplied: "未应用",
      diskUnchecked: "未检查",
      patchDisclosureSummary: "改动说明与文件",
      onlyUnrestricted: "仅完全解放",
      switchModeToSelect: "切换模式后可选",
      modeDisabledHint: "当前不可选",
      blockedNoticeTitle: (n) => `预检发现 ${String(n)} 处不一致`,
      blockedNoticeBody: "宿主源码可能被其他工具修改，或版本不匹配。先看具体原因，确认后再检查。",
      viewBlockReason: "查看具体原因",
      recheckSource: "再次检查源码",
      promptMineSummary: "使用自定义共用正文 · 下一轮对话生效",
      promptBuiltinSummary: "使用内置共用正文 · 下一轮对话生效",
      rulesCorruptShort: "清单损坏",
      rulesNoneShort: "尚未激活规则",
      rulesCorruptSummary: "已暂停写入以保护原数据",
      rulesActiveSummary: (target) => `已写入 ${String(target)}`,
      rulesInactiveSummary: "保存规则后，再激活到指令文件",
      adjustPrompt: "调整",
      manageRules: "管理",
      viewDetails: "查看",
      takeoverStateOn: "已开启",
      takeoverStateOff: "已暂停",
      sandboxFullAccess: "完全权限",
      sandboxHostDefault: "宿主受限",

      // 阶段四：模式权衡卡片、横向对比表、Prompt 编辑器与规则安全把手
      // 模式权衡与预算
      modeRecTradeoffGood: "适合大多数日常任务，保留自我约束与不可逆操作提示",
      modeRecTradeoffCost: "长命令、大输出更早被截断",
      modeRecBudget: "命令 20 分钟 · 工具输出 0.5 MB · 子命令深度 2",
      modeUnrTradeoffGood: "得到更长命令、更大输出、更深子命令，彻底解除自我约束",
      modeUnrTradeoffCost: "不再要求先说明不可逆操作，需自行把控操作风险",
      modeUnrBudget: "命令 9,999 秒 · 工具输出 1 MB · 子命令深度 5",

      // 模式横向对比表
      modeCompareItem: "项目",
      modeCompareCurrent: (label) => (label ? `现在 · ${String(label)}` : "现在"),
      modeCompareNext: (label) => (label ? `切换后 · ${String(label)}` : "切换后"),
      modeCompareTimeout: "命令超时上限",
      modeCompareOutputDepth: "工具输出 / 子命令深度",
      modeCompareConstraint: "附加自我约束",
      modeCompareRetained: "保留",
      modeCompareLifted: "解除",
      modeCompareTimeoutRec: "20 分钟",
      modeCompareTimeoutUnr: "9,999 秒",
      modeCompareOutputDepthRec: "0.5 MB / 深度 2",
      modeCompareOutputDepthUnr: "1 MB / 深度 5",

      // 模式弹窗把手与声明
      confirmModeAckUnrestricted: "我了解完全解放模式不再约束改动范围，也不再要求先说明不可逆操作",
      confirmModeConsequence: "可以随时切回，下一轮对话即恢复",
      modeNoticeSandboxKeep: "实际执行权限保持不变",
      modeNoticeSandboxKeepDesc: "选择推荐模式不会降低宿主沙箱的执行权限，权限始终由宿主自身配置决定。",

      // 提示词统计与保护
      promptCountExact: (chars, bytes) => `${String(chars)} 字 · ${String(bytes)} 字节`,
      promptDirtyReason: "有未保存的修改，保存后从下一轮对话生效。",
      dataProtectedPrompt: "磁盘上的正文文件没有被修改。",

      // 规则数据保护与把手
      dataProtectedRulesBodies: "已有规则正文仍保存在 bodies/ 目录，未被删除。",
      confirmDeleteAck: "我已确认不再需要这条规则",
      confirmDeleteConsequence: "此操作无法撤销，删除后无法从规则列表中找回",
      confirmRecoverWord: "重置",
      confirmRecoverConsequence: "重置后，原清单里的名称与激活关系无法在界面中恢复",
      rulesFilesLocations: "涉及的文件位置",

      // 阶段五收官新增：词库容量守卫与会话浮窗微窗口
      wordsLimitNoticeTitle: (max) => `已达到 ${String(max)} 条上限`,
      wordsLimitNoticeBody: "不能再添加新词条，仍可编辑或删除已有词条。",
      dockAliasLimitHint: (n) => `仅显示前 3 条，完整 ${String(n)} 条请前往词库管理。`,
      dockFooterHint: "Esc 关闭 · 每次改动单独保存",
      dockOpenSettings: "打开完整设置",
      dockManageAllWords: "管理全部词条",
      dockAliasInlineDefault: "原词与替换词各最多 64 字符。",
      dockModeHint: "切换前会确认影响，下一轮生效，不改变沙箱权限。",

      // P2 壳层与概览：顶栏、帮助弹窗、三步引导、页签角标
      helpLabel: "查看使用说明",
      closeSettingsLabel: "关闭设置，查看会话",
      helpTitle: "从配置到生效",
      helpIntro: "先选择提示词模式，再挑选源码补丁。应用前检查影响与快照，应用后重启同一宿主。",
      helpEffect: "源码补丁重启宿主后加载；提示词与模式下一轮对话生效；长期规则激活后写入指令文件；词库保存后新开会话生效。",
      guideTitle: "第一次配置，按这三步来",
      guideProgress: (n) => `已完成 ${String(n)} / 3`,
      guideDefaultHint: "已有默认值",
      guideStep1Title: "选择提示词模式",
      guideStep1Body: "先沿用推荐模式，之后也能随时切换。",
      guideStep2Title: "选择需要的补丁",
      guideStep2Body: "看清用途再打开开关；开关只记下选择，不改源码。",
      guideStep3Title: "应用，并重启宿主",
      guideStep3Body: "应用前会列出要改的文件，写入后按原方式重启。",
      guideGo: "去完成",
      guideView: "查看",
      tabPendingTitle: (n) => `${String(n)} 个文件待写入`,
      tabErrorLabel: "有错误",
      tabDirtyLabel: "有未保存的改动",
      envCheckedAt: (t) => `检查于${String(t)}`,
    },
    en: {
      nav: "Breaklimit",
      title: "Breaklimit",
      lead: "Loosens limits the host sets too tight, switches prompt modes, and keeps standing rules for the model.",
      tabsLabel: "Breaklimit settings",
      tabOverview: "Overview",
      tabPatches: "Patches",
      tabPrompt: "Prompt",
      tabRules: "Rules",
      tabWords: "Word list",
      pageOverviewTitle: "Start here",
      pageOverviewDesc: "Check the current state, then finish the step that is actually blocking you.",
      pagePatchesTitle: "Pick the changes you need",
      pagePatchesDesc: "Select first, apply once. Turning a switch off keeps whatever was already written.",
      pagePromptTitle: "Make the model work your way",
      pagePromptDesc: "Choose a mode, or edit the body both modes share.",
      pageRulesTitle: "Manage long-term rules",
      pageRulesDesc: "Saving stores it; activating writes it into the instruction file. One active at a time.",
      pageWordsTitle: "Manage terms",
      pageWordsDesc: "Swaps terms in your message before it reaches the model. Takes effect in a new session.",
      // Phase 2 additions: Page tips & page head description segments
      pageTipRegionLabel: "Page tip",
      pageTipHeading: "What this page does",
      pageTipDismiss: "Dismiss this tip",
      tipOverviewText: "This page shows which step is currently blocking you.",
      tipOverviewPitfall: "Common pitfall: Follow the primary action card at the top when a step is pending; no need to restart blindly or reapply.",
      tipPatchesText: "Select the switches you need, then click Check and apply in the bottom right to write files.",
      tipPatchesPitfall: "Common pitfall: Turning a switch off does not undo edits. Changes already written require Revert.",
      tipPromptText: "The mode sets the tightness of self-constraints, while the body provides shared instructions.",
      tipPromptPitfall: "Common pitfall: Recommended mode does not reduce sandbox permissions; sandbox boundaries govern actual authority.",
      tipRulesText: "Rules are stored on save, and written to instruction files only when activated. One active rule at a time.",
      tipRulesPitfall: "Common pitfall: If a rule is saved but not activated, the model cannot read it.",
      tipWordsText: "Swaps target words in user messages before they reach the model. You can preview results on the right.",
      tipWordsPitfall: "Common pitfall: Requires opening a new session after saving; existing chat history will not be retroactively swapped.",
      patchesHeadPrefix: "Select first, apply once. Each ",
      patchesHeadMid: " modifies ",
      patchesHeadSuffix: " source files; turning a switch off does not undo applied changes.",
      promptHeadPrefix: "Choose an instruction mode, or edit the ",
      promptHeadSuffix: " shared across both modes.",
      rulesHeadPrefix: "Saving stores it; ",
      rulesHeadMid: " writes it to the ",
      rulesHeadSuffix: " file. One active rule at a time.",
      whenTag: (label) => `Takes effect: ${String(label)}`,
      whenRestart: "after restarting the host",
      whenNextTurn: "next turn",
      whenActivate: "on activation",
      whenNewSession: "new session",
      refresh: "Refresh",
      refreshedAt: (s) => `Updated ${String(s)}`,
      agoJust: "just now",
      agoMin: (n) => `${String(n)} min ago`,
      agoHour: (n) => `${String(n)} h ago`,
      loading: "Reading plugin state…",
      loadingHint: "Usually a second or two. If it stays here, press Refresh at the top right.",
      retry: "Retry",
      recheck: "Check again",
      dismiss: "Dismiss this message",
      dismissShort: "Dismiss",
      cancel: "Cancel",
      working: "Working…",
      saving: "Saving…",
      copied: "Copied to clipboard",
      copyFailed: "Could not copy",
      copyFailedNext: "The browser blocked clipboard access. Select the text above and copy it by hand.",
      copyCommand: "Copy this line",
      errorCode: (c) => `Error code ${String(c)}`,
      andMore: (n) => `and ${String(n)} more`,
      unknown: "unknown",
      sep: ": ",
      bytes: (n) => `${String(n)} B`,
      timeUnknown: "time unknown",

      goOverview: "Back to Overview",
      goPatches: "Open Patches",
      goPatchesSee: "See them on Patches",
      goPatchesPick: "Choose patches",
      goPatchesApply: "Apply on Patches",
      goPrompt: "Open Prompt",
      goRules: "Open Rules",
      goWords: "Open word list",

      nextStep: "Next step",
      nsRulesCorruptTitle: "Rules index cannot be read",
      nsRulesCorruptBody: (path) => `The rules index ($DSH_HOME/${String(path)}) is unreadable or has an incompatible version. The plugin paused writes to protect existing data. Rule bodies remain safe in $DSH_HOME/breaklimit/bodies/. You can back up the corrupt index and start fresh with an empty one.`,
      recoverRules: "Back up and reset index",
      confirmRecoverRulesTitle: "Back up and reset rules index?",
      confirmRecoverRulesBody: "The corrupt index file will be copied to dsh-breaklimit-backup and an empty index will be initialized. Existing rule bodies stay in bodies/; creating rules with the same ID will overwrite them.",
      confirmRecoverRulesYes: "Back up and reset",
      doneRecoverRules: "Rules index reset",
      doneRecoverRulesNext: (path) => `Corrupt index backed up to $DSH_HOME/${String(path)}. Rule bodies remain in $DSH_HOME/breaklimit/bodies/.`,
      nsBrokenTitle: "The last apply record cannot be read",
      nsBrokenBody: "To avoid damaging the host, apply and revert are paused. Do not keep retrying. Follow the Revert and uninstall section of the install guide for the breaklimit folder in your DSH data directory, then press Check again.",
      nsRootTitle: "Tell the plugin where the host source is",
      nsRootBody: "The plugin edits a few files in the DeepSeek Harness source tree, but it does not know where that is. Run the line below in the PowerShell window that starts the host (use your own folder), then restart the host.",
      nsRootSnippet: "$env:DSH_BREAKLIMIT_HOST_ROOT = 'D:\\path\\to\\deepseek-harness'",
      nsLockTitle: "Another operation is running",
      nsLockBody: "Another window or the command line may be applying or reverting patches. Wait for it to finish, then press Check again.",
      nsBlockedTitle: (n) => `${String(n)} ${Number(n) === 1 ? "place" : "places"} in the host do not match what the patches expect`,
      nsBlockedBody: "In this state the plugin writes nothing, so the host is safe. The usual cause is a different host version or source edited by hand.",
      nsNoneTitle: "Every patch is switched off",
      nsNoneBody: "Applying now would write nothing. Turn on the ones you want on the Patches tab. Anything written earlier stays until you use Revert.",
      nsPendingTitle: (n) => `${String(n)} ${Number(n) === 1 ? "file is" : "files are"} waiting to be written`,
      nsPendingBody: "The patches you picked are not in the host yet. Review them on the Patches tab, then press Apply.",
      nsDoneTitle: "Patches are in place",
      nsDoneBody: "The host files already match the patches. If you applied them just now, make sure the host has been restarted.",

      stepsTitle: "Three steps",
      stepsDesc: "Go in order. Click any step to jump to it.",
      step1Title: "Pick a prompt mode",
      step1Desc: "Decides which extra instructions the model gets. Change it any time.",
      step2Title: "Choose patches",
      step2Desc: "Turn on the changes you want. Flipping a switch changes no files.",
      step3Title: "Apply, then restart the host",
      step3Desc: "Once written into the host source, restart the host for it to take effect.",
      stepState: (s) => (s === "done" ? "done" : s === "error" ? "needs attention" : s === "warn" ? "one step left" : "not done"),
      pickedOf: (a, b) => `${String(a)} of ${String(b)} on`,
      blockedN: (n) => `${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}`,
      pendingN: (n) => `${String(n)} ${Number(n) === 1 ? "file" : "files"} to write`,
      stepBroken: "apply record damaged",
      stepNoRoot: "host folder not set",
      stepWaitRestart: "written, waiting for a restart",
      stepInPlace: "in place",

      statusTitle: "Current state",
      statusDesc: "Live values the backend read just now.",
      rowHost: "Target host",
      rootSource: (s) => (s === "config" ? "from plugin config" : s === "env" ? "from environment variable" : s === "derived" ? "derived from the host process" : "not set"),
      rootMissingShort: "host source folder not set",
      rowMode: "Prompt mode",
      rowModeHint: "Affects only the model prompt and self-constraints, not the host execution permissions.",
      rowSandbox: "Sandbox level",
      sandboxTakeover: "Full access (default): Host automatically approves routine command approval; tools and edits are guided by plugin rules.",
      sandboxHost: "At this level the plugin does not widen the sandbox; approvals stay with the host.",
      rowPreflight: "Patch preflight",
      preOk: (n) => (Number(n) === 0 ? "passed, nothing to write" : `passed, ${String(n)} ${Number(n) === 1 ? "file" : "files"} to write`),
      preBlocked: (n) => `failed: ${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}`,
      preNoRoot: "cannot check: host folder unknown",
      preBroken: "cannot check: apply record damaged",
      preHint: "Preflight only reads, and runs again on every refresh.",
      rowApplied: "Last apply",
      appliedValue: (n, t) => `${String(n)} ${Number(n) === 1 ? "file" : "files"} · ${String(t)}`,
      appliedNone: "never applied",
      opId: (id) => `operation ${String(id)}`,
      rowRules: "Rules",
      rulesNone: "no rules yet",
      rulesActive: (n, label) => `${String(n)} total, active: ${String(label)}`,
      rulesInactive: (n) => `${String(n)} total, none active`,
      rowPrompt: "Shared body",
      promptMine: (s) => `your version · ${String(s)}`,
      promptBuiltin: "built-in",
      rowTakeover: "Runtime takeover",
      takeoverHint: "Takes effect at once and lasts only for this run; a host restart returns it to the configured value. It does not undo written patches.",
      takeoverLabel: "Runtime takeover switch",
      takeoverState: (on) => (on ? "on" : "off"),
      doneTakeover: (on) => (on ? "Runtime takeover is on" : "Runtime takeover is off"),
      warnTitle: "Host approval settings bypass the plugin",
      warnPresetNever: (p) => `The ${String(p)} preset uses approval never: the host refuses directly and the plugin is never asked.`,
      warnPolicyNever: "The default approval policy is never: approvals in new sessions never reach the plugin.",
      warnOther: (c) => `The host reported a permission notice (${String(c)}).`,
      warnNext: "If you want the plugin to handle approvals, change it to ask in the host permission settings.",

      patchesTitle: "Patches",
      patchesLead: "Each patch changes one known spot in the host source. Choose first, then apply them together.",
      legendSwitch: "Switch",
      legendSwitchDesc: "whether the next Apply includes this patch. Flipping it changes no files.",
      legendDisk: "On disk",
      legendDiskDesc: "what the host source looks like right now: to write, in place, or mismatched.",
      patchesSummary: (a, b, n) => `${String(a)} of ${String(b)} chosen · all patches touch ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      patchesEmptyTitle: "Cannot read the patch list",
      kindReplace: "rewrite",
      kindVerify: "check only",
      switchOnHint: "included next time",
      switchOffHint: "skipped next time",
      diskState: (s) => (s === "pending" ? "to write" : s === "ready" ? "in place" : s === "blocked" ? "mismatch" : s === "skipped" ? "not in this run" : "cannot tell yet"),
      touchesFiles: (n) => `touches ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      detailsShow: "Details",
      detailsHide: "Hide details",
      whyLabel: "Why",
      before: "Before",
      after: "After",
      offButWritten: "Switching off only affects the next apply. Anything already written stays; use Revert below to undo it.",
      blockedTitle: (n) => `Preflight failed: ${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}`,
      blockedBody: "The plugin writes nothing and the host stays as it is. Check that the host is the version named in the README and that its source was not edited by hand. If it still fails, copy the list below to the author.",
      copyList: "Copy list",
      findingState: (s) => (s === "conflict" ? "original text differs from what was expected" : s === "applied_other" ? "applied from an earlier declaration; revert first" : s === "unsatisfied" ? "expected content is missing" : s === "missing" ? "file or its checksum record is missing" : "check did not pass"),
      apply: "Apply",
      applyN: (n) => `Apply changes (${String(n)} ${Number(n) === 1 ? "file" : "files"})`,
      applyHint: "Each file is snapshotted before writing; restart the host afterwards for it to take effect.",
      revert: "Revert",
      revertHint: (n) => `Revert restores the ${String(n)} ${Number(n) === 1 ? "file" : "files"} written last time.`,
      whyBusy: "Still working on the previous action.",
      whyToggling: "A switch is still saving.",
      whyNoRoot: "The plugin does not know where the host source is yet; see Overview.",
      whyBroken: "The apply record is damaged and writing is paused; see Overview.",
      whyLock: "Another apply or revert is running.",
      whyBlocked: (n) => `Preflight has ${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}, so apply would be refused as a whole.`,
      whyNoneSelected: "No patch is on, so there is nothing to write.",
      whyNothing: "Nothing to write: the chosen patches are already in place.",
      whyNotApplied: "There is no apply record, so there is nothing to revert.",
      whyRulesCorrupt: "Rules index is corrupt and writes are paused; back up and reset first.",
      rulesCorruptNotice: (path) => `Rules index cannot be read ($DSH_HOME/${String(path)}); writes are paused to protect existing data. Rule bodies remain safe in $DSH_HOME/breaklimit/bodies/.`,
      confirmDiscardRuleTitle: "Unsaved rule draft",
      confirmDiscardRuleBody: "Unsaved changes to this rule will be lost if you switch or cancel. Discard these changes?",
      confirmDiscardYes: "Discard changes",
      confirmOverwriteRuleTitle: (id) => `Overwrite existing rule "${String(id)}"?`,
      confirmOverwriteRuleBody: "A rule with this ID already exists. Saving will replace its name and body, and the previous content cannot be recovered.",
      confirmOverwriteRuleYes: "Overwrite",
      openExistingRule: "Open existing rule",
      confirmApplyTitle: (n) => `Write ${String(n)} host source ${Number(n) === 1 ? "file" : "files"}?`,
      confirmApplyBody: "The files below will change. Each is snapshotted first; if anything mismatches, nothing is written; restart the host afterwards. You can undo it with Revert at any time.",
      confirmApplyYes: (n) => `Write ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      confirmRevertTitle: (n) => `Restore ${String(n)} ${Number(n) === 1 ? "file" : "files"} to the original?`,
      confirmRevertBody: "The files written last time go back to their pre-apply content. If any of them was changed by another program, the whole revert is cancelled and the disk is left alone. Restart the host afterwards.",
      confirmRevertYes: (n) => `Restore ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      doneApplied: (n) => `Wrote ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      doneAppliedNext: "One step left: restart the host.",
      doneAlready: "Nothing to write: everything is in place",
      doneReverted: (n) => `Restored ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      doneRevertNothing: "Nothing needed restoring; the apply record is cleared",

      restartTitle: "One step left: restart the host",
      restartBodyApply: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} just written, but the running host still uses the old code. The change takes effect after a restart.`,
      restartBodyRevert: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} just restored, but the running host still uses the patched code. It goes back to the original after a restart.`,
      copyRestart: "Copy restart command",
      restartHow: "How to restart",
      restartDismiss: "Got it",
      restartStep1: "Go to the terminal window that started the host and press Ctrl+C to stop it.",
      restartStep2: "Run the start command again in the same window (the one shown above).",
      restartStep3: "Reopen this settings page. Overview showing Patches are in place means it worked.",
      restartCaveat: "The plugin cannot restart the host or tell whether you have, so this message stays until you press Got it.",
      restartCommandLabel: "Command that started the host",
      restartNoCommand: "Could not read the start command; start the host the way you usually do.",

      modeTitle: "Prompt mode",
      modeDesc: "Both modes share the same jailbreak body; the difference is only extra self-constraints and execution limits. Note: Prompt modes only adjust self-constraints, not host execution permissions. Takes effect on the next turn without restart.",
      modeRecommended: "Recommended (everyday jailbreak)",
      modeUnrestricted: "Unrestricted (full jailbreak)",
      modeRecommendedShort: "Recommended",
      modeUnrestrictedShort: "Unrestricted",
      tagDefault: "default (prompt)",
      tagCurrent: "in use",
      tagPending: "to confirm",
      modeRecFit: "The jailbreak body applies as usual, plus three self-imposed constraints: no unrequested scope creep, say what an irreversible step costs before taking it, show the evidence before claiming done.",
      modeRecChange: "Execution stays conservative: 20 min commands, 0.5 MB tool output, subagent depth 2.",
      modeUnrFit: "Same jailbreak body, with those three constraints dropped: no self-limiting, no gentler alternative, no disclaimers.",
      modeUnrChange: "Execution opened up: 9999 s, 1 MB, depth 5.",
      confirmModeTitle: (label) => `Switch to ${String(label)}?`,
      confirmModeBody: "Takes effect from the next turn without a restart; the turn in progress is not affected. Writes breaklimit/tier.json in your DSH data directory. You can switch back any time.",
      confirmModeYes: "Switch",
      doneMode: (label) => `Switched to ${String(label)}`,
      doneModeNext: "Takes effect from the next turn.",

      promptTitle: "Shared prompt body",
      promptDesc: "Both modes share this body, placed at the very start of the model instructions. Saving replaces the built-in body with your version; the mode-specific part is not affected.",
      promptUsingMine: (s) => `Using your version · ${String(s)}`,
      promptUsingBuiltin: "Using the built-in body",
      promptPlaceholder: "Write standing instructions for the model here…",
      promptCount: (chars, size) => `${String(chars)} characters · ${String(size)}`,
      promptDirty: "Unsaved changes",
      save: "Save",
      copyAll: "Copy all",
      resetBuiltin: "Restore built-in",
      discard: "Discard changes",
      whyNoChange: "No changes to save.",
      whyEmptyPrompt: "The body is empty. To go back to the built-in body, use Restore built-in.",
      whyAlreadyBuiltin: "The built-in body is already in use.",
      saveHint: "Takes effect from the next turn after saving.",
      confirmResetTitle: "Delete your version and go back to the built-in body?",
      confirmResetBody: (s) => `Your saved text (${String(s)}) is deleted and cannot be recovered. Press Copy all first if you want a backup.`,
      confirmResetYes: "Delete and restore",
      donePromptSaved: (s) => `Saved (${String(s)})`,
      donePromptReset: "Built-in body restored",
      injectBad: (c) => (c === "inject_too_large" ? "The body file is over the size limit, so the host currently gets an empty body." : c === "inject_not_file" ? "The body path is not a file, so the host currently gets an empty body." : "The body file cannot be read, so the host currently gets an empty body."),
      injectBadNext: "Shorten it and save, or use Restore built-in.",

      rulesTitle: "Rules",
      rulesDesc: "A rule is a standing instruction for the model, such as coding conventions. Activating it writes it into AGENTS.md or CLAUDE.md in your DSH data directory, which the host reads in every conversation. One rule is active at a time.",
      rulesCount: (n) => `${String(n)}`,
      newRule: "New rule",
      rulesEmptyTitle: "No rules yet",
      rulesEmptyBody: "Create one and write down what the model should always follow. It takes effect after you press Activate.",
      newFirstRule: "Create your first rule",
      ruleActiveTag: "active",
      ruleMeta: (target, size) => `writes ${String(target)} · ${String(size)}`,
      edit: "Edit",
      activate: "Activate",
      deactivate: "Deactivate",
      del: "Delete",
      editRule: (label) => `Edit rule ${String(label)}`,
      activateRule: (label) => `Activate rule ${String(label)}`,
      deactivateRule: (label) => `Deactivate rule ${String(label)}`,
      deleteRule: (label) => `Delete rule ${String(label)}`,
      editorNewTitle: "New rule",
      editorEditTitle: (label) => `Edit ${String(label)}`,
      fieldId: "Rule ID",
      fieldIdHint: "Starts with a letter or digit; letters, digits, dot, underscore and dash; up to 64 characters.",
      fieldIdLocked: "The ID cannot change after creation. Create a new rule for a new ID.",
      ruleIdCount: (n) => `${String(n)} / 64`,
      fieldName: "Display name (optional)",
      fieldNameHint: "Leave empty to use the ID.",
      fieldTarget: "Which file to write",
      targetAgents: "Pick this in most cases; the host reads it by default.",
      targetClaude: "Pick only if your setup reads CLAUDE.md.",
      fieldText: "Rule text",
      fieldTextHint: "Instructions for the model. Markdown is fine.",
      ruleIdBad: "Invalid ID: start with a letter or digit and use only letters, digits, dot, underscore and dash.",
      ruleIdTaken: "A rule with this ID exists; saving overwrites it.",
      ruleActiveEditing: (t) => `This rule is active; saving writes it into ${String(t)} right away.`,
      saveRule: "Save rule",
      whyNeedId: "Fill in a rule ID first.",
      whyBadId: "The rule ID is not valid.",
      whyNeedText: "The rule text is empty.",
      ruleSaved: "Rule saved",
      ruleSavedInactive: "Rule saved, not active yet",
      ruleSavedInactiveNext: "Press Activate on this rule to write it into its file.",
      ruleSavedSynced: (t) => `Rule saved and written into ${String(t)}`,
      ruleSavedMoved: (t) => `Rule saved and now writes into ${String(t)}`,
      ruleSavedStale: (t) => `Rule saved, but ${String(t)} was changed by another program, so the plugin left it alone`,
      confirmActivateTitle: (label) => `Activate ${String(label)}?`,
      confirmActivateBody: (t, s) => `Writes this rule (${String(s)}) into ${String(t)}. The current content of ${String(t)} is backed up first and restored on deactivate.`,
      confirmActivateSwap: (label) => `The active rule ${String(label)} is taken down first and its file restored.`,
      confirmActivateYes: "Activate",
      confirmDeactivateTitle: (label) => `Deactivate ${String(label)}?`,
      confirmDeactivateBody: (t) => `${String(t)} goes back to how it was before activation; if another program changed it, the plugin leaves it as is. The rule itself is kept.`,
      confirmDeactivateYes: "Deactivate",
      confirmDeleteTitle: (label) => `Delete rule ${String(label)}?`,
      confirmDeleteBody: "The rule text is deleted and cannot be recovered.",
      confirmDeleteActiveBody: (t) => `The rule text is deleted and cannot be recovered. It is active, so ${String(t)} is first restored to how it was before activation (kept as is if another program changed it).`,
      confirmDeleteYes: "Delete",
      doneActivated: (label, t) => `Activated ${String(label)}, written into ${String(t)}`,
      doneActivatedNext: "Takes effect from the next turn.",
      doneDeactivated: "Deactivated",
      landingRestored: (t) => `${String(t)} is back to its original content.`,
      landingRemoved: (t) => `The ${String(t)} the plugin created was removed.`,
      landingSkipped: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} changed by another program and left as is.`,
      doneDeleted: (label) => `Deleted ${String(label)}`,

      errNetwork: "Cannot reach the plugin backend",
      errNetworkNext: "Make sure the host is still running, then retry.",
      errTimeout: "The backend took too long to answer",
      errTimeoutNext: "The host may be busy. Wait a few seconds and retry.",
      errMissing: "The host has no endpoint for this plugin",
      errMissingNext: "Make sure the plugin is installed in the current profile and the host was restarted.",
      errOrigin: "The host blocked this request",
      errOriginNext: "Write actions are only accepted from this page itself. Reload the browser page and try again.",
      errNoRoot: "The plugin does not know where the host source is",
      errNoRootNext: "Set the host folder as shown on Overview, then restart the host.",
      errBlocked: (n) => `Preflight failed and nothing was written (${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"})`,
      errBlockedNext: "The host is unchanged. The mismatches are listed below and at the top of Patches.",
      errBusy: "Another apply or revert is running",
      errBusyNext: "Wait for it to finish, then press Check again.",
      errDrift: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} changed by another program, so the revert was cancelled`,
      errDriftNext: "Nothing on disk changed. Restore these files (or reinstall the host) first, then revert.",
      errNotApplied: "There is no apply record, so nothing to revert",
      errNotAppliedNext: "The plugin has not changed any host files.",
      errWriteHalf: "Writing failed halfway; the plugin tried to roll back",
      errWriteHalfNext: "Do not keep retrying. Keep the breaklimit folder in your DSH data directory and follow the Revert and uninstall section of the install guide.",
      errState: "The apply record is damaged or from another version, so the plugin stopped",
      errStateNext: "Follow the Revert and uninstall section of the install guide for the breaklimit folder.",
      errTooLarge: "The content is over the size limit",
      errTooLargeNext: "Shorten it and save again.",
      errWrite: "Could not write to disk",
      errWriteNext: "Check the permissions and free space of your DSH data directory, then try again.",
      errRequest: "The request was malformed (a plugin bug)",
      errRequestNext: "Press Check again and retry. If it keeps happening, report the error code to the author.",
      errUnknownPatch: "The backend does not know this patch",
      errUnknownPatchNext: "The patch list may have changed. Press Check again to refresh.",
      errRule: "The rule action was refused",
      errRuleNext: "The rule may have been deleted or its file is unreadable. Press Check again to refresh the list.",
      errRuleBodyWrite: "Failed to write rule body file",
      errRuleBodyWriteNext: "Check disk space or directory permissions. The rules index was untouched.",
      errRuleIndex: "Failed to update rules index",
      errRuleIndexNext: "Check permissions of rules.json in the data directory.",
      errRuleIndexWithBody: "Body saved, but failed to update rules index",
      errRuleIndexWithBodyNext: "The new body is in bodies/, but rules.json was not updated. Try saving again.",
      errRuleLanding: "Body and index saved, but failed to sync landing file",
      errRuleLandingNext: "The rule is saved in bodies/ and the index, but writing to the target file failed. Check if it is locked or write-protected.",
      errRuleConflict: "The rules index changed in another window during the save",
      errRuleConflictNext: "This save did not overwrite it. Press Check again to load the latest list, then save once more.",
      errRuleTarget: "The target must be AGENTS.md or CLAUDE.md",
      errRuleTargetNext: "Reopen this rule and pick a file under Where to write.",
      errRuleBodyRemove: "The rule was removed from the list, but its body file was not deleted",
      errRuleBodyRemoveNext: "It no longer appears in the list; the body stays in bodies/ if you want to delete it by hand.",
      errServer: "The plugin backend failed",
      errServerNext: "Press Check again. If it keeps happening, report the error code to the author.",
      errUnknown: "The action did not succeed",
      errUnknownNext: "Press Check again to see the current state. If it keeps happening, report the error code to the author.",
      breaklimitButton: "Breaklimit",
      dockPopoverTitle: "Quick Breaklimit Settings",
      dockModeTitle: "Prompt Mode",
      dockTierFailed: "Switch failed; the mode is unchanged.",
      confirmOverwriteAlias: (from) => `Entry "${String(from)}" already exists. Overwrite?`,
      confirmDeleteAlias: (from) => `Delete entry "${String(from)}"?`,
      aliasTitle: "Target words",
      aliasDesc: "Replaces target words in your messages before a request reaches the model. Open a new session after saving.",
      aliasStateEmpty: "Word list empty",
      aliasStateFailed: "Word list unavailable",
      aliasStateMiss: "No swaps this turn",
      aliasStateHit: (n) => `Word list: ${String(n)}`,
      aliasLoading: "Reading word list…",
      aliasEmptyList: "No entries yet",
      aliasFrom: "Word",
      aliasTo: "Replace with",
      aliasAdd: "Add",
      aliasRemove: "Remove",
      aliasConfirmDelete: "Confirm delete?",
      aliasFoot: "Changes apply to new sessions only",
      aliasSaveFailed: "Save failed; nothing changed",
      aliasClose: "Close",

      // Five-tab additions: collapsible first-run steps, word list page,
      // prompt read failure, rule details.
      guideHide: "Hide the steps",
      guideShow: "Show the steps",
      rowWords: "Target word list",
      wordsSummaryCount: (n) => `${String(n)} saved`,
      wordsSummaryEmpty: "No entries yet",
      wordsSummaryFailed: "Read failed; writes paused",
      wordsSummaryHint: "Replaces target words in your messages before a request reaches the model. Open a new session after saving.",
      manageWords: "Manage",
      doneAlreadyNext: "No file was written. This page cannot tell whether the host has been restarted.",
      promptReadFailedTitle: "Could not read the shared prompt",
      promptReadFailedNext: "The current text is unknown; treat it as neither empty nor the builtin. Editing and saving are paused so nothing gets overwritten. Retry the read to continue.",
      promptReadRetry: "Read the prompt again",
      promptUnknownPlaceholder: "(read failed, content unknown)",
      promptCountUnknown: "Content unknown",
      savedMark: "Saved",
      whyPromptUnread: "The prompt has not been read yet, so editing and saving are paused.",
      promptSavingHint: "Saving the submitted text; you can keep typing. New input is kept.",
      donePromptSavedMore: "Saved the submitted text; newer edits are still unsaved",
      donePromptSavedMoreNext: "Text typed during the save stayed in the editor. Keep editing or save again.",
      confirmDiscardPromptTitle: "Discard prompt changes?",
      confirmDiscardPromptBody: "The editor returns to the last saved text; unsaved input is lost.",
      confirmDiscardPromptYes: "Discard changes",
      ruleDetailsTitle: "Rule details",
      ruleDetailActive: (t) => `The body is written into ${String(t)}; saving edits syncs it.`,
      ruleDetailInactive: (t) => `Saving does not activate it; activation writes ${String(t)}.`,
      ruleBodyLoading: "Reading the rule body...",
      ruleBodyFailed: "Could not read the rule body",
      ruleBodyFailedNext: "The rule is still listed. Retry the read, or edit it directly.",
      ruleBodyRetry: "Retry the read",
      ruleSelect: (label) => `View rule ${String(label)}`,
      activateNow: "Activate now",
      wordsTitle: "Word list",
      wordsLead: "Replaces target words in your messages before a request reaches the model. Open a new session after saving.",
      wordsScope: "Only text in your messages is handled. Chat text on screen, system prompts, and tool results are untouched. The local preview is not a record of real session replacements.",
      wordsReadFailedTitle: "Word list read failed; writes and preview are paused",
      wordsReadFailedStale: (n) => `The ${String(n)} entries read earlier are kept below and marked as stale. Retry the read to continue.`,
      wordsReadFailedUnknown: "The content below is unknown; it is not an empty list. Retry the read to continue.",
      wordsRetryRead: "Read the word list again",
      wordsReadOk: "Word list reloaded",
      wordsCount: (n, max) => `${String(n)} / ${String(max)}`,
      wordsStaleTag: "stale",
      wordsAdd: "Add entry",
      wordsLimitNote: (max) => `The ${String(max)}-entry limit is reached. You can still edit or delete entries, or overwrite one with the same original word.`,
      wordsSearchLabel: "Search original or replacement",
      wordsSearchClear: "Clear search",
      wordsNoMatchTitle: "No entry matches",
      wordsNoMatchBody: "Try other characters from the original or replacement. Search only filters the list; it never changes the replacement scope.",
      wordsEmptyTitle: "No entries yet",
      wordsEmptyBody: "Give a target word a new name. Open a new session after saving.",
      wordsEmptyAdd: "Add the first entry",
      wordsEditLabel: (from) => `Edit entry ${String(from)}`,
      wordsDeleteLabel: (from) => `Delete entry ${String(from)}`,
      wordsColFrom: "Original",
      wordsColTo: "Replacement",
      wordsColActions: "Actions",
      wordsEachSave: "Each change is saved on its own. Search only filters the list, not the replacement scope or order.",
      wordsPreviewTitle: "Try the replacement",
      wordsPreviewDesc: "Uses the saved list; the text stays on this page.",
      wordsPreviewInput: "Sample text",
      wordsPreviewPlaceholder: "Type a sentence containing an original word...",
      wordsPreviewOutput: "After replacement",
      wordsPreviewLocal: "local preview",
      wordsPreviewPaused: "Preview paused until the read succeeds.",
      wordsPreviewEmptyList: "The list is empty; add and save entries to try.",
      wordsPreviewInputHint: "Type some sample text.",
      wordsPreviewHit: (n) => `${String(n)} entries matched. Local preview only.`,
      wordsPreviewMiss: "No entry matches this text.",
      wordsPreviewRulesTitle: "Replacement rules and scope",
      wordsPreviewRules1: "Case-sensitive exact matches, longer originals first. Later entries can still match text produced by earlier replacements.",
      wordsPreviewRules2: "The preview saves nothing and records no real session hits. Open a new session after saving.",
      wordEditorAddTitle: "Add entry",
      wordEditorEditTitle: "Edit entry",
      wordEditorHint: "Leading and trailing spaces are trimmed. Each side is at most 64 characters.",
      wordFromLabel: "Original (required)",
      wordToLabel: "Replace with (required)",
      wordFromPlaceholder: "e.g. old name",
      wordToPlaceholder: "e.g. new name",
      wordErrFromEmpty: "Enter the original word.",
      wordErrToEmpty: "Enter the replacement.",
      wordErrSame: "The original and the replacement must differ.",
      wordErrFromLong: (n) => `Original is at most 64 characters; this is ${String(n)}.`,
      wordErrToLong: (n) => `Replacement is at most 64 characters; this is ${String(n)}.`,
      wordErrLimit: (max) => `The ${String(max)}-entry limit is reached. Edit or delete an entry first, or overwrite one with the same original word.`,
      wordCap: (n) => `${String(n)} / 64`,
      wordSave: "Save entry",
      wordNoChange: "Nothing changed; no save needed.",
      wordSaveNote: "Spaces are trimmed; the list updates only after a successful save.",
      wordSavingNote: "Saving; please wait.",
      wordSaveFailedTitle: "Save failed; the draft is kept",
      wordSaveFailedNext: "The saved list is unchanged. Try again when ready.",
      wordSaveUnknownTitle: "No save confirmation; the result is unknown",
      wordSaveUnknownNext: "A network error or timeout does not mean the backend stayed unchanged. The draft is kept; re-read to reconcile before retrying.",
      wordSaved: "Entry saved",
      wordSavedMerged: "Entries merged and saved",
      wordSavedNext: "Open a new session to use it.",
      wordDeleteTitle: (from) => `Delete entry "${String(from)}"?`,
      wordDeleteBody: "Deleting saves the new list right away. Cancel keeps the entry.",
      wordDeleteYes: "Delete entry",
      wordDeleted: "Entry deleted",
      wordOverwriteTitle: (from) => `Overwrite entry "${String(from)}"?`,
      wordOverwriteBody: "This original word already exists; confirming keeps the new replacement.",
      wordOverwriteYes: "Overwrite",
      wordMergeTitle: "Merge with the entry using this word?",
      wordMergeBody: "The edited original word matches another entry; confirming merges both into one.",
      wordMergeYes: "Merge and overwrite",
      wordMergeCurrent: "The record being edited",
      wordMergeDuplicate: "The record it overwrites",
      wordMergeFinal: "The record kept",
      wordBackEdit: "Back to editing",
      wordDiscardTitle: "Discard the entry draft?",
      wordDiscardBody: "Unsaved input is lost; the saved list stays unchanged.",
      wordDiscardYes: "Discard draft",
      wordKeepEdit: "Keep editing",
      wordsManage: "Manage word list",
      wordsFromChatReturn: "Back to the conversation",
      wordsNavHint: "Open Breaklimit in Settings; it lands on the word list page.",

      // Phase 1 components: Dialog guards & hints
      dialogGuardAckRequired: "Check the confirmation box above to enable this button.",
      dialogGuardWordRequired: (word) => `Type "${String(word)}" to enable this button.`,
      dialogGuardReady: "Ready to proceed.",
      dialogConsequenceReversible: "Reversible",
      dialogConsequenceIrreversible: "Irreversible",
      dialogConfirmWordLabel: (word) => `Type ${String(word)} to confirm`,

      // Phase 1 components: StateBlock & data protection
      dataProtectedDisk: "Files on disk have not been modified.",
      dataProtectedRules: "Existing rule bodies remain in the bodies/ directory and were not deleted.",
      stateActionRetry: "Read again",
      stateActionDetails: "View retained data",

      // Phase 1 components: Glossary terms
      termHost: "Host",
      tipHost: "The DeepSeek Harness application itself. Source patches modify its files.",
      termPatch: "Patch",
      tipPatch: "A set of changes to host source code. Applied = written to disk, loaded on host restart.",
      termPreflight: "Preflight",
      tipPreflight: "Pre-flight check before writing: stops completely if code deviates from expectations.",
      termTakeover: "Takeover",
      tipTakeover: "Plugin intervention during current runtime. Stopping it does not undo disk patches.",
      termActivate: "Activate",
      tipActivate: "Writes a rule to instruction files (AGENTS.md / CLAUDE.md) for future conversations.",
      termSharedPrompt: "Shared prompt",
      tipSharedPrompt: "Shared instructions used by both Recommended and Unrestricted modes.",
      termUnrestricted: "Unrestricted",
      tipUnrestricted: "Unrestricted mode: lifts additional self-constraints and raises execution limits.",
      termInstructions: "Instructions",
      tipInstructions: "Instruction files read by models at conversation start (e.g. AGENTS.md, CLAUDE.md).",

      // Phase 3 components and models: 4-stage flow
      flowStep1Title: "Configure host directory",
      flowStep1Done: "Host source found",
      flowStep1Current: "Specify host source location",
      flowStep2Title: "Select patches",
      flowStep2Done: (n) => `Selected ${String(n)} ${Number(n) === 1 ? "patch" : "patches"}`,
      flowStep2Current: "None selected",
      flowStep2Todo: "Configure directory first",
      flowStep3Title: "Check and apply",
      flowStep3Blocked: "Preflight blocked, nothing written",
      flowStep3Revert: "Source reverted",
      flowStep3Done: "Written to disk",
      flowStep3Current: (n) => `${String(n)} ${Number(n) === 1 ? "file" : "files"} pending`,
      flowStep3Todo: "Select patches first",
      flowStep4Title: "Restart host",
      flowStep4Current: "Waiting for host restart",
      flowStep4Done: "Completed",
      flowStep4Todo: "Pending patch application",

      // Phase 3: Action card
      actionCardLabelUrgent: "Action required",
      actionCardLabelNextRoot: "Next - Configure environment",
      actionCardLabelRestart: "One step left - Restart host",
      actionCardLabelNextApply: "Next - Apply patches",
      actionCardLabelOptional: "Select as needed",
      actionCardLabelPass: "Disk check passed",
      actionCardRulesCorruptTitle: "Rules index is unreadable",
      actionCardRulesCorruptBody: "Rule writes are suspended to protect existing manifests and bodies. Review recovery options; patches and prompts remain manageable.",
      actionCardRulesCorruptBtn: "Review rule recovery",
      actionCardBrokenTitle: "State record unreadable",
      actionCardBrokenBody: "Patch state record is corrupted or version mismatched; writes paused to protect source.",
      actionCardRootTitle: "Configure host source directory first",
      actionCardRootBody: "Cannot check patches yet. Configure the host root path as launched, then return to check.",
      actionCardRootBtn: "View configuration steps",
      actionCardBlockedTitle: "Source deviates from patch expectations",
      actionCardBlockedBody: "Preflight blocked. Verify host version and external edits before rechecking; do not blindly overwrite.",
      actionCardBlockedBtn: "View blocking cause",
      actionCardRestartRevertTitle: "Files restored, now restart host",
      actionCardRestartApplyTitle: "Patches written, now restart host",
      actionCardRestartBody: "Disk contents updated, but running host may still execute old code. Refreshing browser will not restart host.",
      actionCardRestartBtn: "View restart steps",
      actionCardPendingTitle: "Apply chosen changes to host",
      actionCardPendingBody: (enabled, pending) => `Selected ${String(enabled)} ${Number(enabled) === 1 ? "patch" : "patches"}, preflight passed. Review purposes and the ${String(pending)} ${Number(pending) === 1 ? "file" : "files"} to be modified before applying.`,
      actionCardPendingBtn: "Review and apply patches",
      actionCardNoneTitle: "No patches selected",
      actionCardNoneBody: "You can still manage prompts and rules. Turning off patch switches keeps already written source changes; use revert to undo.",
      actionCardNoneBtn: "Go pick patches",
      actionCardDoneTitle: "Selected patches in place on disk",
      actionCardDoneBody: "No pending files to write. This check does not mean the host has restarted, nor that runtime behaviors are fully verified.",
      actionCardDoneBtn: "Adjust prompt",

      // Phase 3: Diagnostics
      diagCommit: "Host commit",
      diagHostRoot: "Host root",
      diagHttp: "Plugin HTTP",
      diagHttpMounted: "Mounted",
      diagHttpUnmounted: "Unmounted",
      diagRulesIndex: "Rules index",
      diagRulesCorrupt: "Corrupted",
      diagRulesReadable: "Readable",
      diagLock: "Operation lock",
      diagLockBusy: "Busy",
      diagLockIdle: "Idle",
      diagApplied: "Applied records",
      diagAppliedCount: (n) => `${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      diagAppliedNone: "None",
      diagPreflight: "Patch preflight",
      diagRuntime: "Runtime behavior",
      diagRuntimeNotVerified: "Not verified by this page",

      // Phase 3: Overview and patches extension
      overviewFlowLabel: "Patch application progress",
      overviewConfigTitle: "Core configuration and takeover",
      overviewConfigDesc: "These settings are independent; adjust as needed.",
      overviewEnvTitle: "Environment and permissions",
      overviewEnvDesc: "Prompt mode dictates instructions and execution limits; it does not replace sandbox settings.",
      overviewEffectTitle: "When do changes take effect?",
      overviewEffectPatches: "Source patches",
      overviewEffectPatchesDesc: "Restart host after applying",
      overviewEffectPrompt: "Prompt",
      overviewEffectPromptDesc: "Next conversation turn",
      overviewEffectRules: "Rules",
      overviewEffectRulesDesc: "Written to instruction file on activation",
      overviewEffectWords: "Word list",
      overviewEffectWordsDesc: "Open new session after saving",
      overviewDiagTitle: "View technical diagnostics",
      overviewDiagNote: "Includes local paths, no credentials",
      overviewDiagCopy: "Copy diagnostics",
      overviewDiagCopied: "Diagnostics copied, no credentials included",
      patchFootPending: (n) => `Estimated ${String(n)} ${Number(n) === 1 ? "file" : "files"} to write`,
      patchFootNone: "No pending files to write",
      patchFootBlocked: "Preflight blocked, will not write",
      patchFootReasonDefault: "A snapshot is saved before writing; restart host when done.",

      // Phase 3: PatchesPage and OverviewPage restyle
      patchesSelectedBadge: (n) => `${String(n)} ${Number(n) === 1 ? "patch" : "patches"} selected`,
      sourcePatchesLabel: "Source patches",
      currentPromptModePrefix: "Current prompt mode: ",
      diskInPlace: "In place",
      diskPending: "Pending write",
      diskConflict: "Conflict",
      diskUnapplied: "Unapplied",
      diskUnchecked: "Unchecked",
      patchDisclosureSummary: "Change details and files",
      onlyUnrestricted: "Full takeover only",
      switchModeToSelect: "Switch mode to select",
      modeDisabledHint: "Unavailable",
      blockedNoticeTitle: (n) => `Preflight found ${String(n)} ${Number(n) === 1 ? "inconsistency" : "inconsistencies"}`,
      blockedNoticeBody: "Host source may have been modified externally or version does not match. Review reasons before rechecking.",
      viewBlockReason: "View blocking reason",
      recheckSource: "Recheck source",
      promptMineSummary: "Using custom shared prompt - takes effect next turn",
      promptBuiltinSummary: "Using built-in shared prompt - takes effect next turn",
      rulesCorruptShort: "Manifest corrupted",
      rulesNoneShort: "No active rules",
      rulesCorruptSummary: "Writes suspended to protect existing data",
      rulesActiveSummary: (target) => `Written to ${String(target)}`,
      rulesInactiveSummary: "Save a rule, then activate it to instruction file",
      adjustPrompt: "Adjust",
      manageRules: "Manage",
      viewDetails: "View",
      takeoverStateOn: "Enabled",
      takeoverStateOff: "Paused",
      sandboxFullAccess: "Full access",
      sandboxHostDefault: "Host restricted",

      // Phase 4: Mode tradeoff cards, comparison table, prompt editor & rules guardrails
      // Mode tradeoffs & budget
      modeRecTradeoffGood: "Fits most everyday tasks, keeping self-constraints and warnings for irreversible actions",
      modeRecTradeoffCost: "Long commands and large outputs are truncated earlier",
      modeRecBudget: "Command 20 min · Tool output 0.5 MB · Subagent depth 2",
      modeUnrTradeoffGood: "Longer commands, larger output, and deeper subagents, fully lifting self-constraints",
      modeUnrTradeoffCost: "No longer requires prior warning for irreversible actions; risk must be self-managed",
      modeUnrBudget: "Command 9,999 s · Tool output 1 MB · Subagent depth 5",

      // Mode comparison table
      modeCompareItem: "Item",
      modeCompareCurrent: (label) => (label ? `Now · ${String(label)}` : "Now"),
      modeCompareNext: (label) => (label ? `Next · ${String(label)}` : "Next"),
      modeCompareTimeout: "Command timeout",
      modeCompareOutputDepth: "Tool output / subagent depth",
      modeCompareConstraint: "Self-imposed constraints",
      modeCompareRetained: "Retained",
      modeCompareLifted: "Lifted",
      modeCompareTimeoutRec: "20 min",
      modeCompareTimeoutUnr: "9,999 s",
      modeCompareOutputDepthRec: "0.5 MB / depth 2",
      modeCompareOutputDepthUnr: "1 MB / depth 5",

      // Mode dialog guardrails & notice
      confirmModeAckUnrestricted: "I understand that Unrestricted mode no longer constrains change scope or requires warning before irreversible actions",
      confirmModeConsequence: "You can switch back at any time; takes effect from the next turn",
      modeNoticeSandboxKeep: "Actual execution permissions remain unchanged",
      modeNoticeSandboxKeepDesc: "Selecting Recommended mode does not reduce sandbox permissions; authority is governed by host configuration.",

      // Prompt count & protection
      promptCountExact: (chars, bytes) => `${String(chars)} characters · ${String(bytes)} bytes`,
      promptDirtyReason: "Unsaved changes; takes effect from the next turn after saving.",
      dataProtectedPrompt: "The prompt body file on disk was not modified.",

      // Rules data protection & guardrails
      dataProtectedRulesBodies: "Existing rule bodies remain in the bodies/ directory and were not deleted.",
      confirmDeleteAck: "I confirm that I no longer need this rule",
      confirmDeleteConsequence: "This action cannot be undone; the rule cannot be recovered once deleted",
      confirmRecoverWord: "RESET",
      confirmRecoverConsequence: "After resetting, rule names and activation links from the original list cannot be restored in the UI",
      rulesFilesLocations: "File locations involved",

      // Phase 5 closure additions: Word capacity guard & dock mini window
      wordsLimitNoticeTitle: (max) => `The ${String(max)}-entry limit is reached`,
      wordsLimitNoticeBody: "Cannot add new entries. You can still edit or delete existing entries.",
      dockAliasLimitHint: (n) => `Showing first 3 only; view all ${String(n)} entries in word management.`,
      dockFooterHint: "Esc to close · Each change saved individually",
      dockOpenSettings: "Open Full Settings",
      dockManageAllWords: "Manage All Entries",
      dockAliasInlineDefault: "At most 64 characters each for original and replacement.",
      dockModeHint: "Impact confirmed before switching; applies next turn without altering sandbox permissions.",

      // P2 shell & overview: header, help dialog, three-step guide, tab badges
      helpLabel: "Open the user guide",
      closeSettingsLabel: "Close settings and return to the chat",
      helpTitle: "From setup to effect",
      helpIntro: "Pick a prompt mode first, then choose the source patches. Review the impact and snapshot before applying; restart the same host afterwards.",
      helpEffect: "Source patches load after a host restart; prompt and mode changes apply from the next turn; rules take effect once activated into instruction files; the word list applies to new sessions after saving.",
      guideTitle: "First-time setup in three steps",
      guideProgress: (n) => `Done ${String(n)} / 3`,
      guideDefaultHint: "Has a default",
      guideStep1Title: "Pick a prompt mode",
      guideStep1Body: "Start with Recommended; you can switch any time.",
      guideStep2Title: "Pick the patches you need",
      guideStep2Body: "Review what each one does before switching it on; switches only record choices and never touch source files.",
      guideStep3Title: "Apply, then restart the host",
      guideStep3Body: "Files to change are listed before applying; restart the host the way you always do afterwards.",
      guideGo: "Go",
      guideView: "View",
      tabPendingTitle: (n) => `${String(n)} files pending`,
      tabErrorLabel: "Has errors",
      tabDirtyLabel: "Has unsaved changes",
      envCheckedAt: (t) => `Checked ${String(t)}`,
    },
  }

  // ---- 语言 -----------------------------------------------------------------
  //
  // 宿主的 locale 插件激活后才改写 html lang；这里先读一次，再由 Section 里的
  // MutationObserver 跟随变化。桩环境没有 document 时按英文走。
  function readLanguage() {
    try {
      const htmlLang = document?.documentElement?.lang
      if (typeof htmlLang === "string" && htmlLang !== "") return htmlLang.toLowerCase().startsWith("zh") ? "zh" : "en"
      const nav = navigator?.language
      if (typeof nav === "string" && nav.toLowerCase().startsWith("zh")) return "zh"
    } catch {
      // 读不到就按英文。
    }
    return "en"
  }

  let lang = readLanguage()
  let T = TEXT[lang]

  function refreshText() {
    const next = readLanguage()
    if (next === lang) return false
    lang = next
    T = TEXT[lang]
    return true
  }

  // ---- 请求与错误 -----------------------------------------------------------

  function failure(code, status, data) {
    const error = new Error(code)
    error.code = code
    error.status = status
    error.data = data
    return error
  }

  async function request(path, init) {
    const controller = typeof AbortController === "function" ? new AbortController() : null
    const timer = controller === null ? null : setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    let response
    try {
      response = await fetch(`${API}${path}`, {
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        signal: controller?.signal,
        ...init,
      })
    } catch (cause) {
      throw failure(cause?.name === "AbortError" ? "timeout" : "network", 0, null)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) {
      const code = typeof payload?.code === "string" && payload.code !== "" ? payload.code : `http_${String(response.status)}`
      throw failure(code, response.status, payload?.data ?? null)
    }
    return payload ?? {}
  }

  const get = (path) => request(path, { method: "GET" })
  const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body ?? {}) })
  const put = (path, body) => request(path, { method: "PUT", body: JSON.stringify(body ?? {}) })

  /** 错误码翻译成一句话 + 一个下一步。永远不展示后端 message 或原始 JSON。 */
  function explain(error) {
    const code = String(error?.code ?? "unknown")
    const data = error?.data ?? null
    const make = (title, next, action, extra) => ({ tone: "error", title, next, action: action ?? null, code, ...extra })
    const count = (list) => (Array.isArray(list) ? list.length : 0)
    switch (code) {
      case "network": return make(T.errNetwork, T.errNetworkNext, "retry")
      case "timeout": return make(T.errTimeout, T.errTimeoutNext, "retry")
      case "http_404":
      case "not_found": return make(T.errMissing, T.errMissingNext, null)
      case "http_403":
      case "cross_origin": return make(T.errOrigin, T.errOriginNext, null)
      case "host_root_unconfigured": return make(T.errNoRoot, T.errNoRootNext, "goOverview")
      case "preflight_blocked":
        return make(T.errBlocked(count(data?.blocked)), T.errBlockedNext, "refresh", { items: blockedLines(data?.blocked) })
      case "operation_in_progress": return make(T.errBusy, T.errBusyNext, "refresh", { tone: "warn" })
      case "drift_detected":
        return make(T.errDrift(count(data?.drifted)), T.errDriftNext, null, {
          items: Array.isArray(data?.drifted) ? data.drifted.map(item => String(item?.path ?? "")) : [],
        })
      case "not_applied": return make(T.errNotApplied, T.errNotAppliedNext, null, { tone: "info" })
      case "apply_failed":
      case "revert_failed": return make(T.errWriteHalf, T.errWriteHalfNext, "refresh")
      case "state_corrupt":
      case "state_version_mismatch": return make(T.errState, T.errStateNext, "refresh")
      case "too_large": return make(T.errTooLarge, T.errTooLargeNext, null)
      case "write_failed": return make(T.errWrite, T.errWriteNext, null)
      case "unknown_patch": return make(T.errUnknownPatch, T.errUnknownPatchNext, "refresh")
      case "body_write_failed": return make(T.errRuleBodyWrite, T.errRuleBodyWriteNext, null)
      case "index_write_failed":
        return make(
          data?.bodyWritten ? T.errRuleIndexWithBody : T.errRuleIndex,
          data?.bodyWritten ? T.errRuleIndexWithBodyNext : T.errRuleIndexNext,
          "refresh"
        )
      case "landing_write_failed":
        return make(T.errRuleLanding, T.errRuleLandingNext, "refresh")
      case "conflict": return make(T.errRuleConflict, T.errRuleConflictNext, "refresh")
      // 显式列出：default 里 `invalid_` 一律翻成「请求格式不对（插件内部问题）」，
      // 而 target 非法是用户能自己改的，说成内部问题等于把人挡在门外。
      case "invalid_target": return make(T.errRuleTarget, T.errRuleTargetNext, null)
      case "body_remove_failed": return make(T.errRuleBodyRemove, T.errRuleBodyRemoveNext, "refresh")
      case "rule_invalid":
      case "rule_unreadable": return make(T.errRule, T.errRuleNext, "refresh")
      default:
        if (code.startsWith("invalid_")) return make(T.errRequest, T.errRequestNext, "refresh")
        if (code === "internal_error" || code.startsWith("http_5")) return make(T.errServer, T.errServerNext, "refresh")
        return make(T.errUnknown, T.errUnknownNext, "refresh")
    }
  }

  function blockedLines(list) {
    return Array.isArray(list) ? list.map(item => `${String(item?.patchId ?? "")} · ${String(item?.path ?? "")}`) : []
  }

  // ---- 小工具 ---------------------------------------------------------------

  function merge(...parts) {
    return Object.assign({}, ...parts.filter(Boolean))
  }

  function unique(list) {
    return [...new Set(list)]
  }

  function safeId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "-")
  }

  function pickLang(map) {
    return map !== null && typeof map === "object" && typeof map[lang] === "string" ? map[lang] : ""
  }

  function formatBytes(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return T.bytes(0)
    if (n < 1024) return T.bytes(n)
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  function utf8Length(text) {
    if (typeof TextEncoder !== "undefined") {
      try {
        return new TextEncoder().encode(text).length
      } catch {}
    }
    if (typeof Buffer !== "undefined") {
      try {
        return Buffer.byteLength(text, "utf8")
      } catch {}
    }
    let bytes = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4
        i += 1
      } else bytes += 3
    }
    return bytes
  }

  function formatTime(value) {
    const date = new Date(value ?? "")
    if (Number.isNaN(date.getTime())) return T.timeUnknown
    try {
      return date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    } catch {
      return date.toISOString()
    }
  }

  function formatAgo(at) {
    const minutes = Math.floor((Date.now() - at) / 60000)
    if (minutes < 1) return T.agoJust
    if (minutes < 60) return T.agoMin(minutes)
    return T.agoHour(Math.floor(minutes / 60))
  }

  function modeLabel(mode) {
    return mode === "unrestricted" ? T.modeUnrestricted : T.modeRecommended
  }

  async function writeClipboard(text) {
    try {
      if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") return false
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  // ---- 词库：纯逻辑与两个挂载点共用的状态 -----------------------------------
  //
  // 词表只有一个事实来源（$DSH_HOME/breaklimit/masks.json），PUT 是整表覆盖。
  // 设置页与浮窗各自持有一份 React state，若各拿自己的旧列表去 PUT，后到的那次
  // 会把先写入的条目抹掉。所以写入收敛到一个模块级 store：按操作（增/改/删）
  // 提交，执行时基于最新列表算出整表再写；写入串行，过期响应作废。

  /** 一条映射是否可用。空白、超长、自映射都算不可用。与 host/masks.js 的 validEntry 同口径。 */
  function aliasEntryValid(entry) {
    if (entry === null || typeof entry !== "object") return false
    const { from, to } = entry
    if (typeof from !== "string" || typeof to !== "string") return false
    const source = from.trim()
    const target = to.trim()
    if (source === "" || target === "") return false
    if (source.length > WORD_TERM_MAX || target.length > WORD_TERM_MAX) return false
    if (source === target) return false
    return true
  }

  /** 去空白、丢无效项、按 from 去重（后者覆盖前者）。与 host/masks.js 的 normalizeEntries 同口径。 */
  function normalizeAliasEntries(entries) {
    const out = []
    const seen = new Map()
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!aliasEntryValid(entry)) continue
      const item = { from: entry.from.trim(), to: entry.to.trim() }
      const at = seen.get(item.from)
      if (at === undefined) {
        seen.set(item.from, out.length)
        out.push(item)
      } else {
        out[at] = item
      }
    }
    return out.slice(0, WORDS_MAX)
  }

  /**
   * 本地预览：与 host/masks.js 的 maskText 同一套语义——区分大小写、精确字面匹配、
   * 长词优先、按顺序依次替换，后面的词条可能继续匹配前面替换产生的文本。
   * 不是「模拟真实命中」，只是给用户看保存后的替换效果。
   */
  function maskPreview(text, entries) {
    if (typeof text !== "string" || text === "") return { text, hits: 0, matched: [] }
    const list = normalizeAliasEntries(entries)
    if (list.length === 0) return { text, hits: 0, matched: [] }
    const ordered = [...list].sort((a, b) => b.from.length - a.from.length)
    let out = text
    let hits = 0
    const matched = []
    for (const entry of ordered) {
      if (!out.includes(entry.from)) continue
      const before = out
      out = out.split(entry.from).join(entry.to)
      if (out === before) continue
      hits += 1
      matched.push(entry.from)
    }
    return { text: out, hits, matched }
  }

  /**
   * 一次词条操作落到当前列表后的整表。change 形如
   * `{ type: "save", originalFrom, entry }` 或 `{ type: "delete", from }`。
   * 编辑时把原词改成另一个已有词条的原词，是合并：删掉原来那条，目标那条换成新值。
   */
  // 浮窗的位置与尺寸：刷新后要回到原处，所以存本地；读到脏数据就回落默认值，
  // 不让一条坏记录把开关按钮顶出屏幕。
  const DOCK_LAYOUT_KEY = "bkl.dock.layout"
  const DOCK_MARGIN = 12
  const DOCK_MIN_WIDTH = 320
  const DOCK_MIN_HEIGHT = 280
  const DOCK_DEFAULT_WIDTH = 380

  /** 视口尺寸：拿不到就按一个保守值算，避免浮窗落在 (0,0)。 */
  function viewportSize() {
    const width = typeof window !== "undefined" && Number(window.innerWidth) > 0 ? Number(window.innerWidth) : 1024
    const height = typeof window !== "undefined" && Number(window.innerHeight) > 0 ? Number(window.innerHeight) : 768
    return { width, height }
  }

  /** 把矩形夹进视口：比视口还大就缩到视口内，负坐标推回边距。 */
  function clampDockRect(rect, viewport) {
    const maxWidth = Math.max(DOCK_MIN_WIDTH, viewport.width - DOCK_MARGIN * 2)
    const maxHeight = Math.max(DOCK_MIN_HEIGHT, viewport.height - DOCK_MARGIN * 2)
    const width = Math.min(maxWidth, Math.max(DOCK_MIN_WIDTH, Number(rect?.width) || DOCK_DEFAULT_WIDTH))
    const height = Math.min(maxHeight, Math.max(DOCK_MIN_HEIGHT, Number(rect?.height) || 460))
    const x = Math.min(Math.max(DOCK_MARGIN, Number(rect?.x) || DOCK_MARGIN), Math.max(DOCK_MARGIN, viewport.width - width - DOCK_MARGIN))
    const y = Math.min(Math.max(DOCK_MARGIN, Number(rect?.y) || DOCK_MARGIN), Math.max(DOCK_MARGIN, viewport.height - height - DOCK_MARGIN))
    return { x, y, width, height }
  }

  /** 默认贴在右下：离输入框近，又不遮住它。 */
  function defaultDockRect(viewport) {
    const width = DOCK_DEFAULT_WIDTH
    const height = Math.min(520, Math.max(DOCK_MIN_HEIGHT, viewport.height - 260))
    return clampDockRect({ x: viewport.width - width - 24, y: viewport.height - height - 96, width, height }, viewport)
  }

  /** 读回来的值要么是完整的 v1 记录，要么是空：不合并半截字段。 */
  function parseDockLayout(value) {
    if (value === null || typeof value !== "object" || value.version !== 1) return { version: 1, rect: null }
    const rect = value.rect
    const usable = rect !== null && typeof rect === "object"
      && [rect.x, rect.y, rect.width, rect.height].every((item) => Number.isFinite(item))
      && rect.width > 0 && rect.height > 0
    return { version: 1, rect: usable ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null }
  }

  function readDockLayout() {
    try {
      if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return { version: 1, rect: null }
      return parseDockLayout(JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY) ?? "null"))
    } catch {
      return { version: 1, rect: null }
    }
  }

  /** 存不下不影响这次使用：位置丢失比浮窗打不开轻。 */
  function writeDockLayout(layout) {
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
        localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(layout))
      }
    } catch { /* 配额满或隐私模式，忽略 */ }
  }

  function aliasNextEntries(entries, change) {
    const list = Array.isArray(entries) ? entries : []
    if (change?.type === "delete") return list.filter((item) => item.from !== change.from)
    const entry = { from: String(change?.entry?.from ?? ""), to: String(change?.entry?.to ?? "") }
    const originalFrom = change?.originalFrom ?? null
    const original = originalFrom === null ? -1 : list.findIndex((item) => item.from === originalFrom)
    const duplicate = list.findIndex((item) => item.from === entry.from)
    if (duplicate >= 0 && duplicate !== original) {
      return list.filter((_, index) => index !== original).map((item) => (item.from === entry.from ? entry : item))
    }
    if (original >= 0) return list.map((item, index) => (index === original ? entry : item))
    return list.concat([entry])
  }

  /** 这次写入会不会碰到已有的同名词条："overwrite"（新增撞原词）或 "merge"（改名撞原词），无冲突为 null。 */
  function aliasChangeKind(entries, change) {
    if (change?.type !== "save") return null
    const list = Array.isArray(entries) ? entries : []
    const from = String(change?.entry?.from ?? "")
    const originalFrom = change?.originalFrom ?? null
    const duplicate = list.find((item) => item.from === from)
    if (duplicate === undefined) return null
    return originalFrom === null ? "overwrite" : originalFrom === from ? null : "merge"
  }

  /** 词条输入校验：先去首尾空白再判空、同词、超长、超条数。返回逐项错误文案。 */
  function wordEntryErrors(from, to, options = {}) {
    const source = String(from ?? "").trim()
    const target = String(to ?? "").trim()
    const originalFrom = options.originalFrom ?? null
    const entries = Array.isArray(options.entries) ? options.entries : []
    const maxEntries = options.maxEntries ?? WORDS_MAX
    const maxTerm = options.maxTerm ?? WORD_TERM_MAX
    const errors = { from: "", to: "", limit: "" }
    if (source === "") errors.from = T.wordErrFromEmpty
    else if (source.length > maxTerm) errors.from = T.wordErrFromLong(source.length)
    if (target === "") errors.to = T.wordErrToEmpty
    else if (target.length > maxTerm) errors.to = T.wordErrToLong(target.length)
    else if (source === target) errors.to = T.wordErrSame
    if (originalFrom === null && entries.length >= maxEntries && !entries.some((item) => item.from === source)) {
      errors.limit = T.wordErrLimit(maxEntries)
    }
    return errors
  }

  /** 保存成功后只清掉提交过的那一份；保存期间继续输入的内容必须留下。 */
  function draftAfterSave(draft, submitted) {
    return draft === submitted ? null : draft
  }

  /**
   * 规则保存结果的反馈。保存与激活是两步：这里只在合适时提出「现在激活」的邀请，
   * 任何分支都不会直接激活。返回 activateRule 为可激活的规则 id，无则为 null。
   */
  function ruleSaveNotice(data, activeRuleId, edit) {
    const target = String(data?.target ?? edit.target)
    let notice = { tone: "ok", title: T.ruleSaved, next: undefined, activateRule: null }
    if (data?.landingMoved) notice = { ...notice, title: T.ruleSavedMoved(target) }
    else if (data?.landingSynced) notice = { ...notice, title: T.ruleSavedSynced(target) }
    else if (data?.landingStale) notice = { ...notice, tone: "warn", title: T.ruleSavedStale(target) }
    else if (activeRuleId !== edit.id) notice = { ...notice, title: T.ruleSavedInactive, next: T.ruleSavedInactiveNext }
    if (activeRuleId !== edit.id && !data?.landingStale && !data?.landingMoved && !data?.landingSynced) {
      notice.activateRule = edit.id
    }
    return notice
  }

  // 词库读取错误判定：loading 是正常过程，不报错；只有读取失败或数据过期才算错误。
  function aliasReadError(state) {
    return state?.phase === "failed" || state?.stale === true
  }

  /** 词库共享状态。requests 注入 get/put，测试可以直接喂假接口。 */
  function createAliasStore(requests) {
    const listeners = new Set()
    const state = {
      phase: "loading",       // loading | ready | failed
      entries: [],
      stale: false,           // 读取失败后保留的旧数据；为 true 时禁止写入与预览
      limits: { maxEntries: WORDS_MAX, maxTerm: WORD_TERM_MAX },
      lastHits: 0,
      saving: false,
    }
    // 数据版本号：每次落定 entries 都 +1。读取响应带着开始时的版本回来，
    // 版本对不上说明中间有过写入或更晚的读取，旧响应直接丢弃。
    let version = 0
    let chain = Promise.resolve()
    const emit = () => { for (const listener of [...listeners]) listener() }
    const read = () => {
      const seen = version
      return requests.get("/alias").then((payload) => {
        if (seen !== version || state.saving) return
        const data = payload?.data ?? {}
        // 读取告警可能随 HTTP 200、code=ok 一起回来（message 非空）。此时 entries
        // 不可信：不能把空表当成真的空词库，保留旧数据并标记，同时暂停写入与预览。
        const warned = typeof payload?.message === "string" && payload.message !== ""
        if (warned) {
          state.stale = true
          state.phase = "failed"
          emit()
          return
        }
        // 落定时过一遍归一：后端返回脏条目（非字符串字段）时，渲染层不该因此白屏。
        // 与 host/masks.js 同口径，幂等。
        state.entries = normalizeAliasEntries(data.entries)
        state.limits = {
          maxEntries: Number.isFinite(data.limits?.maxEntries) ? data.limits.maxEntries : WORDS_MAX,
          maxTerm: Number.isFinite(data.limits?.maxTerm) ? data.limits.maxTerm : WORD_TERM_MAX,
        }
        state.lastHits = Number(data.lastHits) || 0
        state.phase = "ready"
        state.stale = false
        version += 1
        emit()
      }).catch(() => {
        if (seen !== version) return
        // 读不到不等于空词库：旧数据留着、标旧，写入与预览暂停。
        if (state.entries.length > 0) state.stale = true
        state.phase = "failed"
        emit()
      })
    }
    // 写入串行：PUT 是整表覆盖，串行 + 执行时基于最新列表计算，两处挂载点才不会互相覆盖。
    const commit = (change) => {
      const task = async () => {
        // 读取失败或数据已标旧时禁止写入：看不清现状就整表覆盖，风险太大。
        if (state.phase === "failed" || state.stale) return { ok: false, unknown: false, refused: true }
        const next = aliasNextEntries(state.entries, change)
        state.saving = true
        emit()
        try {
          const payload = await requests.put("/alias", { entries: next })
          const data = payload?.data ?? {}
          state.entries = normalizeAliasEntries(Array.isArray(data.entries) ? data.entries : next)
          state.phase = "ready"
          state.stale = false
          state.saving = false
          version += 1
          emit()
          return { ok: true }
        } catch (error) {
          state.saving = false
          emit()
          const code = String(error?.code ?? "")
          // 超时/断网不等于后端没写：结果未知，让调用方去重新读取核对，而不是宣布未生效。
          return { ok: false, unknown: code === "timeout" || code === "network" }
        }
      }
      const result = chain.then(task, task)
      chain = result.then(() => undefined, () => undefined)
      return result
    }
    return {
      state,
      read,
      commit,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
  }

  const aliasStore = createAliasStore({ get, put })

  // 浮窗的「管理词库」要把设置分区切到词库页。设置分区只在设置面板里挂载，
  // 事件未必有人接；接不到时把待落地页签留在模块级，分区一挂载就用上。
  let pendingTabRequest = null
  let wordsFromChat = false
  /** apply(ctx) 收下的宿主上下文，供浮窗打开设置分区用。 */
  let hostCtx = null

  /** 词库或档位写完后通知另一个挂载点重拉状态。 */
  function notifyStateChanged() {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent(STATE_CHANGED_EVENT))
    }
  }

  /**
   * 浮窗的「管理词库」：目标是设置分区的词库页。分区已挂载就直接切页；没挂载时
   * 把待落地页签留在模块级（分区一挂载就用上），再让宿主打开设置分区；都不行就
   * 返回 false，由浮窗给一句指引，不假装已经跳过去。
   */
  function openWordsFromDock() {
    pendingTabRequest = "words"
    wordsFromChat = true
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      const detail = { tab: "words", handled: false }
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail }))
      if (detail.handled === true) return true
    }
    return openHostSettingsSection(hostCtx, SECTION_ID)
  }

  /** 让宿主的设置面板直接打开本插件分区。拿不到能力时返回 false，由调用方给提示。 */
  function openHostSettingsSection(ctx, id) {
    try {
      const entries = typeof ctx?.slots?.entries === "function" ? ctx.slots.entries("sidebar.settings") : []
      const decl = entries?.[0]?.store
      const instance = decl !== null && typeof decl?.create === "function" ? decl.create() : null
      const actions = instance?.actions
      if (typeof actions?.openSection === "function") {
        actions.openSection(id)
        return true
      }
      if (typeof actions?.open === "function") {
        actions.open()
        return true
      }
    } catch {
      // 宿主版本换了壳就退回提示文案，不影响词库本身的功能。
    }
    return false
  }

  /**
   * 五个页签在窄屏下横排滚动；选中项要一直留在可视区里。切页后和窗口尺寸变化后
   * 各调一次，只动页签条自己的 scrollLeft，不把整页滚走。
   */
  function revealSelectedTab(tab) {
    if (typeof document === "undefined") return
    const list = document.getElementById("bkl-tablist")
    const node = document.getElementById(`bkl-tab-${String(tab)}`)
    if (list === null || node === null) return
    if (typeof list.getBoundingClientRect !== "function" || typeof node.getBoundingClientRect !== "function") return
    const box = node.getBoundingClientRect()
    const area = list.getBoundingClientRect()
    if (box.right > area.right) list.scrollLeft += box.right - area.right
    else if (box.left < area.left) list.scrollLeft -= area.left - box.left
  }

  // ---- 从后端状态推导结论 ---------------------------------------------------
  //
  // 这里只做归纳，不做判断：是否待写入、是否阻断，全部来自后端预检的 findings。

  function derive(status, patchInfo, tierInfo, override, restart) {
    const pre = status?.preflight ?? null
    const preCode = typeof pre?.code === "string" ? pre.code : null
    const patches = Array.isArray(patchInfo?.patches) ? patchInfo.patches : []
    const findings = Array.isArray(pre?.findings) ? pre.findings : []
    const blocked = Array.isArray(pre?.blocked) ? pre.blocked : []
    const pendingPaths = unique(findings.filter(item => item?.state === "pending").map(item => String(item.path ?? "")))
    const pendingFiles = Number.isFinite(pre?.pendingFiles) ? pre.pendingFiles : pendingPaths.length
    const tier = MODES.includes(tierInfo?.tier) ? tierInfo.tier : MODES.includes(status?.tier?.active) ? status.tier.active : MODES[0]
    return {
      pre,
      preCode,
      preKnown: preCode === "ok" || preCode === "blocked",
      patches,
      findings,
      blocked,
      pendingPaths,
      pendingFiles,
      rootMissing: status !== null && (preCode === "host_root_unconfigured" || !status.hostRoot),
      broken: status !== null && ((status.stateProblem !== null && status.stateProblem !== undefined)
        || preCode === "state_corrupt" || preCode === "state_version_mismatch"),
      lockBusy: status?.lock?.busy === true,
      applied: status?.applied ?? null,
      enabledCount: patches.filter(patch => patch.enabled === true).length,
      total: patches.length,
      mode: tier,
      rules: Array.isArray(status?.rules) ? status.rules : [],
      activeRule: typeof status?.activeRule === "string" ? status.activeRule : null,
      rulesIndex: status?.rulesIndex ?? "ok",
      // 后端给的是相对 `$DSH_HOME` 的路径；拿不到时退回包里写死的默认位置，
      // 免得提示里出现一个空路径。
      rulesIndexPath: typeof status?.rulesIndexPath === "string" && status.rulesIndexPath !== ""
        ? status.rulesIndexPath
        : "breaklimit/rules.json",
      customPrompt: override?.userFileExists === true,
      restartPending: restart !== null,
    }
  }

  function nextStep(f, loadError) {
    if (loadError) return { tone: "error", title: loadError.title, body: loadError.next, primary: { label: T.retry, action: "retry" } }
    if (f.rulesIndex === "corrupt") {
      return {
        tone: "error",
        title: T.nsRulesCorruptTitle,
        body: T.nsRulesCorruptBody(f.rulesIndexPath),
        primary: { label: T.recoverRules, action: "recoverRules" },
        secondary: { label: T.recheck, action: "refresh" },
      }
    }
    if (f.broken) return { tone: "error", title: T.nsBrokenTitle, body: T.nsBrokenBody, primary: { label: T.recheck, action: "refresh" } }
    if (f.rootMissing) {
      return {
        tone: "warn", title: T.nsRootTitle, body: T.nsRootBody, snippet: T.nsRootSnippet,
        primary: { label: T.copyCommand, action: "copyRoot" }, secondary: { label: T.recheck, action: "refresh" },
      }
    }
    if (f.lockBusy) return { tone: "info", title: T.nsLockTitle, body: T.nsLockBody, primary: { label: T.recheck, action: "refresh" } }
    if (f.blocked.length > 0) {
      return { tone: "error", title: T.nsBlockedTitle(f.blocked.length), body: T.nsBlockedBody, primary: { label: T.goPatchesSee, action: "goPatches" } }
    }
    if (f.total > 0 && f.enabledCount === 0) {
      return { tone: "info", title: T.nsNoneTitle, body: T.nsNoneBody, primary: { label: T.goPatchesPick, action: "goPatches" } }
    }
    if (f.pendingFiles > 0) {
      return { tone: "accent", title: T.nsPendingTitle(f.pendingFiles), body: T.nsPendingBody, primary: { label: T.goPatchesApply, action: "goPatches" } }
    }
    return { tone: "ok", title: T.nsDoneTitle, body: T.nsDoneBody, secondary: { label: T.goPrompt, action: "goPrompt" } }
  }

  function stepItems(f) {
    let applyState = "todo"
    let applyValue = T.unknown
    if (f.broken || f.blocked.length > 0) {
      applyState = "error"
      applyValue = f.broken ? T.stepBroken : T.blockedN(f.blocked.length)
    } else if (f.rootMissing) {
      applyValue = T.stepNoRoot
    } else if (f.restartPending) {
      applyState = "warn"
      applyValue = T.stepWaitRestart
    } else if (f.pendingFiles > 0) {
      applyValue = T.pendingN(f.pendingFiles)
    } else if (f.preKnown) {
      applyState = "done"
      applyValue = T.stepInPlace
    }
    return [
      { key: "mode", tab: "prompt", state: "done", title: T.step1Title, value: modeLabel(f.mode), desc: T.step1Desc },
      {
        key: "pick", tab: "patches", state: f.enabledCount > 0 ? "done" : "todo", title: T.step2Title,
        value: f.total === 0 ? T.unknown : T.pickedOf(f.enabledCount, f.total), desc: T.step2Desc,
      },
      { key: "apply", tab: "patches", state: applyState, title: T.step3Title, value: applyValue, desc: T.step3Desc },
    ]
  }

  /** 一条补丁的磁盘状态：只看后端预检对它的判定；关掉的补丁不在预检范围里。 */
  function diskState(patch, f) {
    if (f.rootMissing || f.broken || !f.preKnown) return "unknown"
    const own = f.findings.filter(item => item?.patchId === patch.id)
    if (own.length === 0) return patch.enabled === true ? "unknown" : "skipped"
    if (own.some(item => item.state === "conflict" || item.state === "unsatisfied" || item.state === "missing" || item.state === "applied_other")) return "blocked"
    if (own.some(item => item.state === "pending")) return "pending"
    return "ready"
  }

  function applyReason(f, busy, toggles) {
    if (busy) return T.whyBusy
    if (Object.keys(toggles).length > 0) return T.whyToggling
    if (f.rootMissing) return T.whyNoRoot
    if (f.broken) return T.whyBroken
    if (f.lockBusy) return T.whyLock
    if (f.blocked.length > 0) return T.whyBlocked(f.blocked.length)
    if (f.total > 0 && f.enabledCount === 0) return T.whyNoneSelected
    if (f.pendingFiles === 0) return T.whyNothing
    return null
  }

  function revertReason(f, busy) {
    if (busy) return T.whyBusy
    if (f.rootMissing) return T.whyNoRoot
    if (f.broken) return T.whyBroken
    if (f.lockBusy) return T.whyLock
    if (f.applied === null) return T.whyNotApplied
    return null
  }

  function actionLabel(action) {
    if (action === "retry") return T.retry
    if (action === "retryPrompt") return T.promptReadRetry
    if (action === "retryAlias") return T.wordsRetryRead
    if (action === "goOverview") return T.goOverview
    if (action === "goPatches") return T.goPatches
    if (action === "goPrompt") return T.goPrompt
    if (action === "goRules") return T.goRules
    if (action === "goWords") return T.goWords
    if (action === "activateNow") return T.activateNow
    if (action === "recoverRules") return T.recoverRules
    return T.recheck
  }

  // ---- 阶段三纯函数建模 ----------------------------------------------------

  function redactPath(value) {
    if (typeof value !== "string" || value === "") return ""
    const parts = value
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part !== "" && part !== ".")
    if (parts.length < 2) return value
    return `…/${parts[parts.length - 1]}`
  }

  function flowSteps(status, f) {
    const effectiveF = f || derive(status)
    const chosen = effectiveF.enabledCount ?? 0
    const count = effectiveF.pendingFiles ?? 0
    const hasRoot = !effectiveF.rootMissing
    const isRestart = effectiveF.restartPending || Boolean(status?.restart)
    const isRevert = status?.restart === "revert" || effectiveF.restart === "revert"
    const isBlocked = (effectiveF.blocked?.length ?? 0) > 0 || effectiveF.broken === true
    const hasApplied = effectiveF.applied !== null && effectiveF.applied !== undefined

    const s1 = hasRoot ? "done" : "current"
    const s2 = !hasRoot ? "todo" : chosen > 0 ? "done" : "current"
    const s3 = isRestart
      ? "done"
      : !hasRoot || chosen === 0
        ? "todo"
        : isBlocked
          ? "blocked"
          : count > 0
            ? "current"
            : hasApplied
              ? "done"
              : "todo"
    const s4 = isRestart ? "current" : s3 === "done" ? "done" : "todo"

    return [
      [
        T.flowStep1Title,
        s1,
        s1 === "done" ? T.flowStep1Done : T.flowStep1Current,
      ],
      [
        T.flowStep2Title,
        s2,
        chosen > 0 ? T.flowStep2Done(chosen) : s2 === "todo" ? T.flowStep2Todo : T.flowStep2Current,
      ],
      [
        T.flowStep3Title,
        s3,
        s3 === "blocked"
          ? T.flowStep3Blocked
          : isRevert
            ? T.flowStep3Revert
            : s3 === "done"
              ? T.flowStep3Done
              : s3 === "current"
                ? T.flowStep3Current(count)
                : T.flowStep3Todo,
      ],
      [
        T.flowStep4Title,
        s4,
        s4 === "current" ? T.flowStep4Current : s4 === "done" ? T.flowStep4Done : T.flowStep4Todo,
      ],
    ]
  }

  function deriveActionCard(status, f) {
    const effectiveF = f || derive(status)
    if (effectiveF.rulesIndex === "corrupt") {
      return {
        tone: "error",
        label: T.actionCardLabelUrgent,
        title: T.actionCardRulesCorruptTitle,
        body: T.actionCardRulesCorruptBody,
        button: T.actionCardRulesCorruptBtn,
        action: "goRules",
        icon: "alert",
      }
    }
    if (effectiveF.broken) {
      return {
        tone: "error",
        label: T.actionCardLabelUrgent,
        title: T.actionCardBrokenTitle,
        body: T.actionCardBrokenBody,
        button: T.recheck,
        action: "refresh",
        icon: "alert",
      }
    }
    if (effectiveF.rootMissing) {
      return {
        tone: "warn",
        label: T.actionCardLabelNextRoot,
        title: T.actionCardRootTitle,
        body: T.actionCardRootBody,
        button: T.actionCardRootBtn,
        action: "configureRoot",
        icon: "folder",
      }
    }
    if ((effectiveF.blocked?.length ?? 0) > 0) {
      return {
        tone: "error",
        label: T.actionCardLabelUrgent,
        title: T.actionCardBlockedTitle,
        body: T.actionCardBlockedBody,
        button: T.actionCardBlockedBtn,
        action: "goPatches",
        icon: "alert",
      }
    }
    if (effectiveF.restartPending || Boolean(status?.restart)) {
      const isRevert = status?.restart === "revert" || effectiveF.restart === "revert"
      return {
        tone: "warn",
        label: T.actionCardLabelRestart,
        title: isRevert ? T.actionCardRestartRevertTitle : T.actionCardRestartApplyTitle,
        body: T.actionCardRestartBody,
        button: T.actionCardRestartBtn,
        action: "restartHelp",
        icon: "refresh",
      }
    }
    if ((effectiveF.pendingFiles ?? 0) > 0) {
      return {
        tone: "",
        label: T.actionCardLabelNextApply,
        title: T.actionCardPendingTitle,
        body: T.actionCardPendingBody(effectiveF.enabledCount ?? 0, effectiveF.pendingFiles),
        button: T.actionCardPendingBtn,
        action: "goPatches",
        icon: "arrow",
      }
    }
    if ((effectiveF.total ?? 0) > 0 && (effectiveF.enabledCount ?? 0) === 0) {
      return {
        tone: "",
        label: T.actionCardLabelOptional,
        title: T.actionCardNoneTitle,
        body: T.actionCardNoneBody,
        button: T.actionCardNoneBtn,
        action: "goPatches",
        icon: "patch",
      }
    }
    return {
      tone: "ok",
      label: T.actionCardLabelPass,
      title: T.actionCardDoneTitle,
      body: T.actionCardDoneBody,
      button: T.actionCardDoneBtn,
      action: "goPrompt",
      icon: "check",
    }
  }

  function formatDiagnostics(status, f) {
    const effectiveF = f || derive(status)
    const targetCommit = status?.target?.commit ? String(status.target.commit).slice(0, 12) : T.unknown
    const hostRootText = status?.hostRoot ? redactPath(status.hostRoot) : T.rootMissingShort
    const httpText = status?.http?.mounted === true ? T.diagHttpMounted : T.diagHttpUnmounted
    const rulesText = effectiveF.rulesIndex === "corrupt" || status?.rulesIndex === "corrupt"
      ? T.diagRulesCorrupt
      : T.diagRulesReadable
    const lockText = status?.lock?.busy === true ? T.diagLockBusy : T.diagLockIdle
    const appliedFilesCount = effectiveF.applied?.files ?? status?.applied?.files
    const appliedText = (appliedFilesCount !== undefined && appliedFilesCount !== null)
      ? T.diagAppliedCount(appliedFilesCount)
      : T.diagAppliedNone
    const preCode = status?.preflight?.code ? String(status.preflight.code) : T.unknown

    return [
      `${T.diagCommit}: ${targetCommit}`,
      `${T.diagHostRoot}: ${hostRootText}`,
      `${T.diagHttp}: ${httpText}`,
      `${T.diagRulesIndex}: ${rulesText}`,
      `${T.diagLock}: ${lockText}`,
      `${T.diagApplied}: ${appliedText}`,
      `${T.diagPreflight}: ${preCode}`,
      `${T.diagRuntime}: ${T.diagRuntimeNotVerified}`,
    ].join("\n")
  }

  // ---- 共用小件 -------------------------------------------------------------

  /**
   * 不可点的按钮用 aria-disabled 而不是 disabled：保留键盘焦点，读屏能通过
   * aria-describedby 读到「为什么不能点」。
   */
  function Button({ kind = "plain", size, off, reason, describedBy, label, expanded, controls, buttonRef, autofocus, className = "", style, onClick, children }) {
    const filled = kind === "primary" || kind === "danger"
    const link = kind === "link"
    const icon = kind === "icon"
    const classes = ["bkl-btn", filled ? "bkl-btn-fill" : link ? "bkl-btn-link" : icon ? "bkl-btn-icon" : "bkl-btn-plain", className].filter(Boolean).join(" ")
    return h("button", {
      type: "button",
      ref: buttonRef,
      className: classes,
      // 弹窗里指定初始焦点用；Dialog 打开时优先找这个标记。
      "data-bkl-autofocus": autofocus === true ? "true" : undefined,
      style: merge(
        S.btn,
        kind === "primary" && S.btnPrimary,
        kind === "danger" && S.btnDanger,
        kind === "quiet" && S.btnQuiet,
        kind === "quietDanger" && S.btnQuietDanger,
        link && S.btnLink,
        icon && S.btnIcon,
        size === "small" && !link && !icon && S.btnSmall,
        off && S.btnOff,
        style,
      ),
      "aria-disabled": off ? "true" : undefined,
      "aria-describedby": describedBy,
      "aria-label": label,
      "aria-expanded": expanded,
      "aria-controls": controls,
      title: off && reason ? reason : undefined,
      onClick: (event) => {
        if (off) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      },
    }, children)
  }

  /** role="switch" 的原生按钮：空格与回车由浏览器转成 click。 */
  function Switch({ on, off, labelledBy, describedBy, label, onToggle }) {
    return h("button", {
      type: "button",
      role: "switch",
      className: "bkl-switch",
      "aria-checked": on ? "true" : "false",
      "aria-disabled": off ? "true" : undefined,
      "aria-labelledby": labelledBy,
      "aria-describedby": describedBy,
      "aria-label": label,
      style: merge(S.switchTrack, on && S.switchOn, off && S.btnOff),
      onClick: () => { if (!off) onToggle(!on) },
    }, h("span", { className: "bkl-knob", "aria-hidden": "true", style: merge(S.switchKnob, on && S.switchKnobOn) }))
  }

  function Dot({ tone }) {
    return h("span", { "aria-hidden": "true", style: merge(S.dot, { background: TONE_COLOR[tone] ?? tk.line4 }) })
  }

  function Tag({ tone, children }) {
    const color = tone === undefined ? null : TONE_COLOR[tone]
    return h("span", { style: merge(S.tag, color && S.tagTone, color && { color }) },
      color ? h("span", { "aria-hidden": "true", style: merge(S.dot, { background: "currentColor", borderRadius: "50%" }) }) : null,
      children)
  }

  function Card({ className, title, titleId, desc, descId, aside, style, children }) {
    const cardClass = className ? `bkl-card ${className}` : "bkl-card"
    return h("section", { className: cardClass, style: merge(S.card, style), "aria-labelledby": title === undefined ? undefined : titleId },
      title === undefined
        ? null
        : h("div", { className: "bkl-card-head", style: S.cardHead },
          h("div", { style: S.cardHeadText },
            h("h3", { id: titleId, style: S.cardTitle }, title),
            desc === undefined ? null : h("p", { id: descId, style: S.small }, desc)),
          aside ?? null),
      children)
  }

  function PathList({ items }) {
    const shown = items.slice(0, LIST_LIMIT)
    const rest = items.length - shown.length
    return h("ul", { style: S.pathList },
      shown.map((item, index) => h("li", { key: `p${String(index)}`, style: S.pathItem }, item)),
      rest > 0 ? h("li", { key: "more", style: S.pathMore }, T.andMore(rest)) : null)
  }

  const SVG_SHAPES = {
    info: "M12 8h.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    alert: "m12 3 10 18H2L12 3ZM12 9v5M12 17h.01",
    checkCircle: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M8 12l3 3 5-6",
    xCircle: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M9 9l6 6M15 9l-6 6",
    shield: "M12 3 3 7v6c0 4 9 8 9 8s9-4 9-8V7l-9-4ZM8 12l3 3 5-5",
    undo: "M9 5 3 11l6 6M3 11h12a6 6 0 0 1 0 12",
    refresh: "M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
    file: "M14 2H5v20h14V7l-5-5ZM14 2v5h5M8 12h8M8 16h6",
    dictionary: "M4 3h15v18H4V3ZM7 3v18M10 7h6M10 11h4",
    terminal: "m5 7 5 5-5 5m8 0h6",
    code: "m8 5-7 7 7 7m8-14 7 7-7 7",
    bolt: "m13 2-9 12h7l-1 8 10-12h-7l1-8",
    search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    close: "m6 6 12 12M6 18 18 6",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    check: "m5 12 4 4L19 6",
    bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z",
    clock: "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    chat: "M21 4H3v14h5l4 4v-4h9V4Z",
    folder: "M3 6h7l2 2h9v12H3V6Z",
    patch: "m7 3 14 14-4 4L3 7l4-4ZM14 7l3-3M4 17l3-3M10 6l-4 4M18 14l-4 4",
    copy: "M9 9h12v12H9zM15 9V3H3v12h6",
    chevron: "m9 18 6-6-6-6",
    plus: "M12 5v14M5 12h14",
    trash: "M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",
    edit: "M15 5l4 4M4 20l4-1L21 6l-4-4L4 16v4Z",
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    text: "M4 5h16M12 5v15M8 20h8",
    help: "M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  }

  function Icon({ name, size = 16, style, className = "" }) {
    const d = SVG_SHAPES[name] || SVG_SHAPES.info
    return h("svg", {
      className: `bkl-icon ${className}`,
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      style: merge({ flexShrink: 0, verticalAlign: "middle" }, style),
    }, h("path", { d }))
  }

  const GLOSSARY_MAP = {
    host: () => ({ word: T.termHost, tip: T.tipHost }),
    patch: () => ({ word: T.termPatch, tip: T.tipPatch }),
    preflight: () => ({ word: T.termPreflight, tip: T.tipPreflight }),
    takeover: () => ({ word: T.termTakeover, tip: T.tipTakeover }),
    activate: () => ({ word: T.termActivate, tip: T.tipActivate }),
    sharedPrompt: () => ({ word: T.termSharedPrompt, tip: T.tipSharedPrompt }),
    unrestricted: () => ({ word: T.termUnrestricted, tip: T.tipUnrestricted }),
    instructions: () => ({ word: T.termInstructions, tip: T.tipInstructions }),
  }

  function Term({ termKey, word, tip, label, children }) {
    const fn = termKey ? GLOSSARY_MAP[termKey] : null
    const pair = fn ? fn() : null
    const displayWord = children ?? label ?? (pair ? pair.word : word)
    const displayTip = pair ? pair.tip : tip
    if (!displayTip) return h("span", null, displayWord)
    return h("span", {
      className: "bkl-term",
      tabIndex: 0,
      role: "note",
      "data-tip": displayTip,
      "aria-label": `${String(displayWord)} (${String(displayTip)})`,
      style: S.term,
    }, displayWord)
  }

  const PAGE_EFFECTS = {
    patches: { icon: "refresh", when: () => T.whenRestart },
    prompt: { icon: "clock", when: () => T.whenNextTurn },
    rules: { icon: "file", when: () => T.whenActivate },
    words: { icon: "chat", when: () => T.whenNewSession },
  }

  const PAGE_TIPS_MAP = {
    overview: () => ({ text: T.tipOverviewText, what: T.tipOverviewText, pitfall: T.tipOverviewPitfall }),
    patches: () => ({ text: T.tipPatchesText, what: T.tipPatchesText, pitfall: T.tipPatchesPitfall }),
    prompt: () => ({ text: T.tipPromptText, what: T.tipPromptText, pitfall: T.tipPromptPitfall }),
    rules: () => ({ text: T.tipRulesText, what: T.tipRulesText, pitfall: T.tipRulesPitfall }),
    words: () => ({ text: T.tipWordsText, what: T.tipWordsText, pitfall: T.tipWordsPitfall }),
  }

  /** 页面顶部新手引导卡片（这页做什么 + 常见误区） */
  function PageTip({ page, pageKey, dismissed, tipOpen, onDismiss }) {
    const target = page ?? pageKey
    const [hidden, setHidden] = useState(false)
    if (tipOpen === false || dismissed === true || hidden || !target) return null
    const getter = PAGE_TIPS_MAP[target]
    if (!getter) return null
    const spec = getter()

    return h("div", {
      className: "bkl-tip bkl-fade",
      role: "region",
      "aria-label": T.pageTipRegionLabel,
      style: S.pageTip,
    },
      h("span", { className: "bkl-tip-icon", style: S.pageTipIcon },
        h(Icon, { name: "bulb", size: 16 })),
      h("div", { className: "bkl-tip-content", style: S.pageTipContent },
        h("strong", { style: S.pageTipLead }, T.pageTipHeading),
        h("span", { style: S.pageTipText }, spec.text),
        h("span", { className: "bkl-tip-pitfall", style: S.pageTipPitfall }, spec.pitfall)),
      h("button", {
        type: "button",
        className: "bkl-tip-close",
        style: S.pageTipClose,
        title: T.pageTipDismiss,
        "aria-label": T.pageTipDismiss,
        onClick: () => {
          setHidden(true)
          if (onDismiss) onDismiss(target)
        },
      }, h(Icon, { name: "close", size: 14 })))
  }

  /** 每页顶部：大标题、一句说明、生效时机、右侧操作与页面提示插槽。 */
  function PageHead({ page, title, desc, when, effectIcon, aside, titleId, tipOpen = true, onDismissTip, children }) {
    const fx = page ? PAGE_EFFECTS[page] : null
    const fxIcon = effectIcon || fx?.icon
    const effectiveWhen = when !== undefined ? when : (fx?.when ? fx.when() : undefined)
    const whenPrefix = T.whenTag("")
    const whenText = effectiveWhen === undefined
      ? null
      : (typeof effectiveWhen === "string" && effectiveWhen.startsWith(whenPrefix))
        ? effectiveWhen
        : T.whenTag(effectiveWhen)

    return h("div", { style: S.pageHeadWrap },
      h("div", { style: S.pageHead },
        h("div", { style: S.pageHeadText },
          h("h2", { id: titleId, style: S.pageTitle }, title),
          desc === undefined ? null : h("p", { style: S.pageDesc }, desc)),
        whenText === null ? null : h("span", { className: "bkl-badge-effect", style: S.whenTag },
          fxIcon ? h(Icon, { name: fxIcon, size: 13, style: { marginRight: "4px" } }) : null,
          whenText),
        aside ?? null),
      tipOpen && page ? h(PageTip, { page, onDismiss: onDismissTip }) : null,
      children ?? null)
  }

  function StateBlock({ tone = "empty", icon: customIcon, title, body, data, actions, extra, compact = false }) {
    const defaultIcon = {
      empty: "info",
      loading: "refresh",
      warn: "alert",
      error: "xCircle",
    }[tone] || "info"

    const isSpin = tone === "loading"
    const iconName = customIcon || defaultIcon
    const iconTone = tone === "empty" ? "idle" : tone

    return h("div", {
      className: `bkl-state bkl-state-${tone} ${compact ? "bkl-state-compact" : ""} bkl-pop`,
      role: tone === "error" ? "alert" : "status",
      style: merge(
        S.stateBlock,
        tone === "empty" && S.stateEmpty,
        tone === "warn" && S.stateWarn,
        tone === "error" && S.stateError,
        tone === "loading" && S.stateLoading,
        compact && S.stateCompact,
      ),
    },
      h("span", {
        className: "bkl-state-icon",
        style: merge(
          S.stateIcon,
          {
            background: TONE_SOFT[iconTone] ?? tk.well,
            color: TONE_COLOR[iconTone] ?? tk.label,
            border: `1px solid ${TONE_LINE[iconTone] ?? tk.line2}`,
          },
        ),
      },
        isSpin
          ? h("span", { className: "bkl-spinner", style: S.spinner })
          : h(Icon, { name: iconName, size: 24 })),
      h("h3", { style: merge(S.stateTitle, tone === "error" && { color: tk.error }) }, title),
      body ? h("p", { style: S.stateBody }, body) : null,
      data
        ? h("p", { className: "bkl-notice-data", style: S.noticeDataCenter },
            h(Icon, { name: "shield", size: 14, style: { color: tk.ok } }),
            h("span", null, data))
        : null,
      actions && actions.length > 0
        ? h("div", { className: "bkl-state-actions", style: S.stateActions }, actions)
        : null,
      extra
        ? h("div", { className: "bkl-state-extra", style: S.stateExtra }, extra)
        : null)
  }

  function Notice({ notice, title, body, next, tone: propTone, data, items: propItems, action, code, actions, onAction, onDismiss }) {
    const rawTone = propTone ?? notice?.tone ?? "info"
    const tone = rawTone === "ok" ? "success" : rawTone
    const headTitle = title ?? notice?.title
    const bodyText = body ?? next ?? notice?.next ?? notice?.body
    const dataText = data ?? notice?.data
    const items = (propItems ?? notice?.items ?? []).filter(item => typeof item === "string" && item !== "")
    const actionKey = action ?? notice?.action
    const errorCode = code ?? notice?.code

    const toneIcons = {
      info: "info",
      warn: "alert",
      error: "xCircle",
      success: "checkCircle",
      loading: "refresh",
    }

    return h("div", {
      className: `bkl-notice bkl-notice-${tone} bkl-fade`,
      role: tone === "error" ? "alert" : "status",
      style: merge(
        S.noticeBox,
        tone === "info" && S.noticeInfo,
        tone === "warn" && S.noticeWarn,
        tone === "error" && S.noticeError,
        (tone === "success" || tone === "ok") && S.noticeSuccess,
        tone === "loading" && S.noticeLoading,
      ),
    },
      h("span", {
        className: "bkl-notice-icon",
        style: merge(S.noticeIconBox, { color: TONE_COLOR[tone] ?? tk.accent }),
      },
        tone === "loading"
          ? h("span", { className: "bkl-spinner", style: S.spinnerSm })
          : h(Icon, { name: toneIcons[tone] || "info", size: 15 })),
      h("div", { style: S.noticeGrow },
        h("div", { style: S.noticeHeadRow },
          h("strong", { style: merge(S.noticeTitle, { color: TONE_COLOR[tone] ?? tk.label }) }, headTitle),
          onDismiss ? h(Button, { kind: "quiet", size: "small", label: T.dismiss, onClick: onDismiss }, T.dismissShort) : null),
        bodyText ? h("p", { style: S.noticeBodyText }, bodyText) : null,
        items.length > 0 ? h(PathList, { items }) : null,
        dataText ? h("p", { className: "bkl-notice-data", style: S.noticeDataLeft },
          h(Icon, { name: "shield", size: 13, style: { color: tk.ok } }),
          h("span", null, dataText)) : null,
        (actionKey || actions || errorCode)
          ? h("div", { style: S.noticeActionRow },
              actionKey && onAction
                ? h(Button, { size: "small", onClick: () => { onAction(actionKey) } }, actionLabel(actionKey))
                : null,
              actions ?? null,
              errorCode ? h("span", { style: S.spacer }) : null,
              errorCode ? h("span", { style: S.code }, T.errorCode(errorCode)) : null)
          : null))
  }

  // 弹窗：原生 <dialog> + showModal。Esc（cancel）走 onClose；打开后焦点先落到首个
  // 可聚焦控件，关闭后回到触发它的元素；正文区自己滚动，页脚常驻可达。
  // 不可点的按钮继续用 aria-disabled，行为与页面其他按钮一致。
  const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])"

  // 两个 Dialog 常驻挂载、只切 open，所以标题与正文的 id 必须分开：
  // aria-labelledby 按 id 在整篇文档里找，共用 id 时后一个弹窗会读到前一个的标题。
  function Dialog({
    open,
    idBase = "bkl-dialog",
    title,
    tone = "accent",
    body,
    foot,
    ack,
    confirmWord,
    consequence,
    success,
    yes,
    cancelText,
    busy = false,
    busyText,
    onAccept,
    onClose,
  }) {
    const titleId = `${idBase}-title`
    const bodyId = `${idBase}-body`
    const reasonId = `${idBase}-reason`
    const nodeRef = useRef(null)
    const [ackChecked, setAckChecked] = useState(false)
    const [confirmInput, setConfirmInput] = useState("")

    useEffect(() => {
      if (open) {
        setAckChecked(false)
        setConfirmInput("")
      }
    }, [open])

    useEffect(() => {
      const element = nodeRef.current
      if (element === null || typeof element.showModal !== "function") return undefined
      if (open) {
        // 触发元素记在 DOM 节点上而不是组件 ref 里：重渲染换掉实例时，节点上的值还在。
        // body 不记——把焦点还给页面根等于没还，关闭后仍停在文档开头。
        const previous = typeof document !== "undefined" ? document.activeElement : null
        if (previous !== null && previous !== undefined && previous !== element
          && typeof previous.focus === "function" && typeof previous.tagName === "string"
          && previous.tagName !== "BODY") {
          element.__bklReturnFocus = previous
        }
        if (!element.open) element.showModal()
        const target = (typeof element.querySelector === "function" ? element.querySelector("[data-bkl-autofocus]") : null)
          ?? (typeof element.querySelector === "function" ? element.querySelector(FOCUSABLE) : null)
        target?.focus?.()
      } else if (element.open) {
        element.close()
        const back = element.__bklReturnFocus
        element.__bklReturnFocus = null
        if (back !== null && back !== undefined && typeof back.focus === "function" && back.isConnected !== false) back.focus()
      }
      return undefined
    }, [open])
    // 宿主也在监听 Esc 关闭整个设置面板。不拦住它，一次 Esc 会同时关掉弹窗和设置页，
    // 弹窗随面板卸载，焦点还原就没了对象。window 捕获阶段是唯一早于宿主的层。
    useEffect(() => {
      if (!open || typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        event.preventDefault()
        onClose()
      }
      window.addEventListener("keydown", onKeyDown, true)
      return () => { window.removeEventListener("keydown", onKeyDown, true) }
    }, [open, onClose])
    useEffect(() => {
      const element = nodeRef.current
      if (element === null || typeof element.addEventListener !== "function") return undefined
      const onCancel = (event) => { event.preventDefault(); onClose() }
      const onClick = (event) => { if (event.target === element) onClose() }
      element.addEventListener("cancel", onCancel)
      element.addEventListener("click", onClick)
      return () => {
        element.removeEventListener("cancel", onCancel)
        element.removeEventListener("click", onClick)
      }
    }, [onClose])

    const ackOk = !ack || ackChecked === true
    const wordOk = !confirmWord || confirmInput.trim() === confirmWord
    const canAccept = ackOk && wordOk && !busy

    const dynamicReason = !ackOk
      ? T.dialogGuardAckRequired
      : !wordOk
        ? T.dialogGuardWordRequired(confirmWord)
        : (foot && typeof foot === "string" ? foot : T.dialogGuardReady)

    const consequenceView = consequence
      ? h("p", {
          key: "consequence",
          className: `bkl-consequence ${consequence.ok ? "ok" : "danger"}`,
          style: merge(S.consequence, consequence.ok ? S.consequenceOk : S.consequenceDanger),
        },
        h(Icon, { name: consequence.ok ? "undo" : "alert", size: 15 }),
        h("span", null, consequence.text))
      : null

    const successView = success
      ? h("div", { key: "success", className: "bkl-success-sign", style: S.successSign },
          h("strong", { style: S.successSignTitle }, success.title),
          h("span", null, success.text))
      : null

    const ackView = ack
      ? h("label", {
          key: "ack",
          className: `bkl-ack ${tone === "danger" || tone === "error" ? "danger" : ""}`,
          style: merge(S.ackLabel, (tone === "danger" || tone === "error") && S.ackDanger, ackChecked && S.ackChecked),
        },
        h("input", {
          type: "checkbox",
          id: `${idBase}-ack`,
          style: S.ackInput,
          checked: ackChecked,
          onChange: (e) => { setAckChecked(e.target.checked) },
        }),
        h("span", { style: S.ackText }, ack))
      : null

    const confirmWordView = confirmWord
      ? h("div", { key: "confirmWord", style: S.confirmWordBox },
          h("label", { htmlFor: `${idBase}-confirm`, style: S.confirmWordLabel },
            T.dialogConfirmWordLabel(confirmWord)),
          h("input", {
            id: `${idBase}-confirm`,
            className: "bkl-input",
            style: merge(S.input, S.confirmWordInput),
            autoComplete: "off",
            spellCheck: false,
            value: confirmInput,
            placeholder: confirmWord,
            onChange: (e) => { setConfirmInput(e.target.value) },
          }))
      : null

    const footView = foot && !yes
      ? foot
      : [
          (ack || confirmWord || (foot && typeof foot === "string"))
            ? h("p", { key: "note", id: reasonId, style: S.dialogNote }, dynamicReason)
            : null,
          h(Button, {
            key: "cancel",
            kind: "quiet",
            onClick: onClose,
          }, cancelText || T.cancel),
          yes
            ? h(Button, {
                key: "yes",
                kind: (tone === "danger" || tone === "error") ? "danger" : "primary",
                off: !canAccept,
                reason: dynamicReason,
                describedBy: reasonId,
                onClick: () => { if (canAccept && onAccept) onAccept() },
              }, busy ? (busyText || T.working) : yes)
            : null,
        ]

    return h("dialog", {
      ref: nodeRef,
      className: "bkl-dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      "aria-describedby": bodyId,
      style: S.dialog,
    },
      h("div", { style: S.dialogInner },
        h("div", { style: S.dialogHead },
          h("span", {
            "aria-hidden": "true",
            style: merge(S.dialogIcon, (tone === "danger" || tone === "error") && S.dialogIconDanger),
          }, h(Icon, { name: (tone === "danger" || tone === "error") ? "alert" : "shield", size: 17 })),
          h("h3", { id: titleId, style: S.dialogTitle }, title),
          h(Button, { kind: "quiet", size: "small", label: T.dismissShort, onClick: onClose }, T.dismissShort)),
        h("div", { id: bodyId, style: S.dialogBody },
          body,
          successView,
          consequenceView,
          ackView,
          confirmWordView),
        h("div", { style: S.dialogFoot }, footView)))
  }

  /**
   * 底部居中短反馈（toast）。只放「已完成」级别的确认文案；
   * 需要用户决定或带有后续步骤的结果仍走 Notice。
   * 视觉部分不带 live region——播报由常驻 Announcer 负责，避免同一句读两遍。
   */
  function Toast({ text }) {
    return h("div", {
      className: "bkl-toast",
      "data-bkl-toast": "true",
      "aria-hidden": "true",
      style: S.toast,
    },
      h(Icon, { name: "check", size: 16, style: { color: tk.toastIcon, flexShrink: 0 } }),
      h("span", { style: S.toastText }, text))
  }

  /**
   * 常驻播报区。读屏只可靠播报「已有区域的内容变化」，插入即带文本的节点
   * 可能不播或与可见节点各播一遍，所以它常驻树中、只改文本。
   */
  function Announcer({ text }) {
    return h("div", {
      role: "status",
      "aria-live": "polite",
      "data-bkl-toast-announcer": "true",
      style: S.srOnly,
    }, text)
  }

  /** 词条原词 → 替换词 的成对展示；纯文本渲染，不把用户输入当 HTML。 */
  function Pair({ entry }) {
    return h("div", { style: S.pair },
      h("span", { style: S.pairCell }, entry.from),
      h("span", { "aria-hidden": "true", style: { color: tk.label3 } }, "\u2192"),
      h("span", { style: S.pairCell }, entry.to))
  }

  function Rows({ items }) {
    const shown = items.filter(Boolean)
    return h("ul", { style: S.rows },
      shown.map((item, index) => h("li", { key: item.id, style: merge(S.rowItem, index === 0 && S.rowFirst) },
        h("span", { id: `bkl-row-${item.id}`, style: S.rowKey }, item.label),
        h("div", { style: S.rowVal },
          h("span", { style: S.rowValue }, item.tone ? h(Dot, { tone: item.tone }) : null, item.value),
          item.hint ? h("span", { id: `bkl-row-${item.id}-hint`, style: merge(S.small, item.mono && S.mono) }, item.hint) : null),
        item.control ?? h("span", null))))
  }

  /** 单选卡片：方向键移动并选中（WAI-ARIA radio 的约定），只有被选中的那张可 Tab 到达。 */
  function RadioCards({ group, labelledBy, options, value, onSelect, compact }) {
    const hasChecked = options.some(option => option.id === value)
    const move = (index) => {
      const option = options[(index + options.length) % options.length]
      document.getElementById(`bkl-${group}-${option.id}`)?.focus?.()
      onSelect(option.id)
    }
    return h("div", { role: "radiogroup", "aria-labelledby": labelledBy, style: compact ? S.segment : S.radioGrid },
      options.map((option, index) => {
        const checked = option.id === value
        return h("button", {
          key: option.id,
          id: `bkl-${group}-${option.id}`,
          type: "button",
          role: "radio",
          className: "bkl-radio",
          "aria-checked": checked ? "true" : "false",
          "aria-describedby": option.descId,
          tabIndex: checked || (!hasChecked && index === 0) ? 0 : -1,
          style: merge(S.radioCard, checked && S.radioCardOn),
          onClick: () => { onSelect(option.id) },
          onKeyDown: (event) => {
            const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
            const backward = event.key === "ArrowLeft" || event.key === "ArrowUp"
            if (!forward && !backward) return
            event.preventDefault()
            move(index + (forward ? 1 : -1))
          },
        },
          h("span", { style: S.radioHead },
            h("span", { "aria-hidden": "true", style: merge(S.radioMark, checked && S.radioMarkOn) }, checked ? h("span", { style: S.radioMarkDot }) : null),
            h("span", { style: S.strong }, option.title),
            option.tags ?? null),
          option.body ?? null)
      }))
  }

  function Empty({ title, body, action }) {
    return h("div", { style: S.empty },
      h("p", { style: S.strong }, title),
      body ? h("p", { style: S.small }, body) : null,
      action ?? null)
  }

  // ---- 重启横幅 -------------------------------------------------------------

  function RestartBanner({ restart, onCopy, onToggleHow, onDismiss, notice }) {
    return h("section", {
      className: "bkl-fade",
      "aria-labelledby": "bkl-restart-title",
      style: merge(S.banner, { background: tk.warnSoft }),
    },
      h("div", { style: S.bannerHead },
        h(Dot, { tone: "warn" }),
        h("h3", { id: "bkl-restart-title", style: S.bannerTitle }, T.restartTitle)),
      h("p", { style: S.text }, restart.kind === "revert" ? T.restartBodyRevert(restart.count) : T.restartBodyApply(restart.count)),
      restart.command === undefined
        ? null
        : restart.command === null
          ? h("p", { style: S.small }, T.restartNoCommand)
          : h("pre", { style: S.codeBlock, "aria-label": T.restartCommandLabel }, restart.command),
      h("div", { style: S.row },
        h(Button, { kind: "primary", onClick: onCopy }, T.copyRestart),
        h(Button, { kind: "quiet", expanded: restart.open === true, controls: "bkl-restart-how", onClick: onToggleHow }, T.restartHow),
        h("span", { style: S.spacer }),
        h(Button, { kind: "quiet", onClick: onDismiss }, T.restartDismiss)),
      h("div", { id: "bkl-restart-how", hidden: restart.open !== true, style: { display: restart.open === true ? "flex" : "none", flexDirection: "column", gap: "6px" } },
        h("ol", { style: S.ol },
          h("li", null, T.restartStep1),
          h("li", null, T.restartStep2),
          h("li", null, T.restartStep3)),
        h("p", { style: S.small }, T.restartCaveat)),
      notice ?? null)
  }

  // ---- 概览 -----------------------------------------------------------------

  function NextStepCard({ step, busy, onRun, notice }) {
    return h("section", { style: S.card, "aria-labelledby": "bkl-next-title" },
      h("span", { style: S.eyebrow }, h(Dot, { tone: step.tone }), T.nextStep),
      h("h3", { id: "bkl-next-title", style: S.bigTitle }, step.title),
      step.body ? h("p", { id: "bkl-next-body", style: S.text }, step.body) : null,
      step.snippet ? h("pre", { style: S.codeBlock }, step.snippet) : null,
      step.primary || step.secondary
        ? h("div", { style: S.row },
          step.primary
            ? h(Button, { kind: "primary", off: busy, reason: T.whyBusy, describedBy: "bkl-next-body", onClick: () => { onRun(step.primary.action) } }, step.primary.label)
            : null,
          step.secondary
            ? h(Button, { kind: step.primary ? "quiet" : "plain", onClick: () => { onRun(step.secondary.action) } }, step.secondary.label)
            : null)
        : null,
      notice ?? null)
  }

  function StepList({ items, onGo }) {
    return h("ol", { style: S.steps },
      items.map((item, index) => {
        const color = TONE_COLOR[STEP_TONE[item.state]] ?? tk.line4
        return h("li", { key: item.key },
          h("button", {
            type: "button",
            className: "bkl-hover",
            style: S.step,
            "aria-label": `${item.title}${T.sep}${item.value} (${T.stepState(item.state)})`,
            "aria-describedby": `bkl-step-${item.key}-desc`,
            onClick: () => { onGo(item.tab) },
          },
            h("span", { style: merge(S.stepMark, { border: `1px solid ${color}`, color }), "aria-hidden": "true" },
              item.state === "done" ? "\u2713" : item.state === "error" ? "!" : String(index + 1)),
            h("span", { style: S.stepBody },
              h("span", { style: S.stepTitleRow },
                h("span", { style: S.strong }, item.title),
                h("span", { style: merge(S.small, { color: item.state === "error" ? tk.error : tk.label3 }) }, item.value)),
              h("span", { id: `bkl-step-${item.key}-desc`, style: S.small }, item.desc)),
            h("span", { style: S.stepChevron, "aria-hidden": "true" }, "\u203a")))
      }))
  }

  // 三步引导卡：独立组件（不在 tablist 内）。展开态显示进度与三步链接，
  // 关闭态只留一个 link 按钮。三步的完成条件与 flowSteps 同源数据（f/restart）。
  function GuideBlock({ f, open, onToggle, onGo }) {
    const steps = [
      { title: T.guideStep1Title, body: T.guideStep1Body, tab: "prompt", done: true, defaultHint: true },
      { title: T.guideStep2Title, body: T.guideStep2Body, tab: "patches", done: f.enabledCount > 0, defaultHint: false },
      { title: T.guideStep3Title, body: T.guideStep3Body, tab: "patches", done: f.applied !== null && !f.restartPending, defaultHint: false },
    ]
    const doneCount = steps.filter(step => step.done).length
    const currentIndex = steps.findIndex(step => !step.done)
    if (!open) {
      return h("div", null,
        h(Button, { kind: "link", onClick: onToggle },
          h(Icon, { name: "help", size: 15 }),
          T.guideShow))
    }
    return h("section", { className: "bkl-guide", "aria-labelledby": "bkl-guide-title" },
      h("div", { className: "bkl-guide-title" },
        h("h3", { id: "bkl-guide-title" }, T.guideTitle),
        h("div", { className: "bkl-guide-progress" },
          h("span", null, T.guideProgress(doneCount)),
          h("span", { className: "bkl-guide-bar", "aria-hidden": "true" },
            h("span", { style: { width: `${String(Math.round((doneCount / 3) * 100))}%` } })),
          h(Button, { kind: "link", label: T.guideHide, onClick: onToggle }, T.guideHide))),
      steps.map((step, index) => {
        const now = index === currentIndex
        return h("div", { key: String(index), className: now ? "bkl-guide-item is-current" : "bkl-guide-item" },
          h("span", {
            className: step.done ? "bkl-step-num done" : now ? "bkl-step-num current" : "bkl-step-num",
            "aria-hidden": "true",
          }, step.done ? h(Icon, { name: "check", size: 13 }) : String(index + 1)),
          h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
            h("strong", null,
              step.title,
              step.defaultHint ? h("span", { style: merge(S.small, { marginLeft: "8px", fontWeight: 400 }) }, T.guideDefaultHint) : null),
            h("p", null, step.body)),
          h(Button, {
            kind: "link",
            label: `${step.title} · ${now ? T.guideGo : T.guideView}`,
            onClick: () => { onGo(step.tab) },
          },
            now ? T.guideGo : T.guideView,
            h(Icon, { name: "chevron", size: 15 })))
      }))
  }

  function OverviewPage({ f, status, override, step, busy, enabledPending, restart, onRun, onGo, onToggleEnabled, nextNotice, overviewNotice, restartView, words, guideOpen, onToggleGuide, onCopy, loadedAt, onOpenHelp }) {
    const target = status?.target ?? {}
    const rootHint = status?.hostRoot ? `${T.rootSource(status.hostRootSource)}${T.sep}${String(status.hostRoot)}` : T.rootMissingShort
    let preValue = T.unknown
    let preTone = "idle"
    if (f.rootMissing) { preValue = T.preNoRoot; preTone = "warn" } else if (f.broken) { preValue = T.preBroken; preTone = "error" } else if (f.blocked.length > 0) { preValue = T.preBlocked(f.blocked.length); preTone = "error" } else if (f.preCode === "ok") { preValue = T.preOk(f.pendingFiles); preTone = f.pendingFiles > 0 ? "accent" : "ok" }
    const activeRule = f.activeRule === null ? null : f.rules.find(rule => rule.id === f.activeRule)
    const takeoverOn = status?.enabled === true
    const warnings = Array.isArray(status?.permission?.warnings) ? status.permission.warnings : []
    const isFullAccess = status?.mode === "danger-full-access"
    const diagText = formatDiagnostics(status, f)
    const actionCard = deriveActionCard(status, f)
    const actionToneClass = actionCard.tone ? ` ${actionCard.tone}` : ""
    const steps = flowSteps(status, f)

    const wordsSummaryText = words?.phase === "loading"
      ? T.aliasLoading
      : aliasReadError(words)
        ? T.wordsSummaryFailed
        : words?.entries?.length === 0 ? T.wordsSummaryEmpty : T.wordsSummaryCount(words?.entries?.length ?? 0)

    return h("div", { style: S.panel },
      // 1. 顶部调用 PageHead（从这里开始，page: "overview"）
      h(PageHead, { page: "overview", title: T.pageOverviewTitle, desc: T.pageOverviewDesc, titleId: "bkl-page-overview" }),

      // 2. 第一层：4 阶段进度条（ol.bkl-flow，全宽）
      h("ol", { className: "bkl-flow", "aria-label": T.overviewFlowLabel },
        steps.map(([title, state, sub], index) => {
          const isCurrent = state === "current" || state === "blocked"
          return h("li", { key: String(index), className: state, "aria-current": isCurrent ? "step" : undefined },
            h("span", { className: "bkl-flow-num", "aria-hidden": "true" },
              state === "done" ? h(Icon, { name: "check", size: 13 }) : state === "blocked" ? "!" : String(index + 1)),
            h("div", { style: { minWidth: 0, flex: "1 1 auto" } },
              h("strong", null, title),
              h("span", { className: "bkl-sub" }, sub)))
        })),

      // 3. 第二层起：bkl-columns 双栏（左：行动卡、Guide、配置卡；右：环境卡、help-box、技术诊断）
      h("div", { className: "bkl-columns" },
        // 左栏：主行动卡 + 三步引导 + 核心配置与接管（4 行尾部都是 link，接管行是 Switch）
        h("div", { style: { display: "flex", flexDirection: "column", gap: tk.gapBlock, minWidth: 0 } },
          h("section", { className: `bkl-action-card${actionToneClass}`, "aria-labelledby": "bkl-action-title" },
            h("div", { className: "bkl-action-eyebrow" },
              h("span", { className: "bkl-icon-wrap", "aria-hidden": "true" },
                h(Icon, { name: actionCard.icon, size: 14 })),
              actionCard.label),
            h("h2", { id: "bkl-action-title" }, actionCard.title),
            h("p", null, actionCard.body),
            h("div", { className: "bkl-action-actions" },
              h(Button, {
                kind: "primary",
                off: busy,
                reason: T.whyBusy,
                onClick: () => { onRun(actionCard.action) },
              }, actionCard.button),
              restart !== null ? restartView : null,
              nextNotice ?? null)),
          h(GuideBlock, { f, open: guideOpen, onToggle: onToggleGuide, onGo }),
          h(Card, {
            title: T.overviewConfigTitle,
            titleId: "bkl-config-title",
            desc: T.overviewConfigDesc,
          },
            h("div", { className: "bkl-summary-list" },
              // 1) 提示词模式
              h("div", { className: "bkl-summary-row" },
                h("span", { className: "bkl-summary-icon" }, h(Icon, { name: "text", size: 18 })),
                h("div", { className: "bkl-summary-content" },
                  h("div", { className: "bkl-summary-label" }, T.rowMode),
                  h("strong", null, modeLabel(f.mode)),
                  h("p", null, f.customPrompt ? T.promptMineSummary : T.promptBuiltinSummary)),
                h(Button, { kind: "link", onClick: () => { onGo("prompt") } }, T.adjustPrompt, h(Icon, { name: "chevron", size: 15 }))),
              // 2) 长期规则
              h("div", { className: "bkl-summary-row" },
                h("span", { className: "bkl-summary-icon" }, h(Icon, { name: "file", size: 18 })),
                h("div", { className: "bkl-summary-content" },
                  h("div", { className: "bkl-summary-label" }, T.rowRules),
                  h("strong", null, f.rulesIndex === "corrupt" ? T.rulesCorruptShort : activeRule ? (activeRule.name || activeRule.id) : T.rulesNoneShort),
                  h("p", null, f.rulesIndex === "corrupt" ? T.rulesCorruptSummary : activeRule ? T.rulesActiveSummary(activeRule.target) : T.rulesInactiveSummary)),
                h(Button, { kind: "link", onClick: () => { onGo("rules") } }, f.rulesIndex === "corrupt" ? T.viewDetails : T.manageRules, h(Icon, { name: "chevron", size: 15 }))),
              // 3) 目标词库
              h("div", { className: "bkl-summary-row" },
                h("span", { className: "bkl-summary-icon" }, h(Icon, { name: "dictionary", size: 18 })),
                h("div", { className: "bkl-summary-content" },
                  h("div", { className: "bkl-summary-label" }, T.rowWords),
                  h("strong", null, wordsSummaryText),
                  h("p", null, T.wordsSummaryHint)),
                h(Button, { kind: "link", onClick: () => { onGo("words") } }, T.manageWords, h(Icon, { name: "chevron", size: 15 }))),
              // 4) 破限接管开关 Switch，支持就地切换
              h("div", { className: "bkl-summary-row" },
                h("span", { className: "bkl-summary-icon" }, h(Icon, { name: "bolt", size: 18 })),
                h("div", { className: "bkl-summary-content" },
                  h("div", { className: "bkl-summary-label" }, h(Term, { termKey: "takeover", label: T.rowTakeover })),
                  h("strong", null, takeoverOn ? T.takeoverStateOn : T.takeoverStateOff),
                  h("p", { id: "bkl-row-takeover-hint" }, T.takeoverHint)),
                h(Switch, {
                  on: takeoverOn,
                  off: busy || enabledPending,
                  label: T.takeoverLabel,
                  describedBy: "bkl-row-takeover-hint",
                  onToggle: onToggleEnabled,
                }))),
            overviewNotice ?? null),

          // 权限警告条
          warnings.length === 0
            ? null
            : h("section", { role: "note", style: merge(S.banner, { background: tk.warnSoft }) },
              h("div", { style: S.bannerHead }, h(Dot, { tone: "warn" }), h("h3", { style: S.bannerTitle }, T.warnTitle)),
              h("ul", { style: S.ol },
                warnings.map((warning, index) => h("li", { key: `w${String(index)}` },
                  warning?.code === "preset_approval_never"
                    ? T.warnPresetNever(warning.preset ?? "")
                    : warning?.code === "default_policy_never" ? T.warnPolicyNever : T.warnOther(warning?.code ?? "")))),
              h("p", { style: S.small }, T.warnNext))),

        // 右栏：环境与权限卡 + 生效时机 help-box + 技术诊断 disclosure
        h("div", { style: { display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 } },
          // a. 运行环境与权限卡片（宿主版本、提示词模式、实际权限、预检状态、宿主路径、检查时间）
          h(Card, { title: T.overviewEnvTitle, titleId: "bkl-status-title" },
            h("div", { className: "bkl-status-lines" },
              h("div", null,
                h("span", { className: "bkl-status-key" }, h(Term, { termKey: "host", label: T.rowHost })),
                h("span", { style: S.mono }, `${String(target.version ?? T.unknown)}${target.commit ? ` · ${String(target.commit).slice(0, 10)}` : ""}`)),
              h("div", null,
                h("span", { className: "bkl-status-key" }, T.rowMode),
                h("span", null, modeLabel(f.mode))),
              h("div", null,
                h("span", { className: "bkl-status-key" }, T.rowSandbox),
                h(Tag, { tone: isFullAccess ? "warn" : undefined }, isFullAccess ? T.sandboxFullAccess : T.sandboxHostDefault)),
              h("div", null,
                h("span", { className: "bkl-status-key" }, h(Term, { termKey: "preflight", label: T.rowPreflight })),
                h(Tag, { tone: preTone }, preValue)),
              h("div", null,
                h("span", { className: "bkl-status-key" }, h(Term, { termKey: "patch", label: T.rowApplied })),
                h("span", null, f.applied === null ? T.appliedNone : T.appliedValue(f.applied.files ?? 0, formatTime(f.applied.updatedAt))))),
            h("div", {
              style: {
                padding: "9px 11px",
                background: "var(--dsw-alias-bg-layer-2, #f7f8fa)",
                border: "0.5px solid var(--dsw-alias-border-l2, #e1e5eb)",
                borderRadius: "7px",
                overflowWrap: "anywhere",
                fontFamily: "var(--dsw-font-mono, monospace)",
                fontSize: "11px",
                lineHeight: 1.6,
                marginTop: "12px",
                color: "var(--dsw-alias-label-secondary)",
              },
            }, rootHint),
            h("p", { style: merge(S.small, { marginTop: "10px", color: "var(--dsw-alias-label-tertiary)" }) }, T.overviewEnvDesc),
            loadedAt > 0
              ? h("div", { style: S.statusFooter },
                h(Icon, { name: "clock", size: 14 }),
                h("span", null, T.envCheckedAt(formatAgo(loadedAt))))
              : null),

          // b. 改动生效时机 help-box（四条 + 使用说明链接，打开帮助弹窗）
          h("div", { style: S.helpBox },
            h("h4", { style: S.helpBoxTitle }, T.overviewEffectTitle),
            h("div", { style: S.helpBoxList },
              h("span", { style: S.helpBoxKey }, T.overviewEffectPatches),
              h("span", null, T.overviewEffectPatchesDesc),
              h("span", { style: S.helpBoxKey }, T.overviewEffectPrompt),
              h("span", null, T.overviewEffectPromptDesc),
              h("span", { style: S.helpBoxKey }, T.overviewEffectRules),
              h("span", null, T.overviewEffectRulesDesc),
              h("span", { style: S.helpBoxKey }, T.overviewEffectWords),
              h("span", null, T.overviewEffectWordsDesc)),
            h(Button, { kind: "link", onClick: onOpenHelp },
              T.helpLabel,
              h(Icon, { name: "arrow", size: 15 }))),

          // c. 技术诊断折叠块（带一键脱敏复制与提示）
          h("details", { className: "bkl-disclosure" },
            h("summary", null, T.overviewDiagTitle),
            h("pre", { style: merge(S.codeBlock, { whiteSpace: "pre-wrap", marginTop: "10px", fontSize: "11px", lineHeight: 1.6 }) }, diagText),
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginTop: "10px", flexWrap: "wrap" } },
              h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } }, T.overviewDiagNote),
              h(Button, {
                size: "small",
                kind: "quiet",
                onClick: () => {
                  if (typeof onCopy === "function") {
                    onCopy(diagText)
                  } else if (typeof navigator !== "undefined" && navigator.clipboard) {
                    void navigator.clipboard.writeText(diagText)
                  }
                },
              },
                h(Icon, { name: "copy", size: 13 }),
                " ",
                T.overviewDiagCopy))))))
  }

  // ---- 补丁 -----------------------------------------------------------------

  function PatchRowItem({ patch, f, pendingValue, busy, onToggle, onGo }) {
    const [open, setOpen] = useState(false)
    const key = safeId(patch.id)
    const on = pendingValue === undefined ? patch.enabled === true : pendingValue
    const toggling = pendingValue !== undefined
    const disk = diskState(patch, f)
    const title = pickLang(patch.titles) || String(patch.title ?? patch.id)
    const human = pickLang(patch.human)
    const note = pickLang(patch.notes)
    const targets = Array.isArray(patch.targets) ? patch.targets : []
    const filePaths = unique(targets.map(target => String(target?.path ?? "")).filter(Boolean))
    const filesCount = filePaths.length

    // 模式门禁：minimal.unfreeze 在推荐模式下置灰并显示「仅完全解放」及跳转链接
    const isUnrestrictedPatch = patch.id === "minimal.unfreeze" || patch.unrestricted === true
    const disabledByMode = isUnrestrictedPatch && f.mode !== "unrestricted"

    const eligible = !disabledByMode
    const selected = on && eligible

    // 模块特征图标映射
    const iconMap = {
      "output.trim": "terminal",
      "read.limits": "file",
      "web.framing": "code",
      "workspace.authority": "shield",
      "minimal.unfreeze": "bolt",
    }
    const iconName = iconMap[patch.id] || (patch.unrestricted ? "bolt" : "file")

    // 磁盘状态胶囊徽章（已就位、待写入、有冲突、未应用）
    let diskBadgeText = T.diskUnapplied
    let diskTone = undefined
    if (f.rootMissing) {
      diskBadgeText = T.diskUnchecked
      diskTone = "warn"
    } else if (disk === "blocked") {
      diskBadgeText = T.diskConflict
      diskTone = "error"
    } else if (disk === "ready") {
      diskBadgeText = T.diskInPlace
      diskTone = "ok"
    } else if (disk === "pending" || (selected && disk !== "ready")) {
      diskBadgeText = T.diskPending
      diskTone = "accent"
    }

    const rowClasses = [
      "bkl-patch-row",
      !eligible ? "inactive" : "",
      selected ? "selected" : "",
    ].filter(Boolean).join(" ")

    return h("article", { className: rowClasses, id: `bkl-patch-row-${key}` },
      h("div", { style: { display: "flex", gap: "14px", alignItems: "flex-start" } },
        // 左侧模块特征图标
        h("div", { className: "bkl-patch-icon" },
          h(Icon, { name: iconName, size: 18 })),
        // 中间内容区
        h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
          h("h3", { style: { fontSize: "14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", margin: 0, fontWeight: 600 } },
            h("span", { id: `bkl-p-${key}-title` }, title),
            isUnrestrictedPatch ? h(Tag, { tone: "warn" }, T.onlyUnrestricted) : null,
            patch.kind === "replace" ? h(Tag, null, T.kindReplace) : null),
          human ? h("p", { style: merge(S.text, { margin: "3px 0 10px", fontSize: "13px" }) }, human) : null,
          // 状态胶囊徽章与文件数与模式切换链接
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
            h(Tag, { tone: diskTone }, diskBadgeText),
            h("span", null, T.touchesFiles(filesCount)),
            disabledByMode ? h("button", {
              type: "button",
              className: "bkl-link",
              style: { border: 0, background: "none", color: "var(--dsw-alias-state-business-primary)", padding: 0, cursor: "pointer", fontSize: "12px", textDecoration: "underline" },
              onClick: () => { if (onGo) onGo("prompt") },
            }, T.switchModeToSelect) : null),
          // 折叠改动说明与涉及文件清单
          h("details", { className: "bkl-disclosure" },
            h("summary", null, T.patchDisclosureSummary),
            note ? h("p", { style: merge(S.text, { marginTop: "8px", fontSize: "12px" }) }, note) : null,
            h("ul", { className: "bkl-file-list" },
              filePaths.map((p, idx) => h("li", { key: String(idx) },
                h(Icon, { name: "file", size: 14 }),
                h("span", null, p)))),
            targets.length > 0
              ? targets.map((target, idx) => typeof target?.before === "string" ? h("div", { key: `tgt-${String(idx)}`, style: { marginTop: "8px" } },
                h("span", { style: S.caption }, `${String(target.path ?? "")} (${T.before}):`),
                h("pre", { style: merge(S.codeBlock, { margin: "4px 0" }) }, target.before),
                h("span", { style: S.caption }, `${String(target.path ?? "")} (${T.after}):`),
                h("pre", { style: merge(S.codeBlock, { margin: "4px 0" }) }, target.after)) : null)
              : null)),
        // 右侧开关控件与提示
        h("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "5px", paddingTop: "2px", flexShrink: 0, minWidth: "68px" } },
          h(Switch, {
            on,
            off: busy || toggling || disabledByMode,
            labelledBy: `bkl-p-${key}-title`,
            describedBy: `bkl-p-${key}-hint`,
            onToggle: (next) => { onToggle(patch.id, next) },
          }),
          h("span", { id: `bkl-p-${key}-hint`, style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
            toggling ? T.saving : disabledByMode ? T.modeDisabledHint : on ? T.switchOnHint : T.switchOffHint))))
  }

  const PatchCard = PatchRowItem

  function PatchesPage({ f, patchInfo, patchError, busy, toggles, onToggle, onApply, onRevert, onRun, onCopy, onGo, noticeView, restartView }) {
    const applyWhy = applyReason(f, busy, toggles)
    const revertWhy = revertReason(f, busy)
    const blockedText = f.blocked.map(item => `${String(item?.patchId ?? "")} · ${String(item?.path ?? "")} · ${String(item?.reason ?? "")}`).join("\n")
    const isBlocked = f.blocked.length > 0
    const footStatusText = isBlocked
      ? T.patchFootBlocked
      : f.pendingFiles > 0
        ? T.patchFootPending(f.pendingFiles)
        : T.patchFootNone

    return h("div", { style: S.panel },
      // 1. 顶部 PageHead（带有已选数量徽章与 PageTip）
      h(PageHead, {
        page: "patches",
        title: T.pagePatchesTitle,
        desc: [
          T.patchesHeadPrefix,
          h(Term, { termKey: "patch" }),
          T.patchesHeadMid,
          h(Term, { termKey: "host" }),
          T.patchesHeadSuffix,
        ] ?? T.pagePatchesDesc,
        titleId: "bkl-page-patches",
        when: T.whenRestart,
        aside: h(Tag, { tone: f.enabledCount > 0 ? "accent" : undefined }, T.patchesSelectedBadge(f.enabledCount)),
      }),

      restartView ?? null,

      // 2. 阻断与未配目录 Notice
      isBlocked
        ? h(Notice, {
          tone: "error",
          title: T.blockedNoticeTitle(f.blocked.length),
          body: T.blockedNoticeBody,
          data: T.dataProtectedDisk,
          actions: h("div", { style: S.row },
            h(Button, { size: "small", kind: "primary", onClick: () => { onRun("blockedHelp") } }, T.viewBlockReason),
            h(Button, { size: "small", onClick: () => { onRun("refresh") } }, T.recheckSource),
            h(Button, { size: "small", onClick: () => { onCopy(blockedText) } }, T.copyList)),
        })
        : null,

      f.rootMissing || f.broken
        ? h(Notice, {
          tone: f.broken ? "error" : "warn",
          title: f.broken ? T.nsBrokenTitle : T.nsRootTitle,
          body: f.broken ? T.whyBroken : T.whyNoRoot,
          data: T.dataProtectedDisk,
          action: "goOverview",
          onAction: onRun,
        })
        : null,

      // 3. 区块分界小标题（.bkl-section-label）
      h("div", { className: "bkl-section-label" },
        h("span", null, T.sourcePatchesLabel),
        h("span", null, `${T.currentPromptModePrefix}${modeLabel(f.mode)}`)),

      // 4. 补丁统一外壳（section.bkl-patch-list）
      f.total === 0
        ? h(Empty, {
          title: T.patchesEmptyTitle,
          body: patchError ? `${patchError.title}${T.sep}${patchError.next}` : undefined,
          action: h(Button, { kind: "primary", onClick: () => { onRun("retry") } }, T.retry),
        })
        : h("section", { className: "bkl-patch-list", "aria-label": T.patchesTitle },
          f.patches.map(patch => h(PatchRowItem, {
            key: patch.id,
            patch,
            f,
            pendingValue: toggles[patch.id],
            busy,
            onToggle,
            onGo,
          }))),

      noticeView ?? null,

      // 5. 悬浮固定底部操作栏（footer.bkl-sticky-footer）
      h("footer", { className: "bkl-sticky-footer" },
        h("div", { className: `bkl-foot-copy ${isBlocked ? "blocked" : ""}` },
          h("strong", null, footStatusText),
          h("div", { className: "bkl-foot-reason" }, applyWhy ?? T.patchFootReasonDefault)),
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginLeft: "auto" } },
          h(Button, {
            kind: "quietDanger",
            off: revertWhy !== null,
            reason: revertWhy,
            onClick: onRevert,
          }, T.revert),
          h(Button, {
            kind: "primary",
            off: applyWhy !== null,
            reason: applyWhy,
            onClick: onApply,
          },
            busy ? h("span", { className: "bkl-spinner", style: { marginRight: "6px", width: "12px", height: "12px", display: "inline-block" } }) : null,
            f.pendingFiles > 0 ? T.applyN(f.pendingFiles) : T.apply))))
  }

  // ---- 提示词与规则 ---------------------------------------------------------

  function ModeBlock({ mode, pendingMode, onPick, noticeView }) {
    return h(Card, { title: T.modeTitle, titleId: "bkl-mode-title", desc: T.modeDesc },
      h("div", { className: "mode-grid" },
        MODES.map((id) => {
          const isSelected = id === mode
          const recommended = id === "recommended"
          const titleContent = id === "unrestricted"
            ? h(Term, { termKey: "unrestricted", label: modeLabel(id) })
            : modeLabel(id)

          const tags = [
            recommended ? h(Tag, { key: "d" }, T.tagDefault) : null,
            isSelected ? h(Tag, { key: "c", tone: "ok" }, T.tagCurrent) : null,
            id === pendingMode ? h(Tag, { key: "p", tone: "accent" }, T.tagPending) : null,
          ].filter(Boolean)

          return h("div", {
            key: id,
            className: `mode-card ${isSelected ? "selected" : ""}`,
            "data-mode": id,
            role: "button",
            tabIndex: 0,
            "aria-pressed": isSelected ? "true" : "false",
            onClick: () => { onPick?.(id) },
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onPick?.(id)
              }
            },
          },
            h("div", { className: "mode-head" },
              h("div", { className: "mode-title" },
                h(Icon, { name: recommended ? "checkCircle" : "bolt", size: 16 }),
                titleContent),
              tags.length > 0 ? h("div", { style: S.row }, tags) : null),
            h("div", { className: "tradeoff" },
              h("span", { className: "tradeoff-good" }, recommended ? T.modeRecTradeoffGood : T.modeUnrTradeoffGood),
              h("span", { className: "tradeoff-cost" }, recommended ? T.modeRecTradeoffCost : T.modeUnrTradeoffCost)),
            h("div", { className: "mode-budget" },
              h(Icon, { name: "clock", size: 13 }),
              h("span", null, recommended ? T.modeRecBudget : T.modeUnrBudget)))
        })),
      noticeView ?? null)
  }

  function ModeCompare({ currentMode = "recommended", targetMode = "unrestricted" }) {
    const isCurRec = currentMode === "recommended"
    const isTgtRec = targetMode === "recommended"

    const timeoutCur = isCurRec ? T.modeCompareTimeoutRec : T.modeCompareTimeoutUnr
    const timeoutTgt = isTgtRec ? T.modeCompareTimeoutRec : T.modeCompareTimeoutUnr
    const outDepthCur = isCurRec ? T.modeCompareOutputDepthRec : T.modeCompareOutputDepthUnr
    const outDepthTgt = isTgtRec ? T.modeCompareOutputDepthRec : T.modeCompareOutputDepthUnr
    const constraintCur = isCurRec ? T.modeCompareRetained : T.modeCompareLifted
    const constraintTgt = isTgtRec ? T.modeCompareRetained : T.modeCompareLifted

    return h("table", { className: "bkl-compare compare" },
      h("thead", null,
        h("tr", null,
          h("th", null, T.modeCompareItem),
          h("th", null, T.modeCompareCurrent(modeLabel(currentMode))),
          h("th", { className: "col-target" }, T.modeCompareNext(modeLabel(targetMode))))),
      h("tbody", null,
        h("tr", null,
          h("td", null, T.modeCompareTimeout),
          h("td", null, timeoutCur),
          h("td", { className: "col-target" }, timeoutTgt)),
        h("tr", null,
          h("td", null, T.modeCompareOutputDepth),
          h("td", null, outDepthCur),
          h("td", { className: "col-target" }, outDepthTgt)),
        h("tr", null,
          h("td", null, T.modeCompareConstraint),
          h("td", null, constraintCur),
          h("td", { className: "col-target" }, constraintTgt))))
  }

  function modeSwitchDialogSpec(currentMode, targetMode, onConfirm) {
    const label = modeLabel(targetMode)
    const isUnrestricted = targetMode === "unrestricted"
    return {
      pick: targetMode,
      title: T.confirmModeTitle(label),
      consequence: { ok: true, text: T.confirmModeConsequence },
      ack: isUnrestricted ? T.confirmModeAckUnrestricted : undefined,
      body: h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        h("p", { style: S.text }, T.confirmModeBody),
        h(Notice, { tone: "info", title: T.modeNoticeSandboxKeep, body: T.modeNoticeSandboxKeepDesc }),
        h(ModeCompare, { currentMode, targetMode })),
      yes: T.confirmModeYes,
      run: onConfirm,
    }
  }

  function PromptBlock({ override, promptError, draft, setDraft, busy, onSave, onReset, onDiscard, onCopy, onRetry, noticeView }) {
    // 读不到正文时，空编辑器和内置正文都是错的展示：内容未知就只说未知，
    // 编辑、保存、恢复内置全部暂停，避免用户拿一个空壳去覆盖真实正文。
    const loaded = override !== null && promptError === null
    const saved = typeof override?.text === "string" ? override.text : ""
    const value = draft ?? saved
    const dirty = draft !== null && draft !== saved
    const mine = override?.userFileExists === true
    const effectiveBad = override?.effective && override.effective.ok === false
    const saveWhy = !loaded ? T.whyPromptUnread : busy ? T.whyBusy : !dirty ? T.whyNoChange : value.trim() === "" ? T.whyEmptyPrompt : null
    const resetWhy = !loaded ? T.whyPromptUnread : busy ? T.whyBusy : !mine ? T.whyAlreadyBuiltin : null

    const utf8Bytes = typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(value).length
      : utf8Length(value)

    const reasonText = saveWhy ?? (busy ? T.promptSavingHint : dirty ? T.promptDirtyReason : T.saveHint)

    return h(Card, {
      className: dirty ? "editor-card dirty" : "editor-card",
      title: h(Term, { termKey: "sharedPrompt", label: T.promptTitle }),
      titleId: "bkl-prompt-title",
      desc: T.promptDesc,
      descId: "bkl-prompt-desc",
      aside: h("div", { style: S.row },
        dirty ? h(Tag, { tone: "warn" }, T.promptDirty) : null,
        h(Tag, { tone: loaded ? (mine ? "accent" : undefined) : "error" },
          loaded ? (mine ? T.promptUsingMine(formatBytes(override?.bytes)) : T.promptUsingBuiltin) : T.promptCountUnknown)),
    },
      promptError === null
        ? null
        : h(StateBlock, {
          tone: "error",
          title: T.promptReadFailedTitle,
          body: T.promptReadFailedNext,
          // StateBlock 的 actions 只渲染数组（.length > 0 才出操作行），单个元素会被吞掉。
          actions: [
            h(Button, { kind: "primary", size: "small", onClick: () => { onRetry?.() } }, T.promptReadRetry),
          ],
        }),
      effectiveBad
        ? h(Notice, { notice: { tone: "warn", title: T.injectBad(override.effective.code), next: T.injectBadNext } })
        : null,
      h("textarea", {
        className: "bkl-input",
        style: merge(S.input, S.textarea, !loaded && S.inputLocked),
        value: loaded ? value : "",
        placeholder: loaded ? T.promptPlaceholder : promptError === null ? T.loading : T.promptUnknownPlaceholder,
        spellCheck: false,
        readOnly: loaded ? undefined : true,
        "aria-invalid": promptError === null ? undefined : "true",
        "aria-labelledby": "bkl-prompt-title",
        "aria-describedby": "bkl-prompt-desc bkl-prompt-why",
        onChange: (event) => { if (loaded) setDraft(event.target.value) },
      }),
      h("div", { style: S.row },
        h("span", { id: "prompt-count", style: S.caption },
          loaded ? T.promptCountExact(value.length, utf8Bytes) : T.promptCountUnknown),
        dirty ? h(Tag, { tone: "warn" }, T.promptDirty) : null,
        loaded && !dirty
          ? h("span", { className: "bkl-saved-mark", style: S.savedMark },
            h(Icon, { name: "check", size: 14 }),
            T.savedMark)
          : null,
        h("span", { style: S.spacer }),
        dirty ? h(Button, { kind: "quiet", size: "small", onClick: () => { onDiscard?.() } }, T.discard) : null,
        h(Button, { kind: "quiet", size: "small", off: !loaded, reason: T.whyPromptUnread, onClick: () => { onCopy(value) } }, T.copyAll),
        h(Button, { kind: "quietDanger", size: "small", off: resetWhy !== null, reason: resetWhy, onClick: onReset }, T.resetBuiltin),
        h(Button, { kind: dirty ? "primary" : "plain", off: saveWhy !== null, reason: saveWhy, describedBy: "bkl-prompt-why", onClick: onSave }, T.save)),
      h("p", { id: "bkl-prompt-why", style: S.small }, reasonText),
      noticeView ?? null)
  }

  function isRuleEditDirty(edit) {
    if (edit === null || typeof edit !== "object") return false
    const b = edit.baseline
    if (!b) return edit.text.trim() !== "" || edit.name.trim() !== "" || (edit.isNew && edit.id.trim() !== "")
    return edit.text !== b.text || edit.name !== b.name || edit.target !== b.target || (edit.isNew && edit.id !== b.id)
  }

  function RuleEditor({ edit, rules, activeRule, busy, onChange, onSave, onCancel, onOpenExisting }) {
    const idValid = RULE_ID_RE.test(edit.id)
    const idError = edit.isNew && edit.id !== "" && !idValid ? T.ruleIdBad : null
    const idTaken = edit.isNew && idValid && rules.some(rule => rule.id === edit.id)
    const editingActive = !edit.isNew && activeRule === edit.id
    const saveWhy = busy ? T.whyBusy : edit.id === "" ? T.whyNeedId : !idValid ? T.whyBadId : edit.text.trim() === "" ? T.whyNeedText : null
    const set = (patch) => { onChange({ ...edit, ...patch }) }
    const targetOptions = RULE_TARGETS.map(target => ({
      id: target,
      descId: `bkl-rule-target-${safeId(target)}-desc`,
      title: target,
      body: h("span", { id: `bkl-rule-target-${safeId(target)}-desc`, style: S.small }, target === "AGENTS.md" ? T.targetAgents : T.targetClaude),
    }))
    return h("div", { className: "bkl-fade", style: S.editor, role: "group", "aria-labelledby": "bkl-rule-editor-title" },
      h("h4", { id: "bkl-rule-editor-title", style: S.cardTitle }, edit.isNew ? T.editorNewTitle : T.editorEditTitle(edit.name || edit.id)),
      h("div", { style: S.fieldGrid },
        h("div", { style: S.field },
          h("div", { style: S.row },
            h("label", { htmlFor: "bkl-rule-id", style: S.fieldLabel }, T.fieldId),
            h("span", { style: S.spacer }),
            h("span", { style: S.wordCounter }, T.ruleIdCount(edit.id.length))),
          h("input", {
            id: "bkl-rule-id",
            className: "bkl-input",
            style: merge(S.input, S.mono, !edit.isNew && S.inputLocked),
            value: edit.id,
            readOnly: !edit.isNew,
            spellCheck: false,
            autoComplete: "off",
            "aria-invalid": idError ? "true" : undefined,
            "aria-describedby": "bkl-rule-id-hint",
            onChange: (event) => { set({ id: event.target.value.trim() }) },
          }),
          h("p", { id: "bkl-rule-id-hint", role: idError ? "alert" : undefined, style: idError ? S.fieldError : S.small },
            idError ?? (edit.isNew ? T.fieldIdHint : T.fieldIdLocked)),
          idTaken
            ? h("div", { style: merge(S.row, { marginTop: "4px" }) },
                h("p", { style: merge(S.fieldWarn, { margin: 0 }) }, T.ruleIdTaken),
                onOpenExisting
                  ? h(Button, { kind: "quiet", size: "small", onClick: () => { onOpenExisting(edit.id) } }, T.openExistingRule)
                  : null)
            : null),
        h("div", { style: S.field },
          h("label", { htmlFor: "bkl-rule-name", style: S.fieldLabel }, T.fieldName),
          h("input", {
            id: "bkl-rule-name",
            className: "bkl-input",
            style: S.input,
            value: edit.name,
            autoComplete: "off",
            "aria-describedby": "bkl-rule-name-hint",
            onChange: (event) => { set({ name: event.target.value }) },
          }),
          h("p", { id: "bkl-rule-name-hint", style: S.small }, T.fieldNameHint))),
      h("div", { style: S.field },
        h("span", { id: "bkl-rule-target-label", style: S.fieldLabel }, T.fieldTarget),
        h(RadioCards, { group: "rule-target", labelledBy: "bkl-rule-target-label", options: targetOptions, value: edit.target, compact: true, onSelect: (target) => { set({ target }) } })),
      h("div", { style: S.field },
        h("label", { htmlFor: "bkl-rule-text", style: S.fieldLabel }, T.fieldText),
        h("textarea", {
          id: "bkl-rule-text",
          className: "bkl-input",
          style: merge(S.input, S.textarea, { minHeight: "140px" }),
          value: edit.text,
          spellCheck: false,
          "aria-describedby": "bkl-rule-text-hint",
          onChange: (event) => { set({ text: event.target.value }) },
        }),
        h("p", { id: "bkl-rule-text-hint", style: S.small }, T.fieldTextHint)),
      editingActive ? h("p", { style: S.inlineNote }, T.ruleActiveEditing(edit.target)) : null,
      h("div", { style: S.row },
        h(Button, { kind: "primary", off: saveWhy !== null, reason: saveWhy, describedBy: "bkl-rule-save-why", onClick: onSave }, T.saveRule),
        h(Button, { kind: "quiet", onClick: onCancel }, T.cancel)),
      saveWhy ? h("p", { id: "bkl-rule-save-why", style: S.small }, saveWhy) : null)
  }

  function RuleDetail({ rule, activeRule, body, busy, onEdit, onActivate, onDeactivate, onDelete, onRetryBody }) {
    const active = rule.id === activeRule
    return h("section", { style: S.card, "aria-labelledby": "bkl-rule-detail-title" },
      h("span", { style: S.fieldLabel }, T.ruleDetailsTitle),
      h("div", { style: S.row },
        h("h3", { id: "bkl-rule-detail-title", style: merge(S.cardTitle, { overflowWrap: "anywhere" }) }, rule.name || rule.id),
        rule.name && rule.name !== rule.id ? h("span", { style: S.code }, rule.id) : null,
        active ? h(Tag, { tone: "ok" }, T.ruleActiveTag) : null),
      h("p", { style: S.small }, T.ruleMeta(rule.target, formatBytes(rule.bytes))),
      h("p", { style: S.small }, active ? T.ruleDetailActive(rule.target) : T.ruleDetailInactive(rule.target)),
      body.status === "failed"
        ? h(Notice, { notice: { tone: "error", title: T.ruleBodyFailed, next: T.ruleBodyFailedNext } })
        : null,
      body.status === "failed"
        ? h("div", { style: S.row }, h(Button, { size: "small", onClick: onRetryBody }, T.ruleBodyRetry))
        : body.status === "ok"
          ? h("pre", { style: merge(S.codeBlock, { whiteSpace: "pre-wrap" }) }, body.text)
          : h("p", { style: S.small }, T.ruleBodyLoading),
      h("div", { style: S.row },
        h(Button, { size: "small", off: busy, reason: T.whyBusy, label: T.editRule(rule.name || rule.id), onClick: () => { onEdit(rule.id) } }, T.edit),
        active
          ? h(Button, { size: "small", off: busy, reason: T.whyBusy, label: T.deactivateRule(rule.name || rule.id), onClick: () => { onDeactivate(rule) } }, T.deactivate)
          : h(Button, { kind: "primary", size: "small", off: busy, reason: T.whyBusy, label: T.activateRule(rule.name || rule.id), onClick: () => { onActivate(rule) } }, T.activate),
        h(Button, { kind: "quietDanger", size: "small", off: busy, reason: T.whyBusy, label: T.deleteRule(rule.name || rule.id), onClick: () => { onDelete(rule) } }, T.del)))
  }

  function RulesBlock({ rules, activeRule, rulesIndex, rulesIndexPath, selectedId, body, edit, busy, onNew, onOpen, onEdit, onEditChange, onSave, onCancelEdit, onActivate, onDeactivate, onDelete, onRecover, onRetryBody, noticeView }) {
    const isCorrupt = rulesIndex === "corrupt"
    const newWhy = busy ? T.whyBusy : isCorrupt ? T.whyRulesCorrupt : null
    const selected = rules.find((rule) => rule.id === selectedId) ?? rules.find((rule) => rule.id === activeRule) ?? rules[0] ?? null

    // 1. 损坏态（corrupt）：使用 StateBlock(tone: 'error') 居中渲染、包含文件路径透明度 disclosure 与数据安全声明
    if (isCorrupt) {
      return h(Card, {
        title: T.rulesTitle,
        titleId: "bkl-rules-title",
        desc: T.rulesDesc,
      },
        h(StateBlock, {
          tone: "error",
          icon: "xCircle",
          title: T.nsRulesCorruptTitle,
          body: T.rulesCorruptNotice(rulesIndexPath || "breaklimit/rules.json"),
          data: T.dataProtectedRulesBodies,
          actions: [
            h(Button, { kind: "primary", onClick: onRecover }, T.recoverRules),
          ],
          extra: h("details", { className: "bkl-disclosure", style: { marginTop: "14px", textAlign: "left", width: "100%", maxWidth: "460px" } },
            h("summary", null, T.rulesFilesLocations),
            h("ul", { className: "bkl-file-list" },
              h("li", null, rulesIndexPath || "breaklimit/rules.json"),
              h("li", null, "breaklimit/bodies/"))),
        }),
        noticeView ?? null)
    }

    return h(Card, {
      title: T.rulesTitle,
      titleId: "bkl-rules-title",
      desc: T.rulesDesc,
      aside: rules.length === 0
        ? null
        : h("div", { style: S.row },
          h(Tag, null, T.rulesCount(rules.length)),
          edit === null ? h(Button, { size: "small", off: newWhy !== null, reason: newWhy, onClick: onNew }, T.newRule) : null),
    },
      // 清单正常但空规则且未在编辑时：居中渲染 StateBlock(empty)
      rules.length === 0 && edit === null
        ? h(StateBlock, {
          tone: "empty",
          icon: "info",
          title: T.rulesEmptyTitle,
          body: T.rulesEmptyBody,
          actions: [
            h(Button, { kind: "primary", off: newWhy !== null, reason: newWhy, onClick: onNew }, T.newFirstRule),
          ],
        })
        : null,
      // 列表、详情、编辑是三个面：列表选中，详情看正文与操作，编辑只管改草稿。
      rules.length === 0
        ? (edit === null ? null : h(RuleEditor, { edit, rules, activeRule, busy, onChange: onEditChange, onSave, onCancel: onCancelEdit, onOpenExisting: onEdit }))
        : h("div", { style: S.ruleLayout },
          h("div", { style: S.ruleNav },
            h("span", { style: S.fieldLabel }, T.rulesTitle),
            h("nav", { style: S.ruleList, "aria-label": T.rulesTitle },
              rules.map((rule) => {
                const active = rule.id === activeRule
                const picked = selected !== null && rule.id === selected.id
                return h("button", {
                  key: rule.id,
                  type: "button",
                  className: "bkl-hover",
                  style: merge(S.ruleItem, picked && S.ruleItemOn),
                  "aria-current": picked ? "true" : undefined,
                  "aria-label": T.ruleSelect(rule.name || rule.id),
                  onClick: () => { onOpen(rule.id) },
                },
                  h("span", { style: merge(S.strong, { overflowWrap: "anywhere" }) }, rule.name || rule.id),
                  h("span", { style: merge(S.small, { overflowWrap: "anywhere" }) }, rule.target),
                  active ? h(Tag, { tone: "ok" }, T.ruleActiveTag) : null)
              })),
            h("div", { style: S.helpBox },
              h("p", { style: S.small }, [
                T.rulesHeadPrefix,
                h(Term, { termKey: "activate" }),
                T.rulesHeadMid,
                h(Term, { termKey: "instructions" }),
                T.rulesHeadSuffix,
              ] ?? T.rulesDesc),
              h(Button, {
                kind: "quiet", size: "small", onClick: onRecover,
                off: !isCorrupt, reason: T.whyRulesCorrupt,
              }, T.recoverRules))),
          h("div", { style: S.rulePane },
            edit !== null
              ? h(RuleEditor, { edit, rules, activeRule, busy, onChange: onEditChange, onSave, onCancel: onCancelEdit, onOpenExisting: onEdit })
              : selected === null
                ? null
                : h(RuleDetail, {
                  rule: selected, activeRule, body, busy, onEdit, onActivate, onDeactivate, onDelete, onRetryBody,
                }))),
      noticeView ?? null)
  }

  function ruleDeleteDialogSpec(rule, onDelete) {
    const label = rule?.name || rule?.id || ""
    return {
      tone: "danger",
      title: T.confirmDeleteTitle(label),
      consequence: { ok: false, text: T.confirmDeleteConsequence },
      ack: T.confirmDeleteAck,
      body: h("p", { style: S.text }, T.confirmDeleteBody),
      yes: T.confirmDeleteYes,
      run: typeof onDelete === "function" ? onDelete : () => {},
    }
  }

  function recoverRulesDialogSpec(onRecover) {
    return {
      tone: "danger",
      title: T.confirmRecoverRulesTitle,
      confirmWord: T.confirmRecoverWord,
      consequence: { ok: false, text: T.confirmRecoverConsequence },
      body: h("p", { style: S.text }, T.confirmRecoverRulesBody),
      yes: T.confirmRecoverRulesYes,
      run: typeof onRecover === "function" ? onRecover : () => {},
    }
  }

  // ---- 词库页 ---------------------------------------------------------------
  //
  // 列表、搜索、新增/编辑/删除都在这里；本地预览只用已保存的词库，搜索不会改变
  // 预览范围。预览输出是纯文本节点，用户输入永远不会被当成 HTML 执行。

  function WordsPage({ store, query, setQuery, previewText, setPreviewText, restartView, noticeView, onAdd, onEdit, onDelete, onRetryRead, onReturnChat, canReturn }) {
    // 读取失败和「正在保存」是两回事：前者是看不清现状，要报错并停写；
    // 后者只是这一次写入还没回来。混成一个 locked 会让保存期间闪出「读取失败」。
    const readFailed = store.phase !== "ready" || store.stale
    const locked = readFailed || store.saving
    const lockReason = readFailed ? T.wordsReadFailedTitle : store.saving ? T.wordSavingNote : undefined
    const entries = store.entries
    const limits = store.limits
    const isFull = entries.length >= limits.maxEntries
    const addOff = isFull || locked
    const addReason = isFull ? T.wordsLimitNote(limits.maxEntries) : lockReason
    const needle = query.trim().toLowerCase()
    const rows = entries
      .map((entry, index) => ({ entry, index }))
      .filter((item) => needle === "" || item.entry.from.toLowerCase().includes(needle) || item.entry.to.toLowerCase().includes(needle))
    const preview = locked ? null : maskPreview(previewText, entries)
    const previewSummary = locked
      ? T.wordsPreviewPaused
      : entries.length === 0 ? T.wordsPreviewEmptyList
        : previewText.trim() === "" ? T.wordsPreviewInputHint
          : preview.matched.length > 0 ? T.wordsPreviewHit(preview.matched.length)
            : T.wordsPreviewMiss
    return h("div", { style: S.panel },
      h(PageHead, {
        page: "words",
        title: T.pageWordsTitle, desc: T.pageWordsDesc, titleId: "bkl-page-words",
        when: T.whenNewSession,
        aside: canReturn ? h(Button, { size: "small", onClick: onReturnChat }, T.wordsFromChatReturn) : null,
      }),
      restartView ?? null,
      h(Card, {
        title: T.wordsTitle,
        titleId: "bkl-words-title",
        desc: T.wordsLead,
        descId: "bkl-words-lead",
        aside: h("span", { style: merge(S.row, { gap: "6px" }) },
          h(Term, { termKey: "takeover" }),
          h(Term, { termKey: "host" })),
      },
        h("p", { style: S.small }, T.wordsScope)),
      readFailed
        ? h(Notice, {
          notice: {
            tone: "error",
            title: T.wordsReadFailedTitle,
            next: entries.length > 0 ? T.wordsReadFailedStale(entries.length) : T.wordsReadFailedUnknown,
            action: "retryAlias",
          },
          onAction: () => { onRetryRead() },
        })
        : null,
      isFull
        ? h(Notice, {
          notice: {
            tone: "warn",
            title: T.wordsLimitNoticeTitle(limits.maxEntries),
            next: T.wordsLimitNoticeBody,
          },
        })
        : null,
      noticeView ?? null,
      h("div", { style: S.wordLayout },
        h("section", { style: S.wordMain, "aria-labelledby": "bkl-words-list-title" },
          h("div", { style: S.row },
            h("h3", { id: "bkl-words-list-title", style: S.cardTitle }, T.aliasTitle),
            h(Tag, { tone: store.stale ? "warn" : undefined },
              `${store.stale ? `${T.wordsStaleTag}${T.sep}` : ""}${T.wordsCount(entries.length, limits.maxEntries)}`),
            h("span", { style: S.spacer }),
            h(Button, {
              kind: "primary", size: "small", label: T.wordsAdd,
              off: addOff, reason: addReason,
              onClick: onAdd,
            }, T.wordsAdd)),
          entries.length >= limits.maxEntries
            ? h("p", { style: S.small }, T.wordsLimitNote(limits.maxEntries))
            : null,
          h("div", { style: S.wordToolbar },
            h("div", { style: S.wordSearchWrap },
              h("span", { style: S.wordSearchIcon, "aria-hidden": "true" }, "\u2315"),
              h("label", { htmlFor: "bkl-word-search", className: "sr-only" }, T.wordsSearchLabel),
              h("input", {
                id: "bkl-word-search",
                className: "bkl-input",
                type: "search",
                style: merge(S.input, S.wordSearch),
                value: query,
                placeholder: T.wordsSearchLabel,
                onChange: (event) => { setQuery(event.target.value) },
              }),
              query === ""
                ? null
                : h("div", { style: S.wordSearchClear },
                  h(Button, { kind: "quiet", size: "small", label: T.wordsSearchClear, onClick: () => { setQuery("") } }, "\u00d7"))),
          ),
          // 读不出来时列表必然是空的，但「还没有词条」不成立：那是真的没配过。
          // 两条提示同时出现，用户会以为加一条就能修好。
          readFailed && entries.length === 0
            ? null
            : entries.length === 0
              ? h(Empty, {
                title: T.wordsEmptyTitle,
                body: T.wordsEmptyBody,
                action: h(Button, {
                  kind: "primary", size: "small", off: addOff, reason: addReason, label: T.wordsEmptyAdd, onClick: onAdd,
                }, T.wordsEmptyAdd),
              })
              : rows.length === 0
                ? h(Empty, {
                  title: T.wordsNoMatchTitle,
                  body: T.wordsNoMatchBody,
                  action: h(Button, { size: "small", onClick: () => { setQuery("") } }, T.wordsSearchClear),
                })
                : [
                  h("div", {
                    key: "word-head",
                    className: "bkl-word-head",
                    style: S.wordHead,
                  },
                    h("div", { style: S.wordCells },
                      h("span", null, T.wordsColFrom),
                      h("span", { "aria-hidden": "true", style: { color: tk.label3, visibility: "hidden" } }, "→"),
                      h("span", null, T.wordsColTo)),
                    h("div", { style: S.wordActions }, T.wordsColActions)),
                  h("ul", { key: "word-list", style: merge(S.wordList, store.stale && S.wordStale), "aria-labelledby": "bkl-words-list-title" },
                    rows.map((item, row) => h("li", { key: `${String(item.index)}:${String(item.entry.from)}`, style: merge(S.wordRow, row === 0 && S.wordRowFirst) },
                      h("div", { style: S.wordCells },
                        h("span", { style: S.wordCell }, String(item.entry.from)),
                        h("span", { "aria-hidden": "true", style: { color: tk.label3 } }, "\u2192"),
                        h("span", { style: S.wordCell }, String(item.entry.to))),
                      h("div", { style: S.wordActions },
                        h(Button, {
                          kind: "icon", size: "small", label: T.wordsEditLabel(item.entry.from),
                          className: "bkl-word-edit",
                          off: locked ? true : undefined, onClick: () => { onEdit(item.index) },
                        }, h(Icon, { name: "edit", size: 15 })),
                        h(Button, {
                          kind: "icon", size: "small", label: T.wordsDeleteLabel(item.entry.from),
                          className: "bkl-word-del",
                          off: locked ? true : undefined, onClick: () => { onDelete(item.index) },
                        }, h(Icon, { name: "trash", size: 15 })))))),
                ],
          h("p", { style: S.small }, T.wordsEachSave)),
        h("aside", { style: merge(S.card, S.wordAside), "aria-labelledby": "bkl-words-preview-title" },
          h("h3", { id: "bkl-words-preview-title", style: S.cardTitle }, T.wordsPreviewTitle),
          h("p", { style: S.small }, T.wordsPreviewDesc),
          h("div", { style: S.field },
            h("label", { htmlFor: "bkl-word-preview", style: S.fieldLabel }, T.wordsPreviewInput),
            h("textarea", {
              id: "bkl-word-preview",
              className: "bkl-input",
              style: merge(S.input, { minHeight: "84px" }),
              value: previewText,
              placeholder: T.wordsPreviewPlaceholder,
              spellCheck: false,
              readOnly: locked,
              onChange: (event) => { setPreviewText(event.target.value) },
            })),
          h("div", { style: S.row },
            h("span", { style: S.fieldLabel }, T.wordsPreviewOutput),
            h("span", { style: S.spacer }),
            h("span", { style: S.caption }, T.wordsPreviewLocal)),
          h("pre", { style: S.wordPreviewBox, "aria-live": "polite" }, locked ? "" : preview.text),
          h("p", { style: S.small }, previewSummary),
          locked || preview.matched.length === 0
            ? null
            : h("div", { style: S.wordChips },
              preview.matched.map((from) => {
                const entry = entries.find((item) => item.from === from)
                return h("div", { key: from, style: S.wordChip }, `${from} \u2192 ${entry?.to ?? ""}`)
              })),
          h("details", null,
            h("summary", { style: S.small }, T.wordsPreviewRulesTitle),
            h("p", { style: S.small }, T.wordsPreviewRules1),
            h("p", { style: S.small }, T.wordsPreviewRules2)))))
  }

  /** 词条编辑弹窗的正文与按钮。phase 决定显示编辑表单还是覆盖/合并/放弃确认。 */
  function WordEditor({ editor, entries, limits, saving, error, onField, onSave, onCancel, onBack, onConfirmOverwrite, onConfirmDiscard }) {
    const errors = wordEntryErrors(editor.from, editor.to, {
      originalFrom: editor.originalFrom, entries, maxEntries: limits.maxEntries, maxTerm: limits.maxTerm,
    })
    const invalid = errors.from !== "" || errors.to !== "" || errors.limit !== ""
    const dirty = editor.from !== editor.baselineFrom || editor.to !== editor.baselineTo
    const pair = (entry) => h(Pair, { key: `${String(entry.from)}:${String(entry.to)}`, entry })
    if (editor.phase === "discard") {
      return {
        title: T.wordDiscardTitle,
        tone: "error",
        body: h("p", { style: S.text }, T.wordDiscardBody),
        foot: [
          h(Button, { key: "back", onClick: onBack }, T.wordKeepEdit),
          h(Button, { key: "yes", kind: "danger", onClick: onConfirmDiscard }, T.wordDiscardYes),
        ],
      }
    }
    if (editor.phase === "overwrite" || editor.phase === "merge") {
      const current = editor.originalFrom === null
        ? null
        : entries.find((item) => item.from === editor.originalFrom) ?? null
      const duplicate = entries.find((item) => item.from === editor.from.trim()) ?? null
      const final = { from: editor.from.trim(), to: editor.to.trim() }
      return {
        title: editor.phase === "merge" ? T.wordMergeTitle : T.wordOverwriteTitle(final.from),
        tone: "error",
        body: h("div", { style: S.wordEditorFields },
          h("p", { style: S.text }, editor.phase === "merge" ? T.wordMergeBody : T.wordOverwriteBody),
          current === null ? null : h("span", { style: S.fieldLabel }, T.wordMergeCurrent),
          current === null ? null : pair(current),
          duplicate === null ? null : h("span", { style: S.fieldLabel }, T.wordMergeDuplicate),
          duplicate === null ? null : pair(duplicate),
          h("span", { style: S.fieldLabel }, T.wordMergeFinal),
          pair(final)),
        foot: [
          h(Button, { key: "back", onClick: onBack }, T.wordBackEdit),
          h(Button, {
            key: "yes", kind: "danger", onClick: onConfirmOverwrite,
          }, editor.phase === "merge" ? T.wordMergeYes : T.wordOverwriteYes),
        ],
      }
    }
    const field = (key, label, placeholder, errorText) => h("div", { key, style: S.field },
      h("label", { htmlFor: `bkl-word-${key}`, style: S.fieldLabel }, label),
      h("input", {
        id: `bkl-word-${key}`,
        className: "bkl-input",
        style: S.input,
        value: editor[key],
        placeholder,
        spellCheck: false,
        autoComplete: "off",
        readOnly: saving ? true : undefined,
        "aria-invalid": editor.touched && errorText !== "" ? "true" : undefined,
        "aria-describedby": `bkl-word-${key}-error bkl-word-${key}-cap`,
        onChange: (event) => { onField(key, event.target.value) },
      }),
      h("div", { style: S.row },
        h("span", { id: `bkl-word-${key}-error`, style: merge(S.fieldError, { flex: "1 1 auto" }) }, editor.touched ? errorText : ""),
        h("span", { id: `bkl-word-${key}-cap`, style: S.wordCounter }, T.wordCap(String(editor[key]).trim().length))))
    return {
      title: editor.originalFrom === null ? T.wordEditorAddTitle : T.wordEditorEditTitle,
      tone: "accent",
      body: h("div", { style: S.wordEditorFields },
        h("p", { style: S.small }, T.wordEditorHint),
        field("from", T.wordFromLabel, T.wordFromPlaceholder, errors.from),
        field("to", T.wordToLabel, T.wordToPlaceholder, errors.to),
        errors.limit === "" ? null : h("p", { style: S.fieldError }, errors.limit),
        error === null ? null : h(Notice, { notice: error })),
      foot: [
        h("p", { key: "why", style: S.dialogNote },
          saving ? T.wordSavingNote : invalid ? errors.limit || errors.from || errors.to : !dirty ? T.wordNoChange : T.wordSaveNote),
        h(Button, { key: "cancel", onClick: onCancel, off: saving, reason: T.wordSavingNote }, T.cancel),
        h(Button, {
          key: "save", kind: "primary", onClick: onSave,
          off: invalid || !dirty || saving, reason: T.wordSaveNote,
          autofocus: true,
        }, saving ? T.saving : T.wordSave),
      ],
    }
  }

  // ---- 分区根 ---------------------------------------------------------------

  function Section(props) {
    // 宿主给设置分区传 close：从会话浮窗进来的「返回会话」用它。
    const closeSettings = typeof props?.close === "function" ? props.close : null
    const [tab, setTab] = useState(TAB_KEYS[0])
    const [status, setStatus] = useState(null)
    const [loadError, setLoadError] = useState(null)
    const [patchInfo, setPatchInfo] = useState(null)
    const [patchError, setPatchError] = useState(null)
    const [override, setOverride] = useState(null)
    const [promptError, setPromptError] = useState(null)
    const [tierInfo, setTierInfo] = useState(null)
    const [loadedAt, setLoadedAt] = useState(0)
    const [busy, setBusy] = useState(false)
    const [toggles, setToggles] = useState({})
    const [enabledPending, setEnabledPending] = useState(false)
    const [dialog, setDialog] = useState(null)
    const [toast, setToast] = useState(null)
    const [notices, setNotices] = useState({})
    const [restart, setRestart] = useState(null)
    const [draft, setDraft] = useState(null)
    const [guideOpen, setGuideOpen] = useState(true)
    const [ruleEdit, setRuleEdit] = useState(null)
    const [selectedRuleId, setSelectedRuleId] = useState(null)
    const [ruleBody, setRuleBody] = useState({ id: null, status: "idle", text: "" })
    const [wordEditor, setWordEditor] = useState(null)
    const [wordSaving, setWordSaving] = useState(false)
    const [wordSaveError, setWordSaveError] = useState(null)
    const [wordsQuery, setWordsQuery] = useState("")
    const [wordsPreview, setWordsPreview] = useState("")
    const [, bump] = useState(0)
    const mounted = useRef(true)
    const noticeTimers = useRef({})
    // toast 自动消失的计时器；先于清理函数声明，清理路径引用它才不依赖执行时机。
    const toastTimer = useRef(undefined)
    // 正文草稿的影子副本：保存完成后要判断「保存期间是不是又输入了」，
    // 而那时闭包里的 draft 是旧值，只能信实时副本。
    const draftRef = useRef(null)
    const setPromptDraft = useCallback((value) => {
      draftRef.current = typeof value === "function" ? value(draftRef.current) : value
      setDraft(draftRef.current)
    }, [])

    useEffect(() => {
      mounted.current = true
      return () => {
        mounted.current = false
        for (const timer of Object.values(noticeTimers.current)) clearTimeout(timer)
        if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
      }
    }, [])

    // 作用域样式只注入一次；多个实例共用同一个 id。
    useEffect(() => {
      if (typeof document === "undefined" || !document.head || document.getElementById(STYLE_ID)) return
      const element = document.createElement("style")
      element.id = STYLE_ID
      element.textContent = SCOPED_CSS
      document.head.appendChild(element)
    }, [])

    useEffect(() => {
      if (refreshText()) bump(value => value + 1)
      if (typeof MutationObserver !== "function" || typeof document === "undefined" || !document.documentElement) return undefined
      const observer = new MutationObserver(() => { if (refreshText()) bump(value => value + 1) })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] })
      return () => { observer.disconnect() }
    }, [])

    // 让「更新于 N 分钟前」走动。
    useEffect(() => {
      const timer = setInterval(() => { bump(value => value + 1) }, CLOCK_MS)
      return () => { clearInterval(timer) }
    }, [])

    // 页面卸载或刷新时拦截未保存草稿（正文、规则、词条编辑器）。
    useEffect(() => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onBeforeUnload = (event) => {
        const ruleDirty = isRuleEditDirty(ruleEdit)
        const promptDirty = draft !== null && draft !== (typeof override?.text === "string" ? override.text : "")
        const wordDirty = wordEditor !== null && (wordEditor.from !== wordEditor.baselineFrom || wordEditor.to !== wordEditor.baselineTo)
        if (ruleDirty || promptDirty || wordDirty) {
          event.preventDefault()
          event.returnValue = ""
        }
      }
      window.addEventListener("beforeunload", onBeforeUnload)
      return () => { window.removeEventListener("beforeunload", onBeforeUnload) }
    }, [ruleEdit, draft, override, wordEditor])

    const clearNotice = useCallback((scope) => {
      const timer = noticeTimers.current[scope]
      if (timer !== undefined) {
        clearTimeout(timer)
        delete noticeTimers.current[scope]
      }
      setNotices(prev => {
        if (prev[scope] === undefined) return prev
        const next = { ...prev }
        delete next[scope]
        return next
      })
    }, [])

    // 底部 toast：短确认文案（复制成功、已保存等）自动消失；同一时刻只留最新一条。
    const showToast = useCallback((text) => {
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
      setToast(text)
      toastTimer.current = setTimeout(() => {
        toastTimer.current = undefined
        if (mounted.current) setToast(null)
      }, TOAST_MS)
    }, [])

    const notify = useCallback((scope, notice) => {
      const timer = noticeTimers.current[scope]
      if (timer !== undefined) clearTimeout(timer)
      delete noticeTimers.current[scope]
      setNotices(prev => ({ ...prev, [scope]: notice }))
      // 重要结果就地保留（sticky）；一般成功提示才自动收。
      if ((notice.tone === "ok" || notice.tone === "info") && notice.sticky !== true) {
        noticeTimers.current[scope] = setTimeout(() => {
          delete noticeTimers.current[scope]
          if (mounted.current) setNotices(prev => (prev[scope] === notice ? { ...prev, [scope]: undefined } : prev))
        }, NOTICE_OK_MS)
      }
    }, [])

    const load = useCallback(async () => {
      const [statusResult, patchResult, overrideResult, tierResult] = await Promise.allSettled([
        get("/status"), get("/patches"), get("/override"), get("/tier"),
      ])
      if (!mounted.current) return
      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value.data ?? null)
        setLoadError(null)
      } else {
        setLoadError(explain(statusResult.reason))
      }
      if (patchResult.status === "fulfilled") {
        setPatchInfo(patchResult.value.data ?? null)
        setPatchError(null)
      } else {
        setPatchError(explain(patchResult.reason))
      }
      if (overrideResult.status === "fulfilled") {
        setOverride(overrideResult.value.data ?? null)
        setPromptError(null)
      } else {
        // 读不到正文就是读不到：不能把界面退回到空正文或内置正文。
        setPromptError(explain(overrideResult.reason))
      }
      if (tierResult.status === "fulfilled") setTierInfo(tierResult.value.data ?? null)
      // 「刷新」是重新检查：词库也一起重读，读取失败才能在这里现形。
      void aliasStore.read()
      setLoadedAt(Date.now())
    }, [])

    useEffect(() => { void load() }, [load])

    // 词库是两个挂载点共用的一份状态（见 createAliasStore）；这里只订阅重绘。
    // 首次读取由 load() 负责，不在这里再来一次——那会让挂载瞬间发两个 GET /alias。
    useEffect(() => aliasStore.subscribe(() => { if (mounted.current) bump(value => value + 1) }), [])

    // 浮窗改了档位或词表，这里那份状态就旧了。两个挂载点各持一份 state，
    // 用事件而不是共享 store：只需要「重新拉一次」，不需要新的全局状态层。
    useEffect(() => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onStateChanged = () => { void load() }
      window.addEventListener(STATE_CHANGED_EVENT, onStateChanged)
      return () => { window.removeEventListener(STATE_CHANGED_EVENT, onStateChanged) }
    }, [load])

    // 浮窗的「管理词库」：分区已挂载就直接切页；没挂载则记下待落地页签。
    useEffect(() => {
      if (pendingTabRequest !== null) {
        const wanted = pendingTabRequest
        pendingTabRequest = null
        setTab(wanted)
      }
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onNavigate = (event) => {
        const detail = event?.detail
        if (detail === null || typeof detail !== "object") return
        detail.handled = true
        if (typeof detail.tab === "string" && TAB_KEYS.includes(detail.tab)) setTab(detail.tab)
      }
      window.addEventListener(NAVIGATE_EVENT, onNavigate)
      return () => { window.removeEventListener(NAVIGATE_EVENT, onNavigate) }
    }, [])

    // 五个页签在窄屏横排滚动；选中项要在切页后和窗口变化后都保持可见。
    useEffect(() => {
      revealSelectedTab(tab)
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onResize = () => { revealSelectedTab(tab) }
      window.addEventListener("resize", onResize)
      return () => { window.removeEventListener("resize", onResize) }
    }, [tab])

    // 规则详情正文按需读取：选中项变了就拉一次；失败停在失败态，可以重试。
    useEffect(() => {
      if (status === null) return
      const rules = Array.isArray(status.rules) ? status.rules : []
      const activeRule = typeof status.activeRule === "string" ? status.activeRule : null
      const selected = rules.find((rule) => rule.id === selectedRuleId) ?? rules.find((rule) => rule.id === activeRule) ?? rules[0]
      if (selected === undefined) return
      if (ruleBody.id !== selected.id || ruleBody.status === "idle") loadRuleBody(selected.id)
    }, [status, selectedRuleId])

    /** 写操作的统一外壳：同一时刻只跑一个；失败就近报错；reload 为真时无论成败都重新拉状态。 */
    const run = useCallback(async (scope, work, reload) => {
      setBusy(true)
      clearNotice(scope)
      try {
        await work()
      } catch (error) {
        if (mounted.current) notify(scope, explain(error))
      } finally {
        if (reload) await load().catch(() => {})
        if (mounted.current) setBusy(false)
      }
    }, [clearNotice, notify, load])

    const copy = useCallback(async (text, scope) => {
      const ok = await writeClipboard(text)
      if (!mounted.current) return
      // 复制成功是「已完成」短反馈走 toast；失败需要用户决定下一步，保留 Notice。
      if (ok) showToast(T.copied)
      else notify(scope, { tone: "warn", title: T.copyFailed, next: T.copyFailedNext })
    }, [notify, showToast])

    const goTab = useCallback((key) => {
      setTab(key)
      setDialog(null)
    }, [])

    // 所有确认（应用、回退、切档、覆盖、删除、恢复）共用一个弹窗：确认才执行，
    // Esc / 取消 / 点遮罩都原样退出，不留下半截状态。
    const openDialog = useCallback((spec) => { setDialog(spec) }, [])
    const closeDialog = useCallback(() => { setDialog(null) }, [])

    // 使用说明弹窗：三步 + 生效时机一句。不传 yes；只读说明没有可放弃的操作，
    // 底部按钮文案用「关闭」而不是「取消」。
    const openHelp = useCallback(() => {
      openDialog({
        title: T.helpTitle,
        tone: "accent",
        cancelText: T.dismissShort,
        body: h("div", { style: S.wordEditorFields },
          h("p", { style: S.text }, T.helpIntro),
          h("ol", { style: S.ol },
            h("li", null, h("strong", null, T.guideStep1Title), h("p", { style: S.small }, T.guideStep1Body)),
            h("li", null, h("strong", null, T.guideStep2Title), h("p", { style: S.small }, T.guideStep2Body)),
            h("li", null, h("strong", null, T.guideStep3Title), h("p", { style: S.small }, T.guideStep3Body))),
          h("p", { style: S.small }, T.helpEffect)),
      })
    }, [openDialog])

    const accept = useCallback(() => {
      const current = dialog
      setDialog(null)
      if (current !== null && typeof current.run === "function") void current.run()
    }, [dialog])

    // ---- 重启 ----

    const fetchRestartCommand = useCallback(async () => {
      try {
        const payload = await post("/restart", {})
        const command = typeof payload.data?.command === "string" && payload.data.command !== "" ? payload.data.command : null
        if (mounted.current) setRestart(prev => (prev === null ? prev : { ...prev, command }))
        return command
      } catch {
        if (mounted.current) setRestart(prev => (prev === null ? prev : { ...prev, command: null }))
        return null
      }
    }, [])

    const startRestart = useCallback((kind, count) => {
      setRestart({ kind, count, command: undefined, open: false })
      void fetchRestartCommand()
    }, [fetchRestartCommand])

    const copyRestart = useCallback(async () => {
      const command = typeof restart?.command === "string" ? restart.command : await fetchRestartCommand()
      if (command === null) {
        notify("restart", { tone: "warn", title: T.restartNoCommand })
        return
      }
      await copy(command, "restart")
    }, [restart, fetchRestartCommand, notify, copy])

    // ---- 动作 ----

    const runAction = useCallback((action) => {
      if (action === "retry" || action === "refresh") void load()
      else if (action === "goPatches") goTab("patches")
      else if (action === "goPrompt") goTab("prompt")
      else if (action === "goRules") goTab("rules")
      else if (action === "goWords") goTab("words")
      else if (action === "goOverview") goTab("overview")
      else if (action === "copyRoot") void copy(T.nsRootSnippet, "next")
      else if (action === "copyRestart") void copyRestart()
      else if (action === "retryAlias") void aliasStore.read()
      else if (action === "recoverRules") askRecoverRules("next")
    }, [load, goTab, copy, copyRestart])

    const togglePatch = useCallback(async (id, next) => {
      setToggles(prev => ({ ...prev, [id]: next }))
      clearNotice("patches")
      try {
        await post("/patches/enabled", { id, enabled: next })
        await load()
      } catch (error) {
        if (mounted.current) notify("patches", explain(error))
      } finally {
        if (mounted.current) {
          setToggles(prev => {
            const copyOf = { ...prev }
            delete copyOf[id]
            return copyOf
          })
        }
      }
    }, [clearNotice, notify, load])

    const toggleEnabled = useCallback(async (next) => {
      setEnabledPending(true)
      clearNotice("overview")
      try {
        await post("/enabled", { enabled: next })
        await load()
        if (mounted.current) notify("overview", { tone: "ok", title: T.doneTakeover(next) })
      } catch (error) {
        if (mounted.current) notify("overview", explain(error))
      } finally {
        if (mounted.current) setEnabledPending(false)
      }
    }, [clearNotice, notify, load])

    const f = derive(status, patchInfo, tierInfo, override, restart)

    const askApply = () => {
      openDialog({
        title: T.confirmApplyTitle(f.pendingFiles),
        body: h("div", { style: S.wordEditorFields },
          h("p", { style: S.text }, T.confirmApplyBody),
          h(PathList, { items: f.pendingPaths })),
        yes: T.confirmApplyYes(f.pendingFiles),
        run: () => run("patches", async () => {
          const payload = await post("/apply", {})
          const written = Array.isArray(payload.data?.written) ? payload.data.written.length : 0
          if (written === 0) {
            // 待写入为零只说明磁盘已经是补丁后的样子，不能证明宿主重启过。
            notify("patches", { tone: "info", title: T.doneAlready, next: T.doneAlreadyNext })
            return
          }
          notify("patches", { tone: "ok", title: T.doneApplied(written), next: T.doneAppliedNext })
          startRestart("apply", written)
        }, true),
      })
    }

    const askRevert = () => {
      const count = Number(f.applied?.files) || 0
      openDialog({
        tone: "danger",
        title: T.confirmRevertTitle(count),
        body: h("p", { style: S.text }, T.confirmRevertBody),
        yes: T.confirmRevertYes(count),
        run: () => run("patches", async () => {
          const payload = await post("/revert", {})
          const restored = Array.isArray(payload.data?.restored) ? payload.data.restored.length : 0
          if (restored === 0) {
            notify("patches", { tone: "info", title: T.doneRevertNothing, next: T.doneAlreadyNext })
            return
          }
          notify("patches", { tone: "ok", title: T.doneReverted(restored), next: T.doneAppliedNext })
          startRestart("revert", restored)
        }, true),
      })
    }

    const pickMode = (id) => {
      if (id === f.mode) {
        if (dialog !== null && dialog.pick !== undefined) closeDialog()
        return
      }
      const spec = modeSwitchDialogSpec(f.mode, id, () => run("mode", async () => {
        const label = modeLabel(id)
        await post("/tier", { tier: id })
        notify("mode", { tone: "ok", title: T.doneMode(label), next: T.doneModeNext })
      }, true))
      openDialog(spec)
    }

    const savePrompt = () => {
      if (draft === null) return
      const text = draft
      void run("prompt", async () => {
        const payload = await post("/override", { text })
        await load()
        if (!mounted.current) return
        // 保存期间继续输入的新内容不能被成功回调清掉：只收回提交过的那一份。
        const remaining = draftAfterSave(draftRef.current, text)
        setPromptDraft(remaining)
        notify("prompt", remaining === null
          ? { tone: "ok", title: T.donePromptSaved(formatBytes(payload.data?.bytes)), next: T.saveHint }
          : { tone: "warn", title: T.donePromptSavedMore, next: T.donePromptSavedMoreNext })
      })
    }

    const askResetPrompt = () => {
      openDialog({
        tone: "danger",
        title: T.confirmResetTitle,
        body: h("p", { style: S.text }, T.confirmResetBody(formatBytes(override?.bytes))),
        yes: T.confirmResetYes,
        run: () => run("prompt", async () => {
          await post("/override", { text: "" })
          await load()
          if (!mounted.current) return
          setPromptDraft(null)
          notify("prompt", { tone: "ok", title: T.donePromptReset })
        }),
      })
    }

    const askDiscardPrompt = () => {
      if (draft === null) return
      openDialog({
        tone: "danger",
        title: T.confirmDiscardPromptTitle,
        body: h("p", { style: S.text }, T.confirmDiscardPromptBody),
        yes: T.confirmDiscardPromptYes,
        run: () => {
          setPromptDraft(null)
          clearNotice("prompt")
        },
      })
    }

    const ruleLabel = (id) => {
      const found = f.rules.find(rule => rule.id === id)
      return found?.name || id
    }

    const guardDirtyRule = (onProceed) => {
      if (isRuleEditDirty(ruleEdit)) {
        openDialog({
          tone: "danger",
          title: T.confirmDiscardRuleTitle,
          body: h("p", { style: S.text }, T.confirmDiscardRuleBody),
          yes: T.confirmDiscardYes,
          run: () => { onProceed() },
        })
        return
      }
      onProceed()
    }

    const doNewRule = () => {
      clearNotice("rules")
      setDialog(null)
      const empty = { isNew: true, id: "", name: "", target: RULE_TARGETS[0], text: "" }
      setRuleEdit({ ...empty, baseline: empty })
    }

    const newRule = () => {
      guardDirtyRule(doNewRule)
    }

    const doEditRule = (id) => {
      setDialog(null)
      void run("rules", async () => {
        const payload = await get(`/rules/read?id=${encodeURIComponent(id)}`)
        if (!mounted.current) return
        const initial = {
          isNew: false,
          id,
          name: typeof payload.data?.name === "string" && payload.data.name !== id ? payload.data.name : "",
          target: RULE_TARGETS.includes(payload.data?.target) ? payload.data.target : RULE_TARGETS[0],
          text: typeof payload.data?.text === "string" ? payload.data.text : "",
        }
        setRuleEdit({ ...initial, baseline: initial })
      })
    }

    const editRule = (id) => {
      if (ruleEdit !== null && !ruleEdit.isNew && ruleEdit.id === id) return
      guardDirtyRule(() => { doEditRule(id) })
    }

    const cancelEdit = () => {
      guardDirtyRule(() => { setRuleEdit(null) })
    }

    const doSaveRule = (edit) => {
      void run("rules", async () => {
        const payload = await post("/rules/save", { id: edit.id, name: edit.name.trim() || edit.id, target: edit.target, text: edit.text })
        const data = payload.data ?? {}
        const saved = ruleSaveNotice(data, f.activeRule, edit)
        if (mounted.current) {
          setRuleEdit(null)
          setSelectedRuleId(edit.id)
          setRuleBody({ id: edit.id, status: "ok", text: edit.text })
          notify("rules", {
            tone: saved.tone,
            title: saved.title,
            next: saved.next,
            // 保存与激活是两步：保存只存下来，要生效请再按一次「现在激活」。
            action: saved.activateRule === null ? undefined : "activateNow",
            actionRule: saved.activateRule ?? undefined,
          })
        }
      }, true)
    }

    const saveRule = () => {
      if (ruleEdit === null) return
      const edit = ruleEdit
      const idTaken = edit.isNew && f.rules.some(rule => rule.id === edit.id)
      if (idTaken) {
        openDialog({
          tone: "danger",
          title: T.confirmOverwriteRuleTitle(edit.id),
          body: h("p", { style: S.text }, T.confirmOverwriteRuleBody),
          yes: T.confirmOverwriteRuleYes,
          run: () => { doSaveRule(edit) },
        })
        return
      }
      doSaveRule(edit)
    }

    const askActivate = (rule) => {
      const label = rule.name || rule.id
      const other = f.activeRule !== null && f.activeRule !== rule.id ? ruleLabel(f.activeRule) : null
      openDialog({
        title: T.confirmActivateTitle(label),
        body: h("p", { style: S.text }, T.confirmActivateBody(rule.target, formatBytes(rule.bytes))),
        foot: other === null ? null : T.confirmActivateSwap(other),
        yes: T.confirmActivateYes,
        run: () => run("rules", async () => {
          const payload = await post("/rules/activate", { id: rule.id })
          const skipped = payload.data?.previousLanding?.skipped
          notify("rules", {
            tone: "ok",
            title: T.doneActivated(label, String(payload.data?.target ?? rule.target)),
            next: Array.isArray(skipped) && skipped.length > 0 ? T.landingSkipped(skipped.length) : T.doneActivatedNext,
          })
        }, true),
      })
    }

    const askDeactivate = (rule) => {
      const label = rule.name || rule.id
      openDialog({
        title: T.confirmDeactivateTitle(label),
        body: h("p", { style: S.text }, T.confirmDeactivateBody(rule.target)),
        yes: T.confirmDeactivateYes,
        run: () => run("rules", async () => {
          const payload = await post("/rules/activate", { id: "" })
          const data = payload.data ?? {}
          const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0
          notify("rules", {
            tone: skipped > 0 ? "warn" : "ok",
            title: T.doneDeactivated,
            next: skipped > 0 ? T.landingSkipped(skipped) : data.restored ? T.landingRestored(rule.target) : data.removed ? T.landingRemoved(rule.target) : undefined,
          })
        }, true),
      })
    }

    const askDelete = (rule) => {
      const label = rule.name || rule.id
      const active = rule.id === f.activeRule
      const spec = ruleDeleteDialogSpec(rule, () => run("rules", async () => {
        await post("/rules/delete", { id: rule.id })
        if (!mounted.current) return
        setRuleEdit(prev => (prev !== null && prev.id === rule.id ? null : prev))
        setSelectedRuleId(prev => (prev === rule.id ? null : prev))
        notify("rules", { tone: "ok", title: T.doneDeleted(label) })
      }, true))
      if (active) {
        spec.body = h("p", { style: S.text }, T.confirmDeleteActiveBody(rule.target))
      }
      openDialog(spec)
    }

    const askRecoverRules = (scope = "next") => {
      const spec = recoverRulesDialogSpec(() => run(scope, async () => {
        const payload = await post("/rules/recover-corrupt", {})
        const backupPath = payload.data?.backupPath ?? "dsh-breaklimit-backup"
        notify(scope, {
          tone: "ok",
          title: T.doneRecoverRules,
          next: T.doneRecoverRulesNext(backupPath),
        })
        await load()
      }, true))
      openDialog(spec)
    }

    // ---- 规则详情 ----

    /** 详情正文按需读取。失败就停在失败态，可以重试，不拿空正文冒充。 */
    const loadRuleBody = (id) => {
      setRuleBody({ id, status: "loading", text: "" })
      void (async () => {
        try {
          const payload = await get(`/rules/read?id=${encodeURIComponent(id)}`)
          if (!mounted.current) return
          setRuleBody(prev => (prev.id === id
            ? { id, status: "ok", text: typeof payload.data?.text === "string" ? payload.data.text : "" }
            : prev))
        } catch {
          if (!mounted.current) return
          setRuleBody(prev => (prev.id === id ? { id, status: "failed", text: "" } : prev))
        }
      })()
    }

    const openRule = (id) => {
      setSelectedRuleId(id)
      setRuleEdit(null)
      clearNotice("rules")
      loadRuleBody(id)
    }

    // ---- 词库 ----

    const wordsLocked = aliasStore.state.phase !== "ready" || aliasStore.state.stale || aliasStore.state.saving

    const openWordEditor = (index = null) => {
      if (wordsLocked) return
      const entries = aliasStore.state.entries
      const existing = index === null ? null : entries[index] ?? null
      if (index !== null && existing === null) return
      setWordSaveError(null)
      setWordEditor({
        phase: "edit",
        originalFrom: existing?.from ?? null,
        from: existing?.from ?? "",
        to: existing?.to ?? "",
        baselineFrom: existing?.from ?? "",
        baselineTo: existing?.to ?? "",
        touched: false,
      })
    }

    const setWordField = (key, value) => {
      setWordEditor(prev => (prev === null ? prev : { ...prev, [key]: value, touched: true }))
    }

    const backToWordEdit = () => {
      setWordEditor(prev => (prev === null ? prev : { ...prev, phase: "edit" }))
    }

    /** 关闭编辑器：有未保存输入先确认；确认前输入一直留着。 */
    const requestCloseWordEditor = () => {
      const editor = wordEditor
      if (editor === null || wordSaving) return
      if (editor.phase !== "edit") {
        backToWordEdit()
        return
      }
      if (editor.from !== editor.baselineFrom || editor.to !== editor.baselineTo) {
        setWordEditor({ ...editor, phase: "discard" })
        return
      }
      setWordEditor(null)
      setWordSaveError(null)
    }

    const saveWordChange = async (change, successTitle) => {
      setWordSaving(true)
      setWordSaveError(null)
      const result = await aliasStore.commit(change)
      if (!mounted.current) return
      setWordSaving(false)
      if (!result.ok) {
        if (result.unknown) {
          // 超时/断网不等于后端没写：不宣布「未生效」，草稿留着，先重新读取核对。
          setWordSaveError({ tone: "warn", title: T.wordSaveUnknownTitle, next: T.wordSaveUnknownNext })
          void aliasStore.read()
        } else {
          setWordSaveError({ tone: "error", title: T.wordSaveFailedTitle, next: T.wordSaveFailedNext })
        }
        setWordEditor(prev => (prev === null ? prev : { ...prev, phase: "edit" }))
        return
      }
      setWordEditor(null)
      setWordSaveError(null)
      // 成功后列表以写接口返回的数据为准（后端做了规范化），另一处挂载点随共享 store 同步。
      notify("words", { tone: "ok", sticky: true, title: successTitle, next: T.wordSavedNext })
    }

    const requestWordSave = () => {
      const editor = wordEditor
      if (editor === null || wordsLocked || wordSaving) return
      const errors = wordEntryErrors(editor.from, editor.to, {
        originalFrom: editor.originalFrom,
        entries: aliasStore.state.entries,
        maxEntries: aliasStore.state.limits.maxEntries,
        maxTerm: aliasStore.state.limits.maxTerm,
      })
      if (errors.from !== "" || errors.to !== "" || errors.limit !== "") {
        setWordEditor({ ...editor, touched: true })
        return
      }
      const entry = { from: editor.from.trim(), to: editor.to.trim() }
      const change = { type: "save", originalFrom: editor.originalFrom, entry }
      const kind = aliasChangeKind(aliasStore.state.entries, change)
      if (kind !== null) {
        // 新增撞原词 → 覆盖确认；编辑改名撞原词 → 合并确认。取消就回到编辑态，输入保留。
        setWordEditor({ ...editor, phase: kind, touched: true })
        return
      }
      void saveWordChange(change, T.wordSaved)
    }

    const confirmWordOverwrite = () => {
      const editor = wordEditor
      if (editor === null) return
      const entry = { from: editor.from.trim(), to: editor.to.trim() }
      const merged = editor.originalFrom !== null && editor.originalFrom !== entry.from
      setWordEditor({ ...editor, phase: "edit" })
      void saveWordChange({ type: "save", originalFrom: editor.originalFrom, entry }, merged ? T.wordSavedMerged : T.wordSaved)
    }

    const askDeleteWord = (index) => {
      const entry = aliasStore.state.entries[index]
      if (entry === undefined || wordsLocked) return
      openDialog({
        tone: "danger",
        title: T.wordDeleteTitle(entry.from),
        body: h("div", { style: S.wordEditorFields },
          h(Pair, { entry }),
          h("p", { style: S.small }, T.wordDeleteBody)),
        yes: T.wordDeleteYes,
        run: () => { void saveWordChange({ type: "delete", from: entry.from }, T.wordDeleted) },
      })
    }

    const retryAliasRead = () => {
      void aliasStore.read().then(() => {
        if (!mounted.current) return
        if (aliasStore.state.phase === "ready" && !aliasStore.state.stale) {
          notify("words", { tone: "ok", title: T.wordsReadOk })
        }
      })
    }

    const returnToChat = () => {
      wordsFromChat = false
      if (closeSettings !== null) closeSettings()
    }

    // ---- 渲染 ----

    const noticeFor = (scope) => (notices[scope]
      ? h(Notice, {
        notice: notices[scope],
        onAction: (action) => {
          // 「现在激活」直接把刚保存的那条规则的激活确认弹出来：保存与激活是两步。
          if (action === "activateNow") {
            const id = notices[scope]?.actionRule
            const rule = f.rules.find(item => item.id === id)
            if (rule !== undefined) askActivate(rule)
            return
          }
          runAction(action)
        },
        onDismiss: () => { clearNotice(scope) },
      })
      : null)

    const restartView = restart === null
      ? null
      : h(RestartBanner, {
        restart,
        notice: noticeFor("restart"),
        onCopy: () => { void copyRestart() },
        onToggleHow: () => { setRestart(prev => (prev === null ? prev : { ...prev, open: !prev.open })) },
        onDismiss: () => { setRestart(null); clearNotice("restart") },
      })

    const onTabKey = (event, index) => {
      let next = -1
      if (event.key === "ArrowRight") next = (index + 1) % TAB_KEYS.length
      else if (event.key === "ArrowLeft") next = (index - 1 + TAB_KEYS.length) % TAB_KEYS.length
      else if (event.key === "Home") next = 0
      else if (event.key === "End") next = TAB_KEYS.length - 1
      if (next < 0) return
      event.preventDefault()
      goTab(TAB_KEYS[next])
      const node = typeof document === "undefined" ? null : document.getElementById(`bkl-tab-${TAB_KEYS[next]}`)
      node?.focus?.()
    }

    const tabLabel = (key) => (key === "overview" ? T.tabOverview : key === "patches" ? T.tabPatches : key === "prompt" ? T.tabPrompt : key === "rules" ? T.tabRules : T.tabWords)

    let body
    if (status === null) {
      body = loadError === null
        ? h(Empty, { title: T.loading, body: T.loadingHint })
        : h(Notice, { notice: { ...loadError, action: "retry" }, onAction: runAction })
    } else if (tab === "overview") {
      body = h(OverviewPage, {
        f, status, override, busy, enabledPending, restart, restartView,
        loadedAt,
        step: nextStep(f, loadError),
        words: aliasStore.state,
        guideOpen,
        onToggleGuide: () => { setGuideOpen(prev => !prev) },
        nextNotice: noticeFor("next"),
        overviewNotice: noticeFor("overview"),
        onRun: runAction,
        onGo: goTab,
        onToggleEnabled: (next) => { void toggleEnabled(next) },
        onCopy: (text) => { void copy(text, "overview") },
        onOpenHelp: openHelp,
      })
    } else if (tab === "patches") {
      body = h(PatchesPage, {
        f, patchInfo, patchError, busy, toggles, restartView,
        noticeView: noticeFor("patches"),
        onToggle: (id, next) => { void togglePatch(id, next) },
        onApply: askApply,
        onRevert: askRevert,
        onRun: runAction,
        onCopy: (text) => { void copy(text, "patches") },
        onGo: goTab,
      })
    } else if (tab === "prompt") {
      body = h("div", { style: S.panel },
        h(PageHead, {
          page: "prompt",
          title: T.pagePromptTitle,
          desc: [
            T.promptHeadPrefix,
            h(Term, { termKey: "sharedPrompt" }),
            T.promptHeadSuffix,
          ] ?? T.pagePromptDesc,
          titleId: "bkl-page-prompt",
          when: T.whenNextTurn,
        }),
        restartView,
        h(ModeBlock, {
          mode: f.mode,
          pendingMode: dialog !== null && dialog.pick !== undefined ? dialog.pick : null,
          onPick: pickMode,
          noticeView: noticeFor("mode"),
        }),
        h(PromptBlock, {
          override, promptError, draft, setDraft: setPromptDraft, busy,
          onSave: savePrompt,
          onReset: askResetPrompt,
          onDiscard: askDiscardPrompt,
          onCopy: (text) => { void copy(text, "prompt") },
          onRetry: () => { void load() },
          noticeView: noticeFor("prompt"),
        }))
    } else if (tab === "rules") {
      body = h("div", { style: S.panel },
        h(PageHead, {
          page: "rules",
          title: T.pageRulesTitle,
          desc: [
            T.rulesHeadPrefix,
            h(Term, { termKey: "activate" }),
            T.rulesHeadMid,
            h(Term, { termKey: "instructions" }),
            T.rulesHeadSuffix,
          ] ?? T.pageRulesDesc,
          titleId: "bkl-page-rules",
          when: T.whenActivate,
        }),
        restartView,
        h(RulesBlock, {
          rules: f.rules,
          activeRule: f.activeRule,
          rulesIndex: f.rulesIndex,
          rulesIndexPath: f.rulesIndexPath,
          selectedId: selectedRuleId,
          body: ruleBody,
          edit: ruleEdit,
          busy,
          onNew: newRule,
          onOpen: openRule,
          onEdit: editRule,
          onEditChange: setRuleEdit,
          onSave: saveRule,
          onCancelEdit: cancelEdit,
          onActivate: askActivate,
          onDeactivate: askDeactivate,
          onDelete: askDelete,
          onRecover: () => { askRecoverRules("rules") },
          onRetryBody: () => { if (ruleBody.id !== null) loadRuleBody(ruleBody.id) },
          noticeView: noticeFor("rules"),
        }))
    } else {
      body = h(WordsPage, {
        store: aliasStore.state,
        query: wordsQuery,
        setQuery: setWordsQuery,
        previewText: wordsPreview,
        setPreviewText: setWordsPreview,
        restartView,
        noticeView: noticeFor("words"),
        onAdd: () => { openWordEditor(null) },
        onEdit: (index) => { openWordEditor(index) },
        onDelete: askDeleteWord,
        onRetryRead: retryAliasRead,
        onReturnChat: returnToChat,
        canReturn: wordsFromChat && closeSettings !== null,
      })
    }

    const dialogView = h(Dialog, {
      open: dialog !== null,
      idBase: "bkl-dialog",
      title: dialog?.title ?? "",
      tone: dialog?.tone === "danger" ? "error" : "accent",
      body: dialog?.body ?? null,
      foot: dialog?.foot ?? null,
      ack: dialog?.ack,
      confirmWord: dialog?.confirmWord,
      consequence: dialog?.consequence,
      yes: dialog?.yes,
      cancelText: dialog?.cancelText,
      busy,
      onAccept: accept,
      onClose: closeDialog,
    })

    const editorSpec = wordEditor === null
      ? null
      : WordEditor({
        editor: wordEditor,
        entries: aliasStore.state.entries,
        limits: aliasStore.state.limits,
        saving: wordSaving,
        error: wordSaveError,
        onField: setWordField,
        onSave: requestWordSave,
        onCancel: requestCloseWordEditor,
        onBack: backToWordEdit,
        onConfirmOverwrite: confirmWordOverwrite,
        onConfirmDiscard: () => { setWordEditor(null); setWordSaveError(null) },
      })

    // 弹窗常驻挂载、只切 open：关闭时焦点才能回到触发它的按钮，不会因卸载丢失。
    const wordDialogView = h(Dialog, {
      open: editorSpec !== null,
      idBase: "bkl-word-dialog",
      title: editorSpec?.title ?? "",
      tone: editorSpec?.tone === "error" ? "error" : "accent",
      body: editorSpec?.body ?? null,
      foot: editorSpec?.foot ?? [],
      onClose: requestCloseWordEditor,
    })

    // 播报区常驻（文本随 toast 变），视觉 toast 只在有文案时出现。
    const announcerView = h(Announcer, { key: "toast-announcer", text: toast ?? "" })
    const toastView = toast === null ? null : h(Toast, { key: "toast", text: toast })

    return h("div", { className: "bkl-root", style: S.root },
      h("header", { style: S.header },
        h("div", { style: S.brandMark, "aria-hidden": "true" }, h(Icon, { name: "bolt", size: 21 })),
        h("div", { style: S.headText },
          h("div", { style: S.titleRow },
            h("h2", { style: S.title }, T.title),
            h(Tag, null, PLUGIN_VERSION)),
          h("p", { style: S.lead }, T.lead)),
        h("div", { style: S.headAside },
          loadedAt > 0 ? h("span", { style: S.stamp, "aria-live": "off" }, T.refreshedAt(formatAgo(loadedAt))) : null,
          h(Button, { size: "small", off: busy, reason: T.whyBusy, onClick: () => { void load() } }, T.refresh),
          h(Button, { kind: "icon", label: T.helpLabel, onClick: openHelp }, h(Icon, { name: "help", size: 16 })),
          closeSettings === null
            ? null
            : h(Button, { kind: "icon", label: T.closeSettingsLabel, onClick: () => { closeSettings() } }, h(Icon, { name: "close", size: 16 })))),
      h("div", { id: "bkl-tablist", role: "tablist", "aria-label": T.tabsLabel, style: S.tablist },
        TAB_KEYS.map((key, index) => {
          const selected = tab === key
          const promptDirty = draft !== null && draft !== (typeof override?.text === "string" ? override.text : "")
          const rulesDirty = isRuleEditDirty(ruleEdit)
          // 页签错误徽章四态：规则清单损坏、词库读取失败/过期、补丁阻断/状态损坏、提示词读取失败。
          const tabError = (key === "rules" && f.rulesIndex === "corrupt")
            || (key === "words" && aliasReadError(aliasStore.state))
            || (key === "patches" && (f.blocked.length > 0 || f.broken))
            || (key === "prompt" && promptError !== null)
          return h("button", {
            key,
            id: `bkl-tab-${key}`,
            type: "button",
            role: "tab",
            className: "bkl-tab",
            "aria-selected": selected ? "true" : "false",
            "aria-controls": `bkl-panel-${key}`,
            tabIndex: selected ? 0 : -1,
            style: merge(S.tab, selected && S.tabOn),
            onClick: () => { goTab(key) },
            onKeyDown: (event) => { onTabKey(event, index) },
          },
            h(Icon, { name: TAB_ICON[key], size: 16 }),
            tabLabel(key),
            key === "patches" && f.pendingFiles > 0
              ? h("span", { title: T.tabPendingTitle(f.pendingFiles), style: S.tabCount }, String(f.pendingFiles))
              : null,
            tabError
              ? h("span", { style: S.tabTagWrap },
                h("span", { "aria-hidden": "true", style: S.tabBadge }, "!"),
                h("span", { style: S.srOnly }, T.tabErrorLabel))
              : null,
            (key === "prompt" && promptDirty) || (key === "rules" && rulesDirty)
              ? h("span", { style: S.tabTagWrap },
                h("span", { "aria-hidden": "true", style: merge(S.dot, { background: tk.warn }) }),
                h("span", { style: S.srOnly }, T.tabDirtyLabel))
              : null)
        })),
      h("div", { id: `bkl-panel-${tab}`, role: "tabpanel", "aria-labelledby": `bkl-tab-${tab}`, style: S.panel }, body),
      dialogView,
      wordDialogView,
      announcerView,
      toastView)
  }

  // ---- 目标词表：输入框上方的常驻行 -----------------------------------------
  //
  // 位置由宿主的 `conversation.composer.dock` 提供：输入框卡片下方、全局唯一，
  // 一轮对话只出现一次，不会随消息条数堆积。
  //
  // 这一行只负责「让人找到入口」和「编辑词表」。替换发生在宿主侧的 step 之前，
  // 与这里无关，所以改完必须新开会话才生效——这条写进了面板底部。

  const ALIAS = {
    // 跟输入框卡片同宽同位置：宿主给卡片的是
    // min(卡片宽 + 2×side-clearance, 100%) 居中，这一行照抄，否则会贴到聊天区最左边。
    root: {
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-start",
      width: "min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%)",
      margin: "0 auto",
      padding: "0 var(--dsh-composer-side-clearance)",
      boxSizing: "border-box",
      minHeight: 26,
    },
    // 实底 + 实边：颜色全部走 tk（宿主的真实令牌名），不手写变量名。
    // 之前写成 --dsw-alias-fill / --dsw-alias-label-2 这两个名字不存在，
    // 背景和边框一起失效，看起来就是透明的。
    row: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      margin: 0,
      padding: "0 10px",
      height: 24,
      border: `1px solid ${tk.line2}`,
      background: tk.layer1,
      textAlign: "left",
      font: "inherit",
      fontSize: 12,
      lineHeight: "22px",
      color: tk.label2,
      borderRadius: 6,
      cursor: "pointer",
      maxWidth: 200,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    // fixed + 视口坐标：祖先链上没有 transform，不会被 composer 的 overflow 裁掉。
    panel: {
      position: "fixed",
      zIndex: 60,
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      border: `1px solid ${tk.line2}`,
      borderRadius: 12,
      background: tk.layer1,
      color: tk.label,
      fontSize: 13,
      boxShadow: tk.shadowPop,
      overflow: "hidden",
    },
    titlebar: {
      flex: "none",
      display: "flex",
      alignItems: "center",
      gap: 8,
      height: 38,
      padding: "0 6px 0 12px",
      borderBottom: `1px solid ${tk.line1}`,
      background: tk.layer2,
      cursor: "move",
      touchAction: "none",
      userSelect: "none",
    },
    pill: {
      flex: "none",
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "2px 9px 2px 7px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: "nowrap",
    },
    pillDot: { width: 5, height: 5, borderRadius: "50%", flex: "none" },
    // 上下滚动阴影：前两层是随内容滚的表面渐隐遮罩（local），后两层是固定在
    // 视口边缘的阴影（scroll），四层叠出「有更多内容」的提示，对齐原型 dock-body。
    body: {
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      overscrollBehavior: "contain",
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 10,
      background: `linear-gradient(${tk.layer1} 30%, transparent) top / 100% 12px no-repeat local, linear-gradient(transparent, ${tk.layer1} 70%) bottom / 100% 12px no-repeat local, linear-gradient(color-mix(in srgb, ${tk.label} 8%, transparent), transparent) top / 100% 12px no-repeat scroll, linear-gradient(transparent, color-mix(in srgb, ${tk.label} 8%, transparent)) bottom / 100% 12px no-repeat scroll`,
      backgroundColor: tk.layer1,
    },
    grip: {
      flex: "none",
      height: 14,
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      paddingRight: 6,
      cursor: "nwse-resize",
      touchAction: "none",
      color: tk.label3,
      fontSize: 10,
      letterSpacing: 1,
      userSelect: "none",
      background: tk.well,
    },
    head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
    title: { margin: 0, fontSize: 13, fontWeight: 600, color: tk.label },
    subhead: { margin: 0, fontSize: 12, fontWeight: 600, color: tk.label },
    section: {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      paddingTop: 12,
      borderTop: `1px solid ${tk.line1}`,
    },
    sectionFirst: { paddingTop: 0, borderTop: "none" },
    modeGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
    modeCard: {
      display: "flex",
      flexDirection: "column",
      gap: 3,
      padding: "10px 12px",
      border: `1px solid ${tk.line2}`,
      borderRadius: 8,
      background: tk.layer1,
      font: "inherit",
      textAlign: "left",
      cursor: "pointer",
    },
    modeCardOn: {
      borderColor: tk.accent,
      background: tk.accentSoft,
      boxShadow: `0 0 0 1px ${tk.accent}`,
    },
    modeCardTitle: { margin: 0, fontSize: 13, fontWeight: 600, color: tk.label },
    modeCardSub: { margin: 0, fontSize: 11, color: tk.label3 },
    footer: {
      flex: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      padding: "8px 12px",
      borderTop: `1px solid ${tk.line1}`,
      background: tk.layer2,
    },
    warnBox: {
      padding: "6px 8px",
      background: tk.well,
      border: `1px solid ${tk.line2}`,
      borderRadius: 4,
      fontSize: 12,
      color: tk.label,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    },
    confirmBtn: {
      marginLeft: 8,
      padding: "2px 8px",
      borderRadius: 4,
      border: `1px solid ${tk.line2}`,
      background: tk.layer1,
      color: tk.label,
      cursor: "pointer",
    },
    close: {
      width: 24,
      height: 24,
      padding: 0,
      border: "none",
      borderRadius: 6,
      background: "transparent",
      font: "inherit",
      fontSize: 14,
      lineHeight: "24px",
      color: tk.label2,
      cursor: "pointer",
    },
    desc: { margin: 0, fontSize: 12, lineHeight: "16px", color: tk.label2 },
    list: {
      margin: 0,
      padding: 0,
      listStyle: "none",
      maxHeight: 220,
      overflowY: "auto",
      border: `1px solid ${tk.line1}`,
      borderRadius: 6,
    },
    item: { display: "flex", alignItems: "center", gap: 8, padding: "0 8px", minHeight: 32 },
    itemDivider: { borderTop: `1px solid ${tk.line1}` },
    pair: {
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: 13,
      color: tk.label,
    },
    arrow: { margin: "0 6px", color: tk.label2 },
    emptyItem: { padding: 10, fontSize: 12, color: tk.label2 },
    remove: {
      flexShrink: 0,
      padding: "0 6px",
      border: "none",
      borderRadius: 6,
      background: "transparent",
      font: "inherit",
      fontSize: 12,
      lineHeight: "24px",
      color: tk.label2,
      cursor: "pointer",
    },
    form: { display: "flex", gap: 8 },
    formStacked: { flexDirection: "column" },
    input: {
      flex: 1,
      minWidth: 0,
      boxSizing: "border-box",
      height: 30,
      padding: "0 8px",
      border: `1px solid ${tk.line2}`,
      borderRadius: 6,
      background: tk.well,
      font: "inherit",
      fontSize: 13,
      color: tk.label,
    },
    add: {
      flexShrink: 0,
      height: 30,
      padding: "0 14px",
      border: `1px solid ${tk.line2}`,
      borderRadius: 6,
      background: tk.layer1,
      font: "inherit",
      fontSize: 13,
      color: tk.label,
      cursor: "pointer",
    },
    addOff: { opacity: 0.5, cursor: "not-allowed" },
    foot: { margin: 0, fontSize: 12, color: tk.label2 },
    fail: { margin: 0, fontSize: 12, color: tk.error },
  }

  function AliasRow() {
    // 词库状态不在这里另存一份：与设置页共用 aliasStore，两处才不会拿旧列表互相覆盖。
    const [, bumpDock] = useState(0)
    const [tier, setTier] = useState("recommended")
    const [tierBusy, setTierBusy] = useState(false)
    const [tierFailed, setTierFailed] = useState(false)
    const [pendingTier, setPendingTier] = useState(null)
    const [open, setOpen] = useState(false)
    const [fromInput, setFromInput] = useState("")
    const [toInput, setToInput] = useState("")
    const [confirmFrom, setConfirmFrom] = useState(null)
    const [deletingIndex, setDeletingIndex] = useState(null)
    const [writeState, setWriteState] = useState(null)
    const [navHint, setNavHint] = useState(false)
    // 浮窗的位置和尺寸存本地：关掉再打开回到原处，不用每次重新摆。
    const [dockRect, setDockRect] = useState(() => readDockLayout().rect ?? defaultDockRect(viewportSize()))
    const rootRef = useRef(null)
    const panelRef = useRef(null)
    const aliveRef = useRef(true)

    const load = useCallback(async () => {
      const tierRes = await get("/tier").catch(() => null)
      if (!aliveRef.current) return
      if (typeof tierRes?.data?.tier === "string") setTier(tierRes.data.tier)
    }, [])

    const switchTier = async (next) => {
      if (next === tier || tierBusy) return
      setTierBusy(true)
      setTierFailed(false)
      try {
        const payload = await post("/tier", { tier: next })
        if (!aliveRef.current) return
        const applied = payload?.data?.tier
        if (typeof applied === "string") setTier(applied)
        // 让设置页重新拉一次状态：它那份 tierInfo 不跟着这里变。
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
          window.dispatchEvent(new CustomEvent(STATE_CHANGED_EVENT))
        }
      } catch {
        // 不做静默：档位没变，按钮还停在原来那档，用户得知道为什么点了没反应。
        if (aliveRef.current) setTierFailed(true)
      } finally {
        if (aliveRef.current) setTierBusy(false)
      }
    }

    // 浮窗贴着输入框，误触代价不小：`POST /tier` 不只换提示词，还会连带提交
    // 执行层预算（超时、输出上限、子代理深度）。所以和设置页一样先确认一次，
    // 两个入口的行为必须一致。
    const requestTier = (next) => {
      if (next === tier || tierBusy) return
      setPendingTier(next)
    }

    const confirmTier = () => {
      const target = pendingTier
      setPendingTier(null)
      if (target !== null) void switchTier(target)
    }

    useEffect(() => {
      aliveRef.current = true
      void load()
      void aliasStore.read()
      return () => { aliveRef.current = false }
    }, [load])

    useEffect(() => aliasStore.subscribe(() => { if (aliveRef.current) bumpDock(value => value + 1) }), [])

    useEffect(() => {
      if (open) {
        void load()
        void aliasStore.read()
      }
    }, [open, load])

    // 快速添加的输入也是草稿：页面卸载前拦一下。
    useEffect(() => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onBeforeUnload = (event) => {
        if (fromInput !== "" || toInput !== "") {
          event.preventDefault()
          event.returnValue = ""
        }
      }
      window.addEventListener("beforeunload", onBeforeUnload)
      return () => { window.removeEventListener("beforeunload", onBeforeUnload) }
    }, [fromInput, toInput])

    useEffect(() => {
      if (!open) return undefined
      const close = () => {
        setOpen(false)
        setConfirmFrom(null)
        setDeletingIndex(null)
        setPendingTier(null)
      }
      // 浮窗是 fixed，可能压在页面任何位置：判断「点了外面」要看它自己和触发按钮。
      const onPointerDown = (event) => {
        const target = event.target
        if (panelRef.current && typeof panelRef.current.contains === "function" && panelRef.current.contains(target)) return
        if (rootRef.current && typeof rootRef.current.contains === "function" && rootRef.current.contains(target)) return
        close()
      }
      // 捕获阶段拦 Esc：宿主也在这层监听它关设置面板，冒泡阶段拦不住。
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        event.preventDefault()
        close()
      }
      document.addEventListener("pointerdown", onPointerDown, true)
      window.addEventListener("keydown", onKeyDown, true)
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true)
        window.removeEventListener("keydown", onKeyDown, true)
      }
    }, [open])

    // 视口变小后浮窗可能越界：夹回来，并且只夹不存，用户下次打开仍按他摆的位置。
    useEffect(() => {
      const onResize = () => { setDockRect((current) => clampDockRect(current, viewportSize())) }
      window.addEventListener("resize", onResize)
      return () => { window.removeEventListener("resize", onResize) }
    }, [])

    // 拖动与缩放共用一个手势：按下时记起点，移动时算偏移，松手才写盘。
    const startGesture = (event, kind) => {
      if (event.button !== 0) return
      // 标题栏上的按钮不该带着窗口跑。
      if (kind === "move" && event.target && typeof event.target.closest === "function"
        && event.target.closest("button,input,select,a,textarea")) return
      event.preventDefault()
      const startX = event.clientX
      const startY = event.clientY
      const start = dockRect
      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX
        const dy = moveEvent.clientY - startY
        const next = kind === "move"
          ? { ...start, x: start.x + dx, y: start.y + dy }
          : { ...start, width: start.width + dx, height: start.height + dy }
        setDockRect(clampDockRect(next, viewportSize()))
      }
      const finish = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", finish)
        window.removeEventListener("pointercancel", finish)
        setDockRect((current) => { writeDockLayout({ version: 1, rect: current }); return current })
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", finish)
      window.addEventListener("pointercancel", finish)
    }

    const commitChange = async (change, onSuccess) => {
      setWriteState(null)
      // 写入走共享 store：按操作提交、整表写入、串行，两个挂载点共用一份最新列表。
      const result = await aliasStore.commit(change)
      if (!aliveRef.current) return
      if (!result.ok) {
        if (result.unknown) {
          // 超时/断网不等于后端没写：不宣布「未生效」，先重新读取核对。
          setWriteState({ tone: "warn", title: T.wordSaveUnknownTitle, next: T.wordSaveUnknownNext })
          void aliasStore.read()
        } else {
          setWriteState({ tone: "error", title: T.aliasSaveFailed, next: T.wordSaveFailedNext })
        }
        return
      }
      setWriteState({ tone: "ok", title: T.wordSaved, next: T.wordSavedNext })
      if (typeof onSuccess === "function") onSuccess()
      // 通知设置页重新拉状态：它那份概览与词库摘要需要跟着变。
      notifyStateChanged()
    }

    const from = fromInput.trim()
    const to = toInput.trim()
    const entries = aliasStore.state.entries
    const limits = aliasStore.state.limits || { maxEntries: WORDS_MAX, maxTerm: WORD_TERM_MAX }
    const isFull = entries.length >= limits.maxEntries
    const saving = aliasStore.state.saving
    const inputErrors = wordEntryErrors(fromInput, toInput, {
      originalFrom: null,
      entries,
      maxEntries: limits.maxEntries,
      maxTerm: limits.maxTerm,
    })
    const canAdd = !isFull && from !== "" && to !== "" && inputErrors.from === "" && inputErrors.to === "" && inputErrors.limit === "" && !saving
    // 浮窗被拖窄以后，三个控件横排会把输入框挤到看不见：改成竖排。
    const stacked = dockRect.width < 360

    const openSettings = () => {
      // 进设置分区的词库页；分区没挂载就只给指引，不假装已经跳过去。
      if (openWordsFromDock()) {
        setOpen(false)
        setNavHint(false)
      } else {
        setNavHint(true)
      }
    }

    const add = () => {
      if (!canAdd) return
      const entry = { from, to }
      // 新增撞原词要先确认覆盖；确认前不写入，输入保留。
      if (aliasChangeKind(aliasStore.state.entries, { type: "save", originalFrom: null, entry }) === "overwrite" && confirmFrom !== from) {
        setConfirmFrom(from)
        return
      }
      setConfirmFrom(null)
      void commitChange({ type: "save", originalFrom: null, entry }, () => {
        setFromInput("")
        setToInput("")
        setConfirmFrom(null)
      })
    }

    const removeAt = (index) => {
      const entry = entries[index]
      if (entry === undefined) return
      if (deletingIndex !== index) {
        setDeletingIndex(index)
        return
      }
      setDeletingIndex(null)
      void commitChange({ type: "delete", from: entry.from })
    }

    const onKeyDown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        add()
      }
    }

    const statusTone = () => {
      const state = aliasStore.state
      if (state.phase === "loading") return "idle"
      if (state.phase === "failed" || state.stale) return "error"
      if (state.entries.length === 0) return "idle"
      return state.lastHits === 0 ? "warn" : "ok"
    }

    const statusText = () => {
      const state = aliasStore.state
      if (state.phase === "loading") return T.aliasLoading
      // 读不到和「没有条目」是两件事：前者是请求没通，后者是真的没配。
      // 混成一个文案会让人以为词表空了，实际是接口没响应。
      if (state.phase === "failed" || state.stale) return T.aliasStateFailed
      if (state.entries.length === 0) return T.aliasStateEmpty
      if (state.lastHits === 0) return T.aliasStateMiss
      return T.aliasStateHit(state.entries.length)
    }
    // 状态只算一次：胶囊底色、圆点和文案必须指向同一个状态。
    const dockTone = statusTone()

    return h("div", { ref: rootRef, style: ALIAS.root },
      h("button", {
        type: "button",
        style: ALIAS.row,
        "aria-haspopup": "dialog",
        "aria-expanded": open ? "true" : "false",
        title: T.dockPopoverTitle,
        onClick: () => { setOpen((value) => !value); setPendingTier(null) },
      },
        h("span", { style: { fontWeight: 600, color: tk.label } }, T.breaklimitButton),
        h("span", { style: { color: tk.label2 } }, "·"),
        h("span", null, statusText())),
      open
        ? h("div", {
            ref: panelRef,
            role: "dialog",
            "aria-label": T.dockPopoverTitle,
            style: merge(ALIAS.panel, {
              left: `${dockRect.x}px`,
              top: `${dockRect.y}px`,
              width: `${dockRect.width}px`,
              height: `${dockRect.height}px`,
            }),
          },
            h("div", { className: "dock-titlebar", style: ALIAS.titlebar, onPointerDown: (event) => { startGesture(event, "move") } },
              h(Icon, { name: "bolt", size: 15, style: { color: tk.accent } }),
              h("span", { style: ALIAS.title }, T.dockPopoverTitle),
              h("span", {
                style: merge(ALIAS.pill, {
                  background: tier === "unrestricted" ? TONE_SOFT.warn : TONE_SOFT.info,
                  color: tier === "unrestricted" ? TONE_COLOR.warn : TONE_COLOR.info,
                }),
              }, tier === "unrestricted" ? T.modeUnrestrictedShort : T.modeRecommendedShort),
              // 状态胶囊自带圆点：一个元素表达一件事，不再和独立圆点重复。
              h("span", {
                style: merge(ALIAS.pill, {
                  background: TONE_SOFT[dockTone],
                  color: dockTone === "idle" ? tk.label2 : TONE_COLOR[dockTone],
                }),
              },
                h("span", { style: merge(ALIAS.pillDot, { background: dockTone === "idle" ? tk.line4 : TONE_COLOR[dockTone] }) }),
                statusText()),
              h("span", { style: { flex: 1, minWidth: 0 } }),
              h("button", {
                type: "button",
                style: ALIAS.close,
                "aria-label": T.aliasClose,
                onClick: () => { setOpen(false); setPendingTier(null) },
              }, h(Icon, { name: "close", size: 14 }))),
            h("div", { style: ALIAS.body },

            // 第一节：提示词模式快速切换。点一下只是选中待切换项，确认后才提交。
            h("div", { className: "dock-section", style: merge(ALIAS.section, ALIAS.sectionFirst) },
            h("h4", { style: ALIAS.subhead }, T.dockModeTitle),
            h("div", { style: ALIAS.modeGrid },
              h("button", {
                type: "button",
                style: tier === "recommended" ? merge(ALIAS.modeCard, ALIAS.modeCardOn) : ALIAS.modeCard,
                // 用 aria-disabled 而不是 disabled：项目里所有按钮都保留键盘焦点，
                // 真正挡住重复点击的是 switchTier 里的 tierBusy 判断。
                "aria-disabled": tierBusy ? "true" : undefined,
                "aria-pressed": tier === "recommended" ? "true" : "false",
                onClick: () => { requestTier("recommended") },
              },
                h("strong", { style: ALIAS.modeCardTitle }, T.modeRecommended),
                h("span", { style: ALIAS.modeCardSub }, T.modeRecommendedShort)),
              h("button", {
                type: "button",
                style: tier === "unrestricted" ? merge(ALIAS.modeCard, ALIAS.modeCardOn) : ALIAS.modeCard,
                "aria-disabled": tierBusy ? "true" : undefined,
                "aria-pressed": tier === "unrestricted" ? "true" : "false",
                onClick: () => { requestTier("unrestricted") },
              },
                h("strong", { style: ALIAS.modeCardTitle }, T.modeUnrestricted),
                h("span", { style: ALIAS.modeCardSub }, T.modeUnrestrictedShort))),
            h("p", { style: ALIAS.desc }, T.dockModeHint),
            pendingTier !== null
              ? h("div", { style: ALIAS.warnBox },
                  h("span", null, T.confirmModeTitle(modeLabel(pendingTier))),
                  h("button", { type: "button", style: ALIAS.confirmBtn, "aria-label": T.confirmModeYes, onClick: confirmTier }, T.confirmModeYes),
                  h("button", { type: "button", style: ALIAS.confirmBtn, "aria-label": T.cancel, onClick: () => { setPendingTier(null) } }, T.cancel))
              : null,
            pendingTier !== null ? h("p", { style: ALIAS.foot }, T.confirmModeBody) : null,
            tierFailed ? h("p", { style: ALIAS.fail }, T.dockTierFailed) : null),

            // 第二节：目标词表轻量管理
            h("div", { className: "dock-section", style: ALIAS.section },
            h("div", { style: ALIAS.head },
              h("h4", { style: ALIAS.subhead }, T.aliasTitle),
              h("button", {
                type: "button",
                style: merge(ALIAS.remove, { color: tk.accent, cursor: "pointer", padding: "0 4px" }),
                onClick: openSettings,
              }, T.dockManageAllWords)),
            h("p", { style: ALIAS.desc }, T.aliasDesc),
            h("ul", { style: ALIAS.list },
              entries.length === 0
                ? h("li", { style: ALIAS.emptyItem }, T.aliasEmptyList)
                : entries.slice(0, 3).map((entry, index) => h("li", {
                    key: `${String(index)}:${entry.from}`,
                    style: index === 0 ? ALIAS.item : merge(ALIAS.item, ALIAS.itemDivider),
                  },
                  h("span", { style: ALIAS.pair, title: `${entry.from} \u2192 ${entry.to}` },
                    `${entry.from} `,
                    h("span", { style: ALIAS.arrow }, "\u2192"),
                    ` ${entry.to}`),
                  h("button", {
                    type: "button",
                    style: deletingIndex === index ? merge(ALIAS.remove, { color: tk.error, fontWeight: 600 }) : ALIAS.remove,
                    title: deletingIndex === index ? T.confirmDeleteAlias(entry.from) : undefined,
                    onClick: () => { removeAt(index) },
                  }, deletingIndex === index ? T.aliasConfirmDelete : T.aliasRemove)))),
            entries.length > 3
              ? h("p", { style: ALIAS.foot }, T.dockAliasLimitHint(entries.length))
              : null,
            confirmFrom !== null
              ? h("div", { style: ALIAS.warnBox },
                  h("span", null, T.confirmOverwriteAlias(confirmFrom)),
                  h("button", { type: "button", style: ALIAS.confirmBtn, onClick: add }, T.save))
              : null,
            h("div", { style: stacked ? merge(ALIAS.form, ALIAS.formStacked) : ALIAS.form },
              h("input", {
                style: ALIAS.input,
                placeholder: T.aliasFrom,
                "aria-label": T.aliasFrom,
                value: fromInput,
                disabled: isFull ? true : undefined,
                onChange: (event) => { setFromInput(event.target.value); setConfirmFrom(null) },
                onKeyDown,
              }),
              h("input", {
                style: ALIAS.input,
                placeholder: T.aliasTo,
                "aria-label": T.aliasTo,
                value: toInput,
                disabled: isFull ? true : undefined,
                onChange: (event) => { setToInput(event.target.value) },
                onKeyDown,
              }),
              h("button", {
                type: "button",
                style: canAdd ? ALIAS.add : merge(ALIAS.add, ALIAS.addOff),
                disabled: canAdd ? undefined : true,
                "aria-disabled": canAdd ? undefined : "true",
                onClick: add,
              }, T.aliasAdd)),
            h("p", { style: ALIAS.desc }, T.dockAliasInlineDefault),
            writeState === null
              ? null
              : h("p", { style: writeState.tone === "ok" ? ALIAS.foot : ALIAS.fail }, `${String(writeState.title)}${T.sep}${String(writeState.next)}`),
            canAdd || (from === "" && to === "")
              ? null
              : h("p", { style: ALIAS.fail }, inputErrors.from || inputErrors.to || inputErrors.limit),
            navHint ? h("p", { style: ALIAS.foot }, T.wordsNavHint) : null)),
            // 页脚在滚动区之外：正文多长都压不到它。
            h("div", { className: "dock-footer", style: ALIAS.footer },
              h("p", { style: ALIAS.foot }, T.dockFooterHint),
              h("button", {
                type: "button",
                style: ALIAS.add,
                onClick: openSettings,
              }, T.dockOpenSettings)),
            // 右下角缩放：拖手柄只改尺寸，位置不动。
            h("div", { style: ALIAS.grip, onPointerDown: (event) => { startGesture(event, "resize") } }, "\u25E2"))
        : null)
  }

  function apply(ctx) {
    refreshText()
    // 浮窗要用宿主 slots 的能力（打开设置分区），在 apply 时收好入口。
    hostCtx = ctx
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: SECTION_ID,
      order: SECTION_ORDER,
      // 侧栏名称的取值早于 Section 挂载，这里同样先同步一次语言。
      label: () => { refreshText(); return T.nav },
    }, Section))

    // 挂在输入框卡片上方、聊天区下方的整行区，与底部统计行同属底部区域。
    // composer.dock 是单行 flex 且不换行，进去只能和统计字并排，做不出「独立一行」。
    // 容器给足高度：只挂一个 inline chip 时父级 flex 可能把它压成 0 高。
    ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
      name: "conversation.input.dock",
      id: "breaklimit-alias",
      order: 10,
      label: () => { refreshText(); return T.breaklimitButton },
    }, AliasRow))
  }

  exports.name = name
  exports.inject = inject
  exports.apply = apply
  // 这些纯函数/组件导出是为了让回归测试直接测真实实现：它们要么是不可逆操作前的
  // 判定（草稿脏判定、词条校验、覆盖/合并判定、保存后的草稿回收），要么是必须与
  // host/masks.js 语义一致的本地预览，要么是「读取失败禁止覆盖」这类渲染约束。
  exports.isRuleEditDirty = isRuleEditDirty
  exports.aliasReadError = aliasReadError
  exports.maskPreview = maskPreview
  exports.normalizeAliasEntries = normalizeAliasEntries
  exports.aliasNextEntries = aliasNextEntries
  exports.aliasChangeKind = aliasChangeKind
  exports.wordEntryErrors = wordEntryErrors
  exports.draftAfterSave = draftAfterSave
  exports.ruleSaveNotice = ruleSaveNotice
  exports.createAliasStore = createAliasStore
  exports.notifyStateChanged = notifyStateChanged
  exports.openWordsFromDock = openWordsFromDock
  exports.PromptBlock = PromptBlock
  exports.WordEditor = WordEditor
  exports.Dialog = Dialog
  exports.Toast = Toast
  exports.Announcer = Announcer
  exports.Tag = Tag
  exports.Button = Button
  exports.Icon = Icon
  exports.Term = Term
  exports.StateBlock = StateBlock
  exports.Notice = Notice
  exports.PageTip = PageTip
  exports.PageHead = PageHead
  // 浮窗布局：夹边、默认位置、读回脏数据的回落，都是可以脱离 DOM 断言的行为。
  exports.clampDockRect = clampDockRect
  exports.defaultDockRect = defaultDockRect
  exports.parseDockLayout = parseDockLayout
  // 浮窗整棵组件：只有真正渲染一次，才能发现「定义顺序/初始化顺序」这类单测到不了的问题。
  exports.AliasRow = AliasRow
  exports.flowSteps = flowSteps
  exports.deriveActionCard = deriveActionCard
  exports.formatDiagnostics = formatDiagnostics
  exports.OverviewPage = OverviewPage
  exports.PatchesPage = PatchesPage
  // 阶段四组件与规格导出
  exports.ModeBlock = ModeBlock
  exports.ModeCompare = ModeCompare
  exports.RulesBlock = RulesBlock
  exports.modeSwitchDialogSpec = modeSwitchDialogSpec
  exports.ruleDeleteDialogSpec = ruleDeleteDialogSpec
  exports.recoverRulesDialogSpec = recoverRulesDialogSpec
  // 阶段五收官组件导出
  exports.WordsPage = WordsPage
  exports.aliasStore = aliasStore
  return module.exports
}})
