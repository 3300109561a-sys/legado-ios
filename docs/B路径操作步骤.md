# B 路径：装成真 App（TrollStore）

目标：iPad 6（A10）/ iPadOS 16.3.1 上装一个叫「阅读」的 App，**不需要 Apple 开发者账号，不需要 Mac**。

原理：GitHub 免费的 macOS 机器帮你编译出**未签名 IPA**，TrollStore 用系统级漏洞把它变成永久有效的 App。

---

## 第 0 步：本地预检（1 分钟，强烈建议）

推上去之前先在本机确认仓库结构没问题：

```powershell
cd D:\Documents\deepseek-harness\default-workspace\legado-ios
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe" scripts\preflight.mjs
```

要看到 `22/22 preflight checks passed`。这一步能挡住：文件缺失、`webapp` 没同步、
`.gitignore` 把构建需要的东西排除了、workflow 里有占位符。

---

## 第 1 步：把代码传到 GitHub

1. 打开 <https://github.com/new>，建一个仓库（Private 也可以），**不要**勾选任何模板
2. 在这台电脑上执行（把 `你的用户名/仓库名` 换成实际值）：

```powershell
cd D:\Documents\deepseek-harness\default-workspace\legado-ios
git init
git add .
git commit -m "Legado iOS shell"
git branch -M main
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

> **注意**：这台机器的 PowerShell 用 HTTPS 连 GitHub 会失败
> （`schannel: SEC_E_NO_CREDENTIALS`，沙箱令牌被降权）。
> 所以 `git push` 大概率失败。三个替代办法：
> 1. **在你自己的电脑上**执行上面这段（把整个 `legado-ios` 文件夹拷过去）
> 2. 用 **GitHub Desktop** 图形客户端
> 3. 在 GitHub 网页上直接拖文件夹上传（Drag & drop），跳过 git
>
> 仓库大小只有约 0.5 MB，网页上传很快。

---

## 第 2 步：跑 GitHub Actions 编译

1. 进仓库 → 顶部 **Actions** 标签
2. 左边列表点 **build-unsigned-ipa**
3. 右边 **Run workflow** → 绿色 **Run workflow** 按钮
4. 等 5～10 分钟（首次建 runner 会慢一点）

跑完点进这次运行，页面最下方 **Artifacts** 区：

| Artifact | 内容 |
|---|---|
| **LegadoMobile-unsigned-ipa** | 就是这个，下载解压得到 `LegadoMobile-unsigned.ipa` |
| LegadoMobile-app-bundle | 原始 `.app`（打包失败时有用） |
| build-log | 完整 `xcodebuild` 日志（失败时必看） |

**如果失败**：下载 `build-log`，在里面搜 `error:`，把那几行贴出来。

---

## 第 3 步：iPad 上装 TrollStore

TrollStore 支持 **14.0b2 – 16.6.1 / arm64**，你的 iPad 6（A10 = arm64）跑 16.3.1 正好在范围内。

### 3.1 侧载 TrollInstallerX

需要一个 Apple ID（免费的就行）+ Windows 电脑。

1. 电脑装 [Sideloadly](https://sideloadly.io/)（Windows 版，需要 iTunes 和 iCloud）
2. 下载 `TrollInstallerX.ipa`：
   <https://github.com/alfiecg24/TrollInstallerX/releases>
3. iPad 用数据线连电脑 → Sideloadly 里把 IPA 拖进去 → 填 Apple ID → Start
4. iPad 上：设置 → 通用 → VPN与设备管理 → 信任你的 Apple ID 描述文件

### 3.2 打开开发者模式

1. iPad 设置 → 隐私与安全性 → **开发者模式** → 打开
2. 重启 iPad
3. 重启后解锁，会弹「打开开发者模式？」→ 点 **打开** → 输密码

> 如果设置里没有「开发者模式」这一项：先把 TrollInstallerX 装上去，
> 点一下它的图标（会弹「需要打开开发者模式」），再去设置里就有了。

### 3.3 装 TrollStore

1. 打开 **TrollInstallerX**
2. 点 **Install TrollStore**
3. 提示选一个持久化助手 App → 选「**提示**」(Tips)
4. 完成后桌面上有 TrollStore 图标

---

## 第 4 步：装我们的 IPA（关键——别漏 ldid）

### 4.1 先装 ldid

1. 打开 **TrollStore**
2. 底部 **Settings** 标签
3. 找 **Install ldid** → 点它，等完成

> ⚠️ **漏了这步会报错**：
> `The app is not signed with a fake CoreTrust certificate and ldid is not installed. (error 173)`

### 4.2 装 App

把 `LegadoMobile-unsigned.ipa` 传到 iPad（隔空投送 / 微信文件传输 / iCloud 云盘都行），然后：

- **方法一**：在「文件」App 里点这个 IPA → 分享 → **用 TrollStore 打开**
- **方法二**：打开 TrollStore → 右上角 **+** → 选这个文件

桌面上出现 **「阅读」** 图标。永久有效，不会 7 天过期。

---

## 第 5 步：让 App 连上书源服务

App 自己不含书源引擎（那是 Node 服务），所以需要电脑跑服务：

1. 电脑上双击 `启动阅读服务.cmd`，记住窗口里显示的地址（比如 `http://10.225.91.79:1234`）
2. iPad 打开「阅读」→ 首次会**自动弹出设置面板**
3. 输入这个地址（**只输 `10.225.91.79:1234` 也行**，会自动补 `http://`）
4. 点 **测试连接** → 看到绿色「可连接」→ **保存**

