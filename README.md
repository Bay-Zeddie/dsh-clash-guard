# dsh-clash-guard

Clash Verge 全域代理守卫 —— 三段式开关（全局 / 规则 / 关闭）+ 全链路加固 + 真实 IP 泄漏审计。

**目的**：渗透测试时开「全局」，保证这台电脑**所有**出站流量走代理，不暴露真实 IP。

**不依赖 Clash Verge 的 GUI**：内核由 Windows 服务守护，插件可独立启动/重启/控制它。详见下文「独立于 GUI」。

---

## 独立于 GUI（实测结论）

这个插件**不需要**你打开 `Clash Verge.lnk`。本机实测：

| 动作 | 结果 |
|---|---|
| 关掉 `clash-verge.exe`（GUI 窗口） | 内核 `verge-mihomo` 与命名管道**照常存活**，切模式/选节点/审计全部正常 |
| 杀掉内核进程 | 服务 5 秒内**自动拉起**（守护生效） |
| 停掉 `clash_verge_service` | 内核随之退出；插件可**直启**内核（见下） |
| 服务与内核全停 | 插件用 `spawn` + `desired-state.json` 里的参数直启，**1176ms** 恢复，`mode=global` 保持 |

### 为什么能独立

内核进程树是这样的（实测 `ParentProcessId`）：

```
clash_verge_service (Windows 服务, 开机自启)
  └─ verge-mihomo.exe  ← 真正的代理内核
clash-verge.exe (GUI)  ← 只是前端，不是内核的父进程
```

服务通过 `users/<owner>/desired-state.json` 的 `core_should_be_running` 决定该不该有内核，通过 `users/<owner>/runtime/config.yaml` 给内核喂配置。插件拿到的就是这两样东西。

### 三条独立路径

| 路径 | 触发条件 | 实现 |
|---|---|---|
| **服务路**（首选） | 服务在跑、内核没起 | 置 `core_should_be_running: true`，服务自己拉起 |
| **直启路** | 服务也停了 | 用 `core_path` + `config_path` + `core_ipc_path` 直接 `spawn` |
| **重启路** | 改了配置要重读 | `desired` 先 false 再 true，服务先停再起（实测 14s） |

面板上有「启动内核 / 重启内核」两个按钮，模型侧也能通过 `clash_status` 看到内核状态。

### 但有一件事无法绕过

**直启的内核拿不到 TUN 权限**（TUN 需要管理员建虚拟网卡）。实测直启后 `tun.enable = false`。

所以正确的做法是：插件先直启内核把控制器拉通，**切到全局时自动 `PATCH tun.enable=true` 补上**。这条链路已经实现并验证：直启 → 切全局 → `tun: true, strict: true`，10 步加固全绿。

如果你的 DSH 不是管理员身份跑，直启路径的 TUN 会失败并如实报 `needs elevation` —— 那时候打开一次 Clash Verge（让服务带权限拉起内核）是最省事的做法。

---

## 一个必须双写配置的坑（实测踩到）

切模式时**必须同时写两份文件**，否则内核重启后模式会回退：

| 文件 | 谁读它 | 只写它的后果 |
|---|---|---|
| `clash-verge.yaml`（应用配置） | GUI 打开时，用它重建 runtime | 内核被服务重启后 mode 回退 |
| `runtime/config.yaml`（服务运行配置） | **服务重启内核时直接读这份** | ← 这是真正的持久化位置 |

实测：只写前者 → 杀内核 → 恢复后 `mode` 从 `global` 变回 `rule`。双写之后 → 重启内核 → `mode` 保持 `global`。

插件的 `switchMode` 现在会遍历 `target.modeFile` + 所有 `target.runtimeDirs` 逐个写入，返回的 `persisted.writes` 里能看到每一份的结果。

### 附带发现的 CRLF 陷阱

Clash Verge 在 Windows 上写的是 **CRLF** 换行。`^key:\s*$` 这类正则里的 `$` 在 `\r\n` 之前匹配不到（行尾还剩一个 `\r`），于是所有块级 YAML 解析**静默返回空**——表现是「DNS 配置读不到」，审计误报 `dns-fakeip` / `dns-hijack` 失败。

修法：所有读 YAML 的地方统一 `.replace(/\r\n/g, '\n')`；写入时**保留原文件的换行风格**（`usesCrlf`），否则整份文件的换行会变，和备份/回滚对不上。

---

## 为什么需要它

