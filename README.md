# PolyU 备忘录

给香港理工大学（PolyU）学生用的轻量工具：**截止日倒计时 + 随手记 + 学校邮件摘要**。
纯前端 PWA，数据存在本机，用你自己的私有 Gist 在 iPhone 和电脑之间同步，可以装到主屏幕离线用。

线上地址：<https://zhongyun1213-design.github.io/7e-storehouse/>

> 现在这一版是 v2：截止日、备忘、同步、安装、邮件摘要的展示层都已完成。
> 邮件摘要的抓取脚本在 `tools/polyu-digest.gs`，需要你按下面步骤在自己 Google 账号里跑一次。

## 能做什么

- **倒计时**：下一件事放大显示剩余天数；按月份分组，过期条目单独标红；支持缴费、校历、住宿、签证、学业、活动、实习、生活八类。
- **随手记**：独立备忘页，可置顶，可一键转成截止日。
- **邮件摘要**：每天 12:30 由 Apps Script 读 Gmail「学校」标签，规则筛出选课、缴费、实习、活动等信息，写进 Gist；App 里一键把邮件变成截止日或备忘。
- **多设备同步**：私有 Gist，自动拉取 + 合并，删除也有墓碑记录，不会一同步就复活。
- **离线**：Service Worker 缓存全部静态资源，断网也能开。
- **主题**：跟随系统，或手动浅色 / 深色。品牌色采样自 PolyU 官方 logo（Pantone 201C，`#9D2235`）。

## 本地运行

```powershell
cd D:\Apps\hk-campus-countdown
python -m http.server 4173
```

浏览器打开 <http://127.0.0.1:4173/>。或者直接双击 `启动.bat`。

> 必须用 http 打开，不要双击 `index.html`：PWA 和 Service Worker 在 `file://` 下不工作。

## 装到手机 / 桌面

- **电脑 Chrome / Edge**：地址栏右侧「安装」图标，或菜单 → 安装。
- **iPhone**：Safari 打开页面 → 分享 → 添加到主屏幕。
- iPhone 上的网页推送要等下一版；现在靠 App 内标红和「已过期」分组提醒。

## 多设备同步（GitHub 私有 Gist）

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token。
2. 只给 **Gists: Read and write** 权限，生成后复制。
3. 打开 App → 设置 → 同步，粘贴 token，Gist ID 留空，点「连接 / 新建」。
4. 成功后会创建一个私有 Gist（`polyu-memo.json` + `polyu-digest.json`），把显示的 Gist ID 抄下来。
5. 在另一台设备上填同一个 token + 同一个 Gist ID，点「连接 / 新建」。
6. **手机不想手打 token？** 在电脑上点「扫码导入到手机」，用手机相机或 Safari 扫这张码，token 和 Gist ID 会自动填好并开始同步。二维码等同密码，只在自己屏幕上看，3 分钟后自动收起。

同步规则：同一条记录取更新时间较新的版本；删除会写墓碑，避免旧设备把条目带回来。冲突窗口是「谁最后改谁赢」，适合单人双设备。

扫码导入的实现：配置被打包进 `#s=…` 的 base64url 载荷，手机打开链接后写进本机 `localStorage`，随即用 `history.replaceState` 把 hash 擦掉，不留痕在地址栏和浏览历史里；版本号不对、载荷坏掉都直接忽略，不会覆盖已有配置。

## 邮件摘要（可选）

整条链路不需要服务器，全部跑在你自己的账号里：

```
PolyU Outlook ──转发规则──▶ 你的 Gmail ──标签「学校」──▶ Apps Script（每天 12:30）
                                                              │
                                                     写入私有 Gist
                                                              │
                                                      App「邮件」页展示
```

### 1. Outlook 转发 + Gmail 标签