现在书架、搜索、阅读都能用了。

> 想改地址：点 App 右上角的齿轮图标。

---

## 排错

### Actions 构建失败

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `No scheme named LegadoMobile` | scheme 文件没传上去 | 确认 `ios/LegadoMobile.xcodeproj/xcshareddata/xcschemes/` 在仓库里 |
| `error: cannot find 'XXX' in scope` | Swift API 用错 | 把报错行贴出来，我来改 |
| `Info.plist ... does not exist` | 路径不对 | 本地跑 `preflight.mjs` 应能提前发现 |
| `Code signing is required` | 签名没关掉 | 确认 workflow 里 `CODE_SIGNING_ALLOWED=NO` 还在 |

### TrollStore 装不上

| 报错 | 原因 |
|---|---|
| **error 173** | 没装 ldid → TrollStore → Settings → Install ldid |
| 图标灰掉 / 打不开 | 架构不对。本工程是 arm64，iPad 6 正好是 arm64 |
| 装完闪退 | 看 App 设置里服务地址是否填对；地址错只会显示"未配置"，不会闪退 |

### App 里书架一直是空的

App 用 `legado://local/` 自定义协议加载界面，所有 API 请求会被转发到你设置的服务地址。所以：

1. 确认电脑上的 `启动阅读服务.cmd` 还开着
2. 确认 iPad 和电脑在同一 Wi-Fi
3. App 里点齿轮 → 测试连接，必须是「可连接」
4. 电脑防火墙要放行 `node.exe`（Windows 会弹框，点允许）

---

## 这套东西的能力边界

| 能做 | 不能做 |
|---|---|
| 书架 / 搜索 / 详情 / 目录 / 正文 | 完全脱离电脑（服务在电脑上） |
| 导入你自己的 Legado 书源 JSON | 依赖内嵌浏览器的书源（`java.startBrowserAwait`） |
| 阅读进度保存 | 字体反爬书源（`java.queryTTF`） |
| 深色模式、全屏、横竖屏 | 需要登录/验证码的书源 |

**要做得更多**，下一步是把 `server/` 那套用 Swift 重写进 App —— 那才是真正「只带 iPad」的形态。
现在的形态是「App 外壳 + 电脑上的引擎」。