Clash Verge 的「全局」只改内核的 `mode`，不碰系统层。实测本机开全局后仍有这些问题：

| 问题 | 后果 |
|---|---|
| `tun.strict-route: false` | 绑定物理网卡的应用（部分扫描器、SSH、老软件）直接绕过 TUN |
| 物理网卡 IPv6 未关 | AAAA 记录走原生 v6 出网，完全绕开代理 |
| WinINET 系统代理关闭 | 不吃 TUN 的应用直连 |
| DoH 自动升级开启 | Windows 把 DNS 升到 443，`dns-hijack: any:53` 拦不到 |
| 物理网卡 DNS 指向 ISP | DNS 查询泄漏真实网络 |
| 切模式时旧连接不断 | **切换前建立的连接仍用真实 IP**（实测 11/31 条走 DIRECT） |
| 关闭时只改 mode 不关 TUN | 「假关闭」——以为直连了，其实还在走 TUN |

这个插件把上面每一条都做成可判定、可验证、可撤销的动作。

---

## 安装

```powershell
# 1. 确认目录存在
Test-Path "C:\Users\53058\Desktop\工作\dsh-kit\plugins\local\dsh-clash-guard"

# 2. 装进 profile（link 方式，改源码即时生效）
cd "$env:USERPROFILE\.dsh\profiles\desktop"
# 在 package.json 的 dependencies 里加：
#   "dsh-clash-guard": "link:C:/Users/53058/Desktop/工作/dsh-kit/plugins/local/dsh-clash-guard"
# 在 dsh.profile.bundles 里加：
#   "dsh-clash-guard"

# 3. 装依赖
pnpm install

# 4. 重启 DSH
```

装好后：

- **侧边栏出现「代理守卫」一级入口**（排在「自动化任务」之后），点开是完整控制页
- **输入框左侧出现一个出口 IP 指示灯**：一个圆点 + 一行字，和「AI 控制电脑」同一套视觉
- 模型侧多出 5 个工具

**输入框旁的三段式小开关默认关闭**（`ui.enablePill = false`）：同一功能给两个入口会让人以为它们是两件事，而且输入框那一行本来就挤。切换模式请走侧边栏面板；那一行只留指示灯。

---

## 出口 IP 指示灯

放在 `conversation.input.left`，与「AI 控制电脑」同一个座位、同一套视觉规格（逐项对齐）。

### 它测的是整机，不是 DSH

这是关键区别。指示灯**不只看代理端口**，而是三条路径各测一次：

| 路径 | 怎么测 | 回答的问题 |
|---|---|---|
| **系统出口** | 走默认路由直连外部 | 用户平时上网（浏览器/微信/游戏）外面看到谁 |
| **代理出口** | 走混合端口（CONNECT 隧道） | 走代理的程序外面看到谁 |
| **绑卡出口** | `net.connect({localAddress: 物理网卡IP})` | **绑了网卡的程序会不会漏真 IP** |

第三条最尖锐：Windows 上绑源地址会强制走该网卡、**无视路由表**，所以它是「真 IP 有没有可能漏」的实证，而不是看开关脸色。

三条并发跑，总耗时 ≈ 最慢的那条（实测约 8 秒；绑卡路径用 3 秒短超时，因为它最容易被 TUN 拦死）。

### 五种结论

| 圆点 | 判定 | 文案 | 含义 |
|---|---|---|---|
| 🟢 绿 | 三条都 ≠ 真 IP 且绑卡被堵 | 已隐藏 | 理想状态 |
| 🟡 黄 | 绑卡能出网但 ≠ 真 IP | 可绕过 | 当前没漏，但这条路是活的 |
| 🔴 红 | **任一出口 = 真 IP** | 真 IP 暴露 | 至少一条路径直接用了真 IP |
| 🟡 黄 | 未校准 | 待校准 | 判不了，先校准 |
| ⚪ 灰 | 三条都不通 | 无出口 | 断网或全被拦 |

判定顺序是**先看暴露，再看能不能遮住**：

```
未校准 → 暴露 → 可绕过 → 已隐藏 → 无出口
```

### 点击即重测

点一下指示灯，圆点立刻开始呼吸（`dskg-pulse`）、文字变「检测中」，**不等网络回来**。悬停能看到三条路径各自的 IP 与校准真 IP。

### 视觉规格