- 在 PolyU 的 Outlook 网页版：设置 → 邮件 → 转发，转发到你的 Gmail；或者建一条「发件人来自 polyu」的规则。
- 有的学校租户会禁止自动转发到校外，如果规则存不下来，就手动转发，或改用「邮件收件箱规则 + 定期导出」。
- Gmail：设置 → 过滤器和已屏蔽的地址 → 新建，收件人是你 / 来自 polyu → 应用标签「学校」。

### 2. 跑摘要脚本

1. 打开 <https://script.google.com> → 新建项目。
2. 把 `tools/polyu-digest.gs` 整份粘进去。
3. 改顶部 `CONFIG`：`GIST_ID`、`GITHUB_TOKEN`（同一个 token 即可）、`LABEL`（默认「学校」）。
4. 项目设置 → 时区选 **(GMT+08:00) 香港**。
5. 先运行 `testDigest`，看日志里有没有抓到邮件；再运行 `installTrigger`，之后每天 12:30 自动跑。
6. 回到 App 的「邮件」页点「刷新」。

常见问题：

- **抓不到**：确认邮件真的进了 Gmail、标签名和 `LABEL` 一致、在 `WINDOW_DAYS`（默认 2 天）内。
- **日期识别不准**：脚本只认常见的「2026年11月6日 / 11月6日 / 6 Nov 2026」写法，识别不到就不填，App 里会默认给三天后，自己改一下。
- **摘要不动**：看 Apps Script 的执行记录，多半是 token 没有 Gist 权限，或者 Gist ID 填错。

## 数据与隐私

- 截止日 / 备忘默认只存在浏览器 `localStorage`，不上传。
- 开启同步后，数据写入**你自己的私有 Gist**；token 也只存在本机浏览器。
- 邮件脚本只读 Gmail「学校」标签，摘要写进同一个 Gist；不经过任何第三方服务器，也不调用模型。
- 导出的 JSON 不含 token。

## 已知限制

- 日期没有内置校历，全部手填——校历每年变，写死反而会误导。
- iPhone 上没有后台推送（v1.1 再做 Web Push）。
- Gist 方案适合单人；多人共用会互相覆盖。
- 邮件摘要目前是规则 + 原文摘录，没有模型总结；要接模型可以在 `buildDigest` 里加一步。
- 摘要里的「建议日期」只是从正文里抓的第一个未来日期，一定要自己确认。

## 开发 / 测试

```powershell
node --test tools/sync.test.mjs   # 合并逻辑 + 扫码链接编解码单测（14 条）
node tools/e2e.mjs                # 真实 Chrome 端到端：增删改、备忘、邮件、主题、同步报错、离线缓存、移动/桌面布局
node tools/qr.test.mjs            # 扫码导入：生成二维码 → jsQR 独立解码 → 模拟手机冷启动导入 → 坏链接不污染配置
node tools/offline.mjs            # 切断网络后刷新，验证 Service Worker 离线可用
```

端到端测试需要先启动本地服务和带调试端口的 Chrome：

```powershell
python -m http.server 4173
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\polyu-chrome-profile" http://127.0.0.1:4173/
```

截图会写到 `shots/`。

## 结构

```
index.html            页面结构（三个标签页 + 四个弹窗）
styles.css            主题变量、布局、深浅色
app.js                状态、渲染、同步、通知
sync-core.js          纯函数合并逻辑（可单测）
sync-link.js          扫码导入链接的编解码（纯函数，可单测）
qrcode.js             二维码生成（Kazuhiko Arase, MIT）
sw.js                 离线缓存
manifest.webmanifest  PWA 清单
icons/                图标（SVG + 192/512/180 PNG）
tools/polyu-digest.gs 邮件摘要脚本（Apps Script）
tools/make_icons.py   重新生成图标
tools/e2e.mjs         端到端测试
tools/sync.test.mjs   单测
```

## 路线图

- v1.1：iPhone Web Push（装到主屏幕 + VAPID）、邮件摘要接模型、活动/实习收藏夹。
- v2：学期视图、截止日重复规则、PolyU 校历导入。
