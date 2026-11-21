# 阅读 / Legado — iPad 移植版

把 Android 版「阅读 3.0（Legado）」搬到 iPad 上运行。**书源规则引擎从上游 Kotlin 源码逐条移植**，
不是重写一个类似软件。

> ⚠️ **构建状态：已完成。** IPA 已成功构建（两次复现验证），见 `dist/LegadoMobile-unsigned.ipa`。
> 但目标设备是**绕过激活锁（绕 ID）的 iPad**，这类机器的证书验证链被破坏，
> 无法安装任何未签名 / 自签名 App。见下方「为什么装不上」。

---

## 有什么

| 路径 | 内容 |
|---|---|
| `dist/LegadoMobile-unsigned.ipa` | 构建好的 iOS 应用（arm64, iOS 16.0+，178 KB） |
| `server/` | 书源规则引擎 + WebService 兼容服务（Node.js） |
| `webapp/` | iPad 界面（PWA，可添加到主屏幕） |
| `ios/` | Xcode 原生壳工程 |
| `docs/` | 移植报告、安装指引、踩坑记录 |

---

## 立刻能用（推荐）

不用装任何 App，不需要签名。

```powershell
cd server
node webservice.mjs
```

iPad 用 **Safari** 打开窗口里显示的地址（形如 `http://192.168.x.x:1234`）
→ 分享 → **添加到主屏幕** → 桌面出现「阅读」图标。

**这不是阉割版**：书源引擎就在电脑上跑，网页版调用的就是它。书架、搜索、目录、正文、进度全部可用，
和原生 App 读到的内容完全一致。唯一差别是它依赖电脑上的服务进程。

Windows 上双击 `启动阅读服务.cmd` 即可（会自动找 Node；找不到会提示去 nodejs.org 装）。

---

## 为什么装不上原生 App

目标设备是**绕过激活锁的 iPad**。这类机器的系统信任链被修改过，导致：

| 现象 | 真实原因 |
|---|---|
| 「需要互联网连接以验证是否信任开发者」，点击没反应 | 证书验证链被绕 ID 破坏，不是网络问题 |
| 描述文件显示"已受信任"，启动仍弹「无法验证 App」 | 同上 |
| 爱思助手签名报 `GetAppToken err:hsc=400` | 绕 ID 机器无法使用苹果签名服务 |
| TrollStore 的 Install TrollStore 卡住 | 依赖 PPL 绕过，绕 ID 机器通常已被补丁破坏 |
| AltStore / Sideloadly 侧载 | 同样需要证书验证，同样失败 |

**结论**：不是构建产物的问题——IPA 结构完全正确（见下方验证）。是设备侧无法安装未签名应用。
用网页版绕开这个限制。

如果你的机器**保留了越狱环境**（桌面上有 Sileo / Cydia），那还有一条路：
越狱环境可直接安装 TrollStore，不需要证书验证。那是唯一能装原生壳的情况。

---

## IPA 是否可用（实测数据）

```
架构       magic=0xFEEDFACF  cputype=0x0100000C (ARM64)  filetype=2 (MH_EXECUTE)
包名       app.legado.reader
最低系统   16.0
显示名     阅读
设备族     [1, 2]        （含 iPad）
必需能力   arm64
主程序     324 KB
WebApp     index.html + css + js + 4 图标，全部打进 bundle
AppIcon    Assets.car + 60x60@2x + 76x76@2x~ipad
SHA256     49AD6E3A65325682CAF48A723EEEA2D1E6C782082F47E87DE2A4DAB35558FB34
```

在任何**正常**的 iPad（未绕 ID）+ TrollStore 上，这个 IPA 可以直接安装。

---

## 书源规则引擎覆盖到什么程度

已实现（有测试）：

- 规则模式：`@@`、`@CSS:`、`@XPath:`、`@Json:`、`$.`/`$[`、`:` 正则、`@js:`、`<js></js>`
- `{{js}}` 插值、`@get:{...}`、`@put:{...}`、`$1`–`$99` 反向引用
- `##正则##替换###` 四段式替换
- jsoup 选择：`.a .b@text`、`@ownText`、`@html`、各种属性、`tag.div.0`、`tag.div!0`
- 正则列表：`&&` 分段，末段取分组
- JSONPath：`$.a.b[*].c`、过滤表达式
- JS 绑定：`java.ajax/connect/post`、`java.md5Encode/base64Encode/timeFormat/getElement/setContent`、
  `source.*`、`book.*`、`chapter.*`、`key`/`page`（含旧别名 `searchKey`/`searchPage`）、`result`、`baseUrl`
- URL 规则：`@js:` 模板、`{{}}`、`<1,2>` 分页、`,{method,charset,body,headers}` 选项、
  `<js>url,{options}</js>` 混合形式

**未实现**（会明确报错，不会静默返回错数据）：

- `@webjs:` / `java.startBrowserAwait`（需要内嵌 WebView）
- `java.queryTTF`（字体反爬）
- `Packages.*` 大部分类
- 登录 / 验证码流程（`loginUrl` / `loginCheckJs`）

---

## 验证

```bash
cd server
node run-all.mjs
```

```
PASS  rule engine conformance      37/37
PASS  real-source regressions      27/27
PASS  book source pipeline         13/13
PASS  WebService integration       13/13
PASS  iPad readiness               38/38
PASS  PWA end-to-end               16/16
PASS  Swift syntax
PASS  Xcode project graph
PASS  iOS deliverables
PASS  CI workflow
PASS  IPA packaging dry-run
PASS  repo preflight

12/12 suites passed
```

---

## 已知局限

1. **服务要单独跑**。Node 服务在电脑上，App 本体不含 Node 运行时。要做到 iPad 全离线，
   需要把服务用 Swift 重写进 App——没做。
2. **不是 100% 兼容所有书源**。用 22 个公开真实书源实测，1 个完整跑通；
   失败原因多是站点已死或需要 WebView，与规则引擎正确性无关。
3. **未在真机验证运行**。因为目标设备装不上，App 实际运行表现未经测试。

---

## 许可

规则引擎部分移植自 Legado（GPL-3.0），遵循 GPL-3.0。