| 项 | 值 |
|---|---|
| 高度 | 28px（与 composer 的 select 同高） |
| 字号 / 字重 | 13px / 500 |
| 行高 | 20px |
| 圆点 | 6px，`border-radius: 999px` |
| 间距 | 6px |
| 边框 / 底色 | 无 / 透明（**状态全靠圆点**） |
| 点亮光晕 | `0 0 0 3px` 同色 22% |
| 检测中 | 呼吸动画 1.1s，透明度 0.35 ↔ 1 |
| 减弱动效 | 动画关闭，改静态 70% |

### 它只显示，不切换

那个座位只有一行高，塞三段式按钮会把旁边的控件挤走。切换在侧边栏面板里，那是个整页，有空间把每种模式的后果写清楚。

---

## 入口机制（与官方一致）

侧边栏一级入口用官方那套双槽位，和「插件」「自动化任务」「Skill · MCP」「Agent 指令」完全同源：

| 槽位 | 作用 | 注册项 |
|---|---|---|
| `sidebar.panellist` | 侧边栏导航行（shell 拥有按钮本体与点击） | `id` / `order` / `label` + 图标组件 |
| `main` | keyed 页面槽位，按 `activePanelId` 渲染 | `key` 必须与上面的 `id` **完全一致** |

两个 id 不一致 = 点了没反应。这是最容易踩的坑，插件里两个 id 都从同一个 `defaults.ui.panelId` 派生。

注册带**重试**（`retryDelayMs` / `maxAttempts`）：父槽位晚于本插件激活时，`slots.inject` 的工厂会抛错，重试兜住这一段 boot 顺序竞争，绝不让面板缺失变成整个界面起不来。

---

## 前端样式：磨砂玻璃

配方与 `dsh-sunfragment-skin` **逐字对齐**，全站只有一个数值：

```css
/* 声明在 :root 与 body 两处 */
:root, body {
  --dskg-frost: var(--dsw-menu-backdrop-filter, blur(10px) saturate(160%) brightness(.82));
}
```

三条纪律：

1. **单一来源**：`--dskg-frost` 先读官方令牌 `--dsw-menu-backdrop-filter`。皮肤装了就跟皮肤走（皮肤会改写这个令牌），皮肤不在装时用同一份标定值兜底 —— 面板永远不自选磨砂力度。
2. **透明底 + 磨砂必须同时在场**：只清底不给糊，背后正文直接透上来（比实色板更糟）；只给糊不清底，是在实色上再糊一层。
3. **令牌声明在 `:root, body` 两处**：官方主题把令牌值作为 **inline style 写在 `document.body` 上**，写在 `:root`(html) 上的 `var()` 看不到 body 上的值，于是永远落兜底值。`body` 让皮肤的值真正生效，`:root` 兜住 body 出现之前的窗口。

布局参数照官方一级页面：

```css
.dskg {
  max-width: 960px;              /* 官方一级页面上限，来自 defaults.ui.maxContentWidth */
  margin: 0 auto;
  padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) clamp(24px, 4vw, 48px) 48px;
  height: 100%; min-height: 0;   /* 页面自己滚动，官方主列 overflow:hidden 从不代滚 */
  overflow-y: auto;
}
```

**输入框边框用 `border-l3`**（alpha .42）而不是 `l1`（.24）：皮肤把 `bg-layer-*` 全清成透明，输入框的可辨识度只能来自边框，`l1` 在 0.67px 渲染宽度下实测几乎看不见。

配色**零自选**：全部走 `--dsw-*` 令牌（`bg-layer-*` / `border-l*` / `label-*` / `state-*` / `interactive-*`），明暗主题自动跟随，没有任何硬编码 hex（唯一例外是选中态文字 `#fff`，那是压在品牌色实底上的对比色）。

---


## 三段式开关

| 档位 | 内核 mode | 加固动作 |
|---|---|---|
| **全局** | `global` | TUN 开 + 严格路由 + DNS fake-ip/hijack + **断开全部旧连接** + WinINET + WinHTTP + 关 DoH 自动升级 + 关物理网卡 IPv6 + DNS 指向 TUN 网关 |
| **规则** | `rule` | 同全局（加固不撤，只是分流规则生效） |
| **关闭** | `direct` | **关 TUN** + 断开连接 + 系统代理按基线恢复 + IPv6 按基线恢复 + DNS 按基线恢复 |

「关闭」不是「什么都不做」，是**按加固前记录的基线精确回滚**。原本关着的 IPv6 撤销后仍是关着的，原本 ISP 的 DNS 撤销后回到那台服务器。

