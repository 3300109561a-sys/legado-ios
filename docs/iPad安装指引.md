# 在 iPad 上运行「阅读」

两条路。**A 是今天就能用的**，B 需要先跑一次 GitHub Actions。

---

## A. 现在就能用（Safari 添加到主屏幕）

### 你现在这台机器上的实际地址

```
http://10.225.91.79:1234
```

（这个地址是脚本自动探测出来的。换网络、或者换了电脑，重新双击 `启动阅读服务.cmd` 会重新显示。）

### 操作步骤

**1. 在电脑上启动服务**

双击：

```
legado-ios\启动阅读服务.cmd
```

会弹出一个黑窗口，里面显示上面那个地址。**这个窗口要一直开着**，关掉就等于服务停了。

- 首次运行会自动从 APK 里带的内置数据初始化书源
- 如果 Windows 弹出防火墙提示，**必须点「允许访问」**，否则 iPad 连不上
  （我没法替你开，这台机器的防火墙策略被沙箱挡住了）

**2. 在 iPad 上打开**

1. iPad 先连**和电脑同一个 Wi-Fi**
2. 打开 **Safari**（必须是 Safari，Chrome 加不了主屏幕）
3. 地址栏输入 `http://10.225.91.79:1234` → 回车
4. 看到书架页面

**3. 加到主屏幕（变成 App 图标）**

1. 点 Safari 顶部/底部的 **分享** 按钮（方框带向上箭头）
2. 往下找 **「添加到主屏幕」**
3. 名字会默认填「阅读」，点 **添加**

回到桌面，会多一个 **「阅读」** 图标。以后点它就能全屏打开，跟 App 一样，没有地址栏。

**4. 导入你自己的书源**

App 里右上角 **⋮ → 导入书源 / 备份**：

- **选文件**：点「选择文件」，选你从原「阅读」App 导出的书源 `.json` / 备份文件
- **或者粘贴**：把书源 JSON 内容直接粘到文本框里
- **或者给链接**：粘贴一个书源订阅的 `http(s)` 地址

导入后会显示「解析 N 条」，回到书架就能搜书了。

### A 路线的限制（说清楚）

| | |
|---|---|
| 电脑必须开着 | 关了就没了，这是“电脑在当服务器”的必然结果 |
| 同一 Wi-Fi | 不在一个网络就连不上；也可以开电脑热点让 iPad 连 |
| 不是 App Store 应用 | 是网页 App，但装到主屏幕后体验接近原生 |

---

## B. 真 App 图标（TrollStore，不需要开发者账号）

**前提**：iPad 6（A10）跑 iOS 16.3.1 正好在 TrollStore 支持范围
（14.0b2 – 16.6.1，arm64 走 TrollInstallerX）。

### 第 1 步：让 GitHub 帮你编译出 IPA

这台电脑没有 macOS / Xcode，编不了 iOS。用 GitHub 的免费 macOS 机器：

1. 注册/登录 GitHub，新建一个仓库（Private 也可以）
2. 把 `legado-ios` 整个文件夹传上去（网页上传即可，`server/node_modules` 不用传）
3. 进仓库 → **Actions** 标签 → 左边选 **build-unsigned-ipa** → 右边 **Run workflow** → 绿色按钮
4. 等 5～10 分钟，跑完点进这次运行，最下面 **Artifacts** 里下载
   `LegadoMobile-unsigned-ipa`，解压得到 `LegadoMobile-unsigned.ipa`

> 第一次跑可能因为我无法在本地验证 Xcode 编译而失败。失败了把 **build-log**
> 那个 artifact 发我，我来修。

### 第 2 步：iPad 上装 TrollStore

1. 用 Sideloadly / AltStore + 免费 Apple ID 把 **TrollInstallerX.ipa** 侧载进 iPad
   （Windows 电脑就行，不需要 Mac）
2. iPad 设置 → 隐私与安全性 → **开发者模式** → 打开 → 重启 → 再确认
3. 设置 → 通用 → VPN与设备管理 → 信任那个描述文件
4. 打开 TrollInstallerX → **Install TrollStore** → 选一个 App 当持久化助手（一般选「提示」）

> 详细步骤见 <https://ios.cfw.guide/installing-trollstore-trollinstallerx/>

### 第 3 步：装我们的 IPA（关键一步别漏）

1. 打开 **TrollStore** → **Settings** 标签 → **Install ldid**
   **不做这步会报错 173**「The app is not signed with a fake CoreTrust certificate」
2. 把 `LegadoMobile-unsigned.ipa` 传到 iPad（隔空投送 / 微信传文件 / iCloud 都行）
3. 在文件 App 里点这个 IPA → 分享 → **用 TrollStore 打开**
   （或者先打开 TrollStore → 右上角 + → 选这个文件）
4. 桌面上出现「阅读」图标，永久有效，不会 7 天过期

### 第 4 步：让 App 连上服务

App 打开后点右上角设置，把服务地址填成：

```
http://10.225.91.79:1234
```

点「测试连接」看到绿色「可连接」就保存。

> 这一步仍然需要电脑上那个服务在跑。iOS 不允许 App 在后台常驻一个 Node 服务，
> 所以「完全不用电脑」需要把服务用 Swift 重写进 App，这部分我没做。

---

## 出问题了怎么排查

### iPad 打不开页面

先在**电脑**上确认服务是活的：

```powershell
curl.exe -sS --max-time 5 http://127.0.0.1:1234/api/health
```

- 报错 → 服务没起来，看那个黑窗口有没有报错
- 返回 `{"ok":true,...}` → 服务正常，问题在网络上，按下面查

然后按顺序查：

1. **防火墙**：Windows 安全中心 → 防火墙 → 允许应用通过防火墙 → 找到 `node.exe` 打勾
   （这是最常见的原因）
2. **同一网络**：iPad 的 Wi-Fi 和电脑是不是同一个路由器
3. **IP 变了**：重新双击 `启动阅读服务.cmd`，看新的地址
4. **电脑 IP 是 10.225.x.x**：这台机器目前在一个非常规网段，如果你家的路由器是
   `192.168.x.x`，说明现在这个地址可能不是你家网络。换到你家 Wi-Fi 后重跑启动脚本

### 能打开但搜不到书

书源本身的问题，不是安装问题：

1. 先进 **⋮ → 书源管理**，确认书源已经导入（列表里有东西）
2. 如果只有 APK 自带的「消消乐听书」，那个站基本已经不在了 —— **要导入你自己的书源**
3. 部分书源依赖内嵌浏览器渲染或字体反爬，这个移植版不支持，会报错说明原因

### 装 IPA 时报错 173

TrollStore 里没装 `ldid`。去 TrollStore → Settings → Install ldid，然后重装。

---

## 一句话总结

- **想立刻看到东西** → 双击 `启动阅读服务.cmd`,iPad Safari 打开 `http://10.225.91.79:1234`,添加到主屏幕
- **想要真 App 图标** → 先让 GitHub Actions 编出 IPA，再用 TrollStore 装（记得先装 ldid）
