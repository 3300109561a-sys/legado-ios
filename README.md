# 阅读 / Legado — iPad 移植版

把 Android 版「阅读 3.0（Legado）」搬到 iPad 6（A10）/ iPadOS 16.3.1 上运行的移植工程。

**它保留的东西**：应用名、书架、搜索、详情、目录、阅读、书源规则引擎、
书源 JSON 导入 / 导出、阅读进度保存。

---

## 先说清楚：这不是"重写一个类似软件"

| | 本工程 | 小浣熊 / YueduReader / Night-Reader |
|---|---|---|
| 书源规则引擎 | **从 Legado 的 Kotlin 源码逐条移植**（`AnalyzeRule.kt` / `AnalyzeByJSoup.kt` / `AnalyzeByRegex.kt` / `AnalyzeUrl.kt`） | 各自重写 |
| 界面 | iPad 原生观感（宋体正文、分栏、墨色进度轨） | 各自设计 |
| 书源 JSON | 原样导入，不改字段 | 兼容读取 |
| 来源 | 本工程由 APK 与上游源码直接推导 | 独立项目 |

规则引擎的每条语义都能指回 Kotlin 源码的具体行，并配了 37 条一致性测试。

---

## 本机验证结果（可复现）

```bash
cd server
node run-all.mjs
```

```
PASS  rule engine conformance      37/37 规则语义
PASS  real-source regressions      27/27 真实书源里出现过的写法
PASS  book source pipeline         13/13 搜索→详情→目录→正文
PASS  WebService integration       13/13 REST 契约 + 持久化
PASS  PWA end-to-end               16/16 真实 DOM 走完整流程
PASS  Swift syntax                 tree-sitter 解析无错
PASS  Xcode project graph          21 个对象、无悬空引用
PASS  iOS deliverables             Info.plist / 图标 / 资源一致
PASS  CI workflow                  YAML 合法、签名已关闭

9/9 suites passed
```

另有一个**可选的真实书源实测**（需要外网，结果随站点存活情况漂移）：

```bash
node test-real-sources.mjs <书源json> 诡秘之主
```

用公开书源集 `XIU2/Yuedu` 实测 22 个真实源的结论，见 `docs/移植报告.md` 第六之二节。
```

---

## 三条路线，按你的条件选

### A. 只想要"能用" — iPad Safari 加到主屏幕（0 工具链，今天就能用）

在这台 Windows 上跑服务，iPad 用 Safari 打开：

```powershell
cd legado-ios\server
node webservice.mjs          # 监听 0.0.0.0:1234
```

iPad 上：`http://<这台电脑的局域网 IP>:1234` → 分享 → **添加到主屏幕**。

- 得到的是可全屏运行、有图标、离线打开壳的独立图标
- 书源、正文、进度全部走这台电脑上的服务
- **代价**：电脑要开着；不是 App Store 那种应用
- 这就是 APK 里 `io.legado.app.service.WebService` 那条路的能力上限

### B. 想要真正的 App 图标 — TrollStore 装未签名 IPA

iPad 6 是 **A10（arm64）**，iOS **16.3.1** 落在 TrollStore 支持区间
（14.0b2–16.6.1，arm64 走 TrollInstallerX），**不需要开发者账号、不需要 Mac**。

1. GitHub 上开这个仓库 → Actions → `build-unsigned-ipa` → Run workflow
2. macOS runner 会产出 `LegadoMobile-unsigned.ipa`（已关闭代码签名）
3. iPad 先用 Apple ID 侧载 TrollInstallerX（需开发者模式 + 信任描述文件）
4. TrollStore 里先装 `ldid`（Settings → Install ldid）
5. 把 IPA 传到 iPad，用 TrollStore 打开 → 安装

应用启动后：设置里填入运行 `webservice.mjs` 的地址（默认 `http://127.0.0.1:1234`）。

### C. 有 Mac 或愿意买开发者账号 — 正常签名

```bash
xcodebuild -project ios/LegadoMobile.xcodeproj -scheme LegadoMobile \
  -destination 'generic/platform=iOS' build
```
用 Xcode 打开 `ios/LegadoMobile.xcodeproj` 也行，改 `PRODUCT_BUNDLE_IDENTIFIER` 后签名安装。

---

## 目录

```
legado-ios/
├─ server/            WebService 兼容服务 + 规则引擎 + 全部测试
│  ├─ lib/
│  │  ├─ analyzeRule.mjs   AnalyzeRule.kt 的移植（规则拆分 / 模式分发 / ## 替换）
│  │  ├─ analyzeUrl.mjs    AnalyzeUrl.kt 的移植（@js、{{}}、<1,2> 分页、JsonOption）
│  │  ├─ html.mjs          jsoup 语义子集（text/ownText/html/@attr/索引）
│  │  ├─ syncfetch.mjs     同步 HTTP（Worker + SharedArrayBuffer，供 java.ajax 用）
│  │  ├─ jsbridge.mjs      书源 JS 里的 java.* / source.* / book.* 绑定
│  │  └─ webBook.mjs       搜索 → 详情 → 目录 → 正文
│  └─ webservice.mjs       与 APK 自带 Web 服务同契约的 REST 服务
├─ webapp/            iPad 界面（PWA）
├─ ios/               Xcode 工程（WKWebView 原生壳）
├─ scripts/           工程生成与静态校验
└─ .github/workflows/ CI：构建未签名 IPA
```

---

## 书源规则引擎覆盖到什么程度

已实现（有测试）：

- 规则模式：`@@`（默认 CSS）、`@CSS:`、`@XPath:` 前缀、`@Json:`、`$.`/`$[`、`:` 正则、`@js:`、`<js></js>`
- `{{js}}` 插值、`@get:{...}`、`@put:{...}`、`$1`–`$99` 反向引用
- `##正则##替换###` 四段式替换（含 `###` 只替换首个匹配）
- jsoup 选择：`.a .b@text`、`@ownText`、`@html`、`@href` 等各种属性、`tag.div.0`、`tag.div!0`、`tag.div[0:1]`
- 正则列表：`&&` 分段，最后一段取分组
- JSONPath：`$.a.b[*].c`、`$..x`、过滤表达式
- JS 绑定：`java.ajax/connect/post`、`java.md5Encode/base64Encode/timeFormat/...`、`source.*`、`book.*`、`chapter.*`、`key`/`page`（含旧别名 `searchKey`/`searchPage`）、`result`、`baseUrl`

**没实现**（会在日志里失败，不会静默返回错误数据）：

- `@webjs:`（需要真实 WebView 渲染）
- `java.queryTTF`（字体混淆反爬）、`java.downloadFile`
- `Packages.*` 只暴露了极少数类
- 需要登录/验证码的书源（`loginUrl` / `loginCheckJs` 未接）

---

## 数据兼容

- 书源 JSON：直接吃 Legado 的 `BookSource` 字段，不改结构
- 导入入口同时接受：裸数组、`{"bookSources":[...]}`、备份文件外形、远程订阅链接
- 阅读进度：`/saveBookProgress` 同字段
- APK 内置数据已带在 `assets/`（`bookSources.json`、`rssSources.json`、`readConfig.json`、`themeConfig.json`）

---

## 许可

从 Legado（GPL-3.0）移植的规则引擎部分遵循 GPL-3.0。