---

## 五个模型工具

| 工具 | 作用 |
|---|---|
| `clash_status` | 一眼看全：模式、TUN、严格路由、选择器出口、活连接数、直连数 |
| `clash_mode` | 三段式切换（含加固/撤销），回读校验 |
| `clash_verify` | 15 项泄漏审计，裁决 `safe` / `leaking` / `unprotected` |
| `clash_nodes` | 列节点 + 换节点（拒绝 DIRECT/REJECT） |
| `clash_calibrate` | 在「关闭」态记录真 IP，之后每次审计断言出口 ≠ 真 IP |

典型渗透前流程：

```
clash_calibrate          # 关闭态，记录真 IP
clash_mode global        # 开全局 + 全链路加固
clash_verify             # 必须返回 safe，且 egress-vs-real 通过
clash_nodes pick=<节点>  # 需要时换出口地区
... 干活 ...
clash_mode off           # 收工，精确回滚
```

---

## 15 项泄漏审计

| id | 严重度 | 判据 |
|---|---|---|
| `mode` | critical | 内核 `mode=global` |
| `tun` | critical | TUN 开启 |
| `auto-route` | critical | TUN 自动路由 |
| `strict-route` | high | 严格路由（堵绑网卡应用） |
| `dns-fakeip` | critical | fake-ip 模式 |
| `dns-hijack` | critical | 劫持覆盖 `any:53` |
| `global-selector` | critical | 选择器出口不是 DIRECT/REJECT |
| `live-direct` | critical | global 下无直连活连接 |
| `egress` | critical | 代理出口可用 |
| `egress-vs-real` | critical | **出口 IP ≠ 校准的真 IP** |
| `system-proxy` | medium | WinINET 指向混合端口 |
| `winhttp` | low | WinHTTP 已设置 |
| `auto-doh` | high | DoH 自动升级已关 |
| `ipv6` | high | 物理网卡 IPv6 关断 |
| `dns-resolver` | medium | 物理网卡 DNS 指向 TUN |

裁决规则：`mode` 不是 global → `unprotected`；任一 critical/high 失败 → `leaking`；否则 `safe`。

---

## 铁律：零硬编码

**代码里不出现任何端口、管道名、secret、绝对路径、槽位名、工具名、文案、颜色。**

全部来自 `defaults.json`：

```jsonc
{
  "controller": { "pipeName": "", "secret": "", "requestTimeoutMs": 8000, "defaultHost": "127.0.0.1" },
  "ports": { "mixedPort": 0, "fallbackMixedPort": 0 },
  "discovery": {
    "pipePrefixes": ["verge-mihomo-", "mihomo-", "clash-"],
    "coreNames": ["verge-mihomo", "mihomo", "clash-meta", "clash"],
    "tunAdapterPatterns": ["mihomo", "clash", "meta", "tun", "wintun"]
  },
  "bypass": { "selectorGroup": "GLOBAL", "terminalNames": ["DIRECT", "REJECT"] },
  "tools": { "status": "clash_status", "mode": "clash_mode", ... },
  "ui": {
    "panelId": "dsh-clash-guard",     // sidebar.panellist 的 id = main 的 key
    "panelOrder": 24,
    "panelLabelZh": "代理守卫",
    "panelLabelEn": "Proxy Guard",
    "enableIndicator": true,          // 输入框左侧的出口 IP 指示灯
    "indicatorSlot": "conversation.input.left",
    "indicatorOrder": 25,
    "indicatorPollMs": 30000,         // 指示灯多久复查一次出口 IP
    "enablePill": false,              // 三段式小开关；默认关闭，侧边栏是唯一入口
    "maxContentWidth": 960,
    "retryDelayMs": 400,
    "maxAttempts": 8
  },
  "glass": {
    "token": "--dsw-menu-backdrop-filter",
    "fallback": "blur(10px) saturate(160%) brightness(.82)"
  }
}
```

三层覆盖：

1. `defaults.json`（包内，唯一事实来源）
2. `$DSH_HOME/dsh-clash-guard/settings.json`（用户在设置页写的）
3. 环境变量 `DSH_CLASH_GUARD_<PATH>`（`__` 分隔层级）

```powershell
$env:DSH_CLASH_GUARD_PORTS__MIXEDPORT = "7897"
$env:DSH_CLASH_GUARD_BYPASS__SELECTORGROUP = "GLOBAL"
$env:DSH_CLASH_GUARD_CONTROLLER__SECRET = "xxx"
```

每一层都按模板做类型校验：类型不符的覆盖被**丢弃**，不会把坏配置带进运行期。

### 运行时推导的东西

| 值 | 怎么来的 |
|---|---|
| 管道名 | 设置 → 内核进程命令行 `-ext-ctl-pipe` → 管道枚举 → 配置文件，**逐个探测 `/version`，能应答的才是真的** |
| secret | 设置 → 进程运行目录的 `config.yaml` → 应用配置 |
| 混合端口 | 设置 → 运行配置 `mixed-port` → 应用配置 → fallback |
| TUN 网关 | 读 TUN 网卡实际配置的 DNS（不假设 198.18.0.2） |
| 物理网卡 | 默认路由 + 排除 TUN/虚拟网卡（VMware/Hyper-V/loopback/蓝牙） |
| 系统基线 | 加固前实时采集，写进 `state.json` |

---

## 目录结构

```
dsh-clash-guard/
├─ package.json          # 插件清单，dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # bundle 层：把插件插进 profile
├─ defaults.json         # 唯一配置事实来源（零硬编码的载体）
├─ icon.svg
├─ locale/strings.json   # 中英文案（经 /i18n 路由取）
├─ lib/
│  ├─ index.js           # 宿主入口，apply() 永不抛
│  ├─ paths.js           # 路径推导
│  ├─ settings.js        # 三层配置装配 + 类型校验
│  ├─ discover.js        # 控制器发现（五级回退 + 实探）
│  ├─ mihomo.js          # 命名管道 / TCP 的 HTTP 客户端
│  ├─ snapshot.js        # API + 配置文件合并快照
│  ├─ windows.js         # 系统代理 / DNS / IPv6 / DoH
│  ├─ egress.js          # 出口 IP 探测（CONNECT+TLS，零依赖）
│  ├─ guard.js           # 加固 / 撤销 / 审计 / 切换 / 校准
│  ├─ http.js            # /dsh-clash-guard/* 同源路由
│  ├─ tools.js           # 5 个模型工具
│  └─ client.js          # 浏览器半：三段式开关 + 设置页
└─ tests/
   ├─ unit.test.mjs      # 纯函数（15 项）
   ├─ http.test.mjs      # 路由与 apply 健壮性（11 项）
   ├─ live.test.mjs      # 真实环境只读探测（12 段）
   ├─ apply.test.mjs     # 真实加固 + 撤销 + 复原验证
   └─ calibrate.test.mjs # 核心断言：全局出口 ≠ 真 IP
```

---

## 测试

```powershell
cd "C:\Users\53058\Desktop\工作\dsh-kit\plugins\local\dsh-clash-guard"

# 纯函数与路由（无需 Clash）
node --test tests/unit.test.mjs tests/http.test.mjs

# 真实环境只读（不改任何东西）
node tests/live.test.mjs

# 真实加固 + 撤销（会改系统代理/DNS/IPv6，结束自动复原）
node tests/apply.test.mjs

# 核心断言：真 IP 校准 → 开全局 → 出口 ≠ 真 IP
node tests/calibrate.test.mjs
```

实测结果（本机 v1.19.33）：

```
发现：4 个候选，命中 process:command-line（配置里那条是陈旧值）
真 IP：39.144.124.132
全局出口：103.62.49.138
审计：verdict=safe，15/15 通过
撤销：系统代理 / WinHTTP / IPv6 / DNS 全部回到基线
```

---

## 健壮性设计

| 场景 | 行为 |
|---|---|
| 控制器不可达 | 面板显示「不可达」+ 全部候选与探测轨迹，不报假成功 |
| 配置里管道名陈旧 | 逐个探测，用能应答的那个（本机实测就踩到了） |
| 缺 `@deepseek-ai/dsh-tools` | 动态导入失败 → 只丢工具，路由与面板照常 |
| 缺 `tools` 服务 | `ctx.inject` 抛错被捕获，插件照常加载 |
| 缺 `webServer` | 硬依赖，Loader 不会挂载；面板没有数据源 |
| 没有管理员权限 | 需要提权的步骤报 `needs elevation`，不假装成功 |
| 没有基线 | 撤销时保守处理（不动 IPv6），并说明原因 |
| `apply()` 抛任何错 | 全部捕获，只记日志 |
| 浏览器半 fetch 失败 | fail-open，开关渲染成「不可用」，不弄坏编辑器 |
| 主题切换 | 只用 `--dsw-*` 令牌，明暗都对 |

---

## 已知边界

1. **mihomo `GET /configs` 不返回 `dns` 段**，`tun` 段也没有 `strict-route`。插件读 API + 运行配置合并，每个字段标注来源（`api` / `file`）。
2. **`PATCH /configs` 不支持部分嵌套**：一次 PATCH 会整段替换，所以每次只发一个完整段。
3. **`external-controller` 为空时只能走命名管道**，普通 HTTP 客户端连不上。这是 Clash Verge 的默认，插件已适配。
4. **Windows 11 的 DoH 自动升级**是独立开关，关 TUN 不会自动恢复，插件按需处理。
5. **切换模式会断开所有连接**（`closeConnections: true`）。这是有意为之：旧连接绑着旧路由，不断就是泄漏。介意的话在设置里关掉。

---

## 一处真实的危险残留（顺带测到）

内核停掉后，**系统代理不会自动关闭**。实测：

```
内核已退出 → ProxyEnable=1 → ProxyServer=127.0.0.1:7897（没有进程监听）
→ Invoke-WebRequest 全部失败：整机断网
```

这是 Clash Verge 自身的行为（GUI 关掉时它没清系统代理）。插件的 `system-proxy` 审计项会在这种情况下报红，而「关闭」档位会把系统代理按基线恢复。

如果你遇到过「关掉 Clash 后上不了网」，就是这个原因；用本插件的「关闭」档位走一遍即可。

---

## 网络自愈：防「Clash 死了把网络带走」

这是本插件最重要的安全机制，来自两次真实事故：

**事故复盘（2026-11-18，两次）**

```
Clash 非正常退出（服务壳还在，内核死了）
   ↓
WLAN 的 DNS 还写着 198.18.0.2（TUN 网关）—— 那个地址已无人监听
   ↓
所有域名查询发往死地址 → 全部超时 → 整机断网
```

靠人记着「要正常退出 Clash」不管用（两次都复发），所以插件自己盯着：

| 机制 | 做什么 | 开关 |
|---|---|---|
| **体检** | 检出「DNS 指向隧道地址但内核已死」「系统代理指向死端口」「TUN 网卡孤儿」 | `GET /net` |
| **自愈** | DNS 重置为自动获取、关闭死代理（`POST /net`） | 面板「修复网络」按钮 |
| **守护** | 每 15 秒体检一次，命中自动修 | `selfheal.watchdog: true`（默认开） |

**防误报**：内核活着时，物理网卡 DNS 指向 `198.18.0.2` 是**正常状态**（TUN 网关），不报警。只有「隧道地址 + 内核已死」同时成立才算故障 —— 第一版少了这个条件，内核正常运行也报红，那种误报会让用户学会忽略告警。

**直启内核已默认禁止**（`core.allowDirectSpawn: false`）：2026-11-18 插件 `spawn` 的内核成了孤儿进程，Clash 之后启动时报 `refusing a second core` 拒绝起核，同时 DNS 已被改走 → 断网。**内核是服务的孩子，不能由插件收养**。

### 管道名漂移的自动对齐

真机踩到：desired-state 记 `…-production-…`，config.yaml 写 `…-sidecar-release-…`。内核读 config.yaml 起，只监听后者；插件若只信 desired-state 就永远连不上。现在**管道名以配置文件为准**，启动时发现漂移会自动把 desired-state 对齐回来。

---

## 绑卡直连的根治路线（研究结论，待实施）

sing-tun（mihomo 的 TUN 库）在 Windows 用 WFP 实现 strict-route。真机 WFP dump
验证了系统里有 9 条 `Meta` 规则 —— **唯独没有 v4 全局 BLOCK**（`tun_windows.go`
L250-262 被上游注释）。这就是「strict-route: true 但绑物理网卡仍能直连」的最终答案。

真正可行的 kill-switch 是 WireGuard-Windows 的设计（`blocker.go`）：同一 WFP
子层内 **PERMIT 权重高于 BLOCK 即可赢** —— permit mihomo(15) / permit DSH(15) /
loopback(13) / TUN+DHCP(12) / **blockAll(0)**。约 300 行 C# P/Invoke，DYNAMIC
会话进程退出规则自动消失。已验证 fwpuclnt.dll 可从用户态调。

---

### 信息节点过滤

机场的「剩余流量」「套餐到期」这类占位假节点没有出网能力，切到它等于断网。
`bypass.infoNodePatterns`（9 个匹配模式）在列表过滤与切换双重拦截，
实测 pick 信息节点返回明确错误。

## 泄漏检测：19 项，全部实测可判定

审计不读「开关脸色」，每条都是独立探针。

### 核心能力：判断真实 IP 是否暴露

| 检查项 | 判定方式 |
|---|---|
| `egress` | 走混合端口问外部，拿到节点出口 |
| `egress-vs-real` | **出口 IP === 校准的真 IP → 报红**（这是全插件存在的理由） |
| `interface-bypass` | 绑物理网卡能否真的连出去（不是看配置） |
| `default-routes` | 物理网卡与 TUN 的默认路由是否 metric 竞争 |
| `process-direct` | 按 `/connections` 的 `process` 字段点名谁在直连 |
| `system-resolver` | 系统解析实际拿到的是 fake-ip 还是真实地址 |
| `live-direct` | global 下有没有直连活连接 |

### 本轮研究挖出的三个硬事实

**① `PATCH /configs` 改不了 DNS。**

读 mihomo 源码（`hub/route/configs.go`）确认：`patchConfigs` 的 `configSchema`
**根本没有 `dns` 字段**，`getConfigs` 也不返回它。所以：

```
PATCH /configs {"dns":{...}}  →  HTTP 204（看起来成功）
再读 /configs                 →  没有 dns 字段
```

**值被静默丢弃**。修法：改运行配置文件 + `PUT /configs {"path":"","payload":"<整份yaml>"}` 整份重载，再用 `/dns/query` 回读验证模块存活。

**② `strict-route: true` 在 Windows 上不等于堵住旁路。**

真机实测：

| 手段 | 结果 |
|---|---|
| `tun.strict-route: true`（写配置+写文件） | ✘ 绑卡照样直连 |
| 抬高物理网卡默认路由 metric 到 9000 | ✘ 路由表变 `tun-wins`，绑卡仍直连 |
| 摘掉物理网卡默认网关 | ✘ 绑卡堵住了（`ENETUNREACH`），**但 mihomo 自己也断了** |
| Windows 防火墙封接口 + 放行 mihomo | ✘ Block 优先于 Allow，mihomo 一起断 |

根因：**Windows 的 `bind()` 到源 IP 会强制走该接口，无视路由表**；而 mihomo 连节点必须从物理网卡出去，两者共用同一个源地址，防火墙也无法按进程区分（Block 优先）。

所以插件把这条如实报红，而不是假装堵住了。`harden.blockInterfaceEgress` 默认关闭并标注后果。

**③ `GET /configs` 缺一半字段。**

`GetGeneral` 只返回 `Inbound` / `Mode` / `LogLevel` / `IPv6` 等，**不含 `dns`，`tun` 段也没有 `strict-route`**。所以审计必须「API + 配置文件」双读，每个字段标注来源（`api` / `file`）。

---

## 泄漏检测的实战价值

把系统切到 `mode=direct` 后跑审计，立刻抓出 9 项：

```
✘ mode               mode=direct
✘ tun                TUN 关闭
✘ global-selector    GLOBAL=DIRECT
✘ egress-vs-real     出口 39.144.124.132 == 真 IP —— 代理没生效
✘ system-resolver    系统解析得到真实地址，未走 fake-ip
✘ interface-bypass   绑物理网卡能连出去
...
```

其中 `egress-vs-real` 就是你要的核心判断：**出口 IP 等于本机真 IP = 正在暴露**。

---

### 后续可精进（按性价比排序）

1. **WFP kill-switch**（见上）—— 唯一能真正堵住绑卡直连的手段
2. **/connections WebSocket 订阅** —— mihomo 支持实时推送连接表，
   比指示灯 30s 轮询实时得多；需要 DSH 侧开 WebSocket 通道
3. ~~秘密管理~~ **已实施**：`controller-secret` 审计项（21 项之一）
4. **节点延迟排行** —— **已实施**：`GET /latency` 路由 + `clash_latency` 工具
   （借鉴 metacubexd / zashboard 的核心交互，mihomo /group/{name}/delay API）
5. **规则命中统计** —— **已实施**：`GET /rules-stats` 路由（3877 条规则里
   仅 19 条活跃，死规则占比是配置质量直接指标）

## License

MIT
