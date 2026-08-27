# autoCloseLeigod — 雷神加速器「没人玩游戏就自动暂停时长」看门狗

调用 leigod-sdk 的编译产物 `sdk/leigod-sdk.exe`(已随本仓库分发)完成全部底层能力, 本仓库只实现**决策逻辑**, 零第三方依赖:

- 定时轮询加速状态;
- 加速时自动查询当前加速的游戏(**询问是否有加速游戏**);
- 识别到游戏后**停止轮询**, 启动**复查计时器(默认 10 分钟, 可配置)**;
- 计时到期再次查询: **没有游戏在加速 → 自动暂停时长**;
- 有游戏在加速 → **搜索游戏进程**: **进程不存在 → 暂停时长**; 进程存在 → 重新计时, 循环监控。

## 目录结构

- `src/` — 看门狗决策逻辑(零第三方依赖)
- `sdk/leigod-sdk.exe` — leigod-sdk 编译产物(单文件 exe, 免装 Node, 随仓库分发;
  首次运行自动生成同目录 `sdk/config.json` 绑定信息, 不入库)

## 工作流程

```
┌──────────────┐   time --acc(每 pollIntervalSeconds, 默认 30s)
│   轮询阶段     │────────────► 时长未在计时(state≠running) → 延后判断, 不做任何动作
└──────┬───────┘
       │ 计时中
       ▼
  game (询问是否有加速游戏; 不依赖 acc, acc 只作参考)
  ├─ 有游戏 → 停止轮询, 启动复查计时器(checkIntervalMinutes, 默认 10 分钟)
  └─ 无游戏 → 同样进入复查节奏: 复查间隔后再次检测(到时仍无游戏 → 自动暂停)
                │ 计时到期
                ▼
           time --acc (先判断时长状态)
           ├─ 时长未在计时 → 无需处理, 恢复轮询驻留
           └─ 计时中 → game (再次询问加速状态)
                ├─ 没有游戏在加速 ──► ⛔ 关闭: pause --force(暂停时长)
                ├─ 有游戏 → ps <关键字=exeName 优先, 否则游戏名> (搜索进程)
                │     ├─ 进程不存在 ──► ⛔ 关闭: pause --force(默认直接关闭)
                │     └─ 进程存在   ──► 重新计时, 循环监控
```

> 「关闭」= 调用 `leigod-sdk.exe pause --force` **暂停时长**(等效点击界面「暂停时长」,
> SDK 云端回放, 不修改雷神任何数据文件)。暂停后看门狗**继续驻留监听**(不退出),
> 下次开启加速会自动重新守护; 按 `Ctrl+C` 结束。本工具自身除 `watchdog.log` 外不写任何文件。

## 策略(config.json 的 `strategies` 段, 全部可配置, 可单独开关)

### 策略1: 定时关闭(定时暂停时长, 可选一并停止加速)

```json
"strategy1": { "enabled": true, "closeTimes": ["23:30", "01:00"], "stopAcceleration": true }
```

- 每天到达 `closeTimes`(HH:MM 列表)且**时长仍在计时** → 自动暂停时长;
  `stopAcceleration: true` 且正在加速时, 一并调用 `stop --force` 停止加速。
- 适合睡前/固定时间兜底, 防止挂机烧时长。
- 用 `--strategy1` 参数可临时开启(时间仍需在配置里给出)。

### 策略2: 键鼠活动检测(关闭前延后判断)

```json
"strategy2": { "enabled": true, "listenSeconds": 3, "deferMinutes": 10 }
```

- 看门狗即将执行「关闭」时, 用系统最后输入时间探测键鼠活动(监听窗口
  `listenSeconds` 秒, 窗口起点/终点各采样一次);
- **检测到键鼠活动 → 延后 `deferMinutes` 分钟再判断**(人还在电脑前, 可能是
  正在启动游戏/临时忙, 不急着暂停);
- 全程无活动才执行关闭。探测失败按「无活动」处理(不阻塞关闭)。
- 实现用 Win32 `GetLastInputInfo`, 纯查询无钩子、与雷神无关。
- 用 `--strategy2` 参数可临时开启。

## 使用

前提: `sdk/leigod-sdk.exe` 已随仓库提供, 首次使用会自动绑定雷神加速器位置
(也可手动: `sdk\leigod-sdk.exe bind --auto`)。

```bash
npm start                    # 常驻看门狗
node src/main.js --once      # 只跑一轮完整判断并退出(诊断用, 只读, 不暂停时长)
npm test                     # 冒烟测试(只读)
```

## 配置(config.json, 时间全部可配置)

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `sdkExe` | `sdk\leigod-sdk.exe` | SDK exe 路径(相对项目根目录) |
| `pollIntervalSeconds` | 30 | 轮询加速状态的间隔(秒) |
| `checkIntervalMinutes` | 10 | 识别到游戏后复查加速状态的间隔(分钟) |
| `gameQuerySeconds` | 8 | 每次 game 查询最长等待(秒) |
| `processMaxResults` | 50 | 进程搜索最大返回数 |
| `notFoundConfirmSeconds` | 0 | 未找到游戏进程后二次确认等待(秒); 默认关闭, 担心 ps 瞬时误判时再开启 |
| `dryRun` | false | true 时「关闭」只预览、不真正暂停时长 |
| `debug` | false | true 时打印每次 SDK 调用参数与返回的完整 JSON(排查用) |
| `logFile` | `watchdog.log` | 日志文件(空串则只输出控制台) |
| `strategies` | 见上方「策略」 | 策略1 定时关闭 / 策略2 键鼠检测延后, 可单独开关 |

没有 config.json 时使用默认值; 可 `copy config.example.json config.json`。

## CLI 参数(优先级高于 config.json)

```
--poll <秒>          轮询间隔           --check-min <分钟>    复查间隔
--game-seconds <秒>  game 查询等待      --sdk <路径>          SDK exe 路径
--max-ps <数量>      进程搜索上限        --dry                dry-run, 不真正暂停
--once               只跑一轮判断退出    --no-log             不写日志文件
--debug              打印所有 SDK 调用与返回 JSON
--strategy1          临时开启策略1(定时关闭, 时间取自 config.json)
--strategy2          临时开启策略2(键鼠活动检测延后)
```

## 已知局限

- **进程搜索**: 优先用 SDK 识别出的 exeName(如 `DyingLightGame.exe`);
  本地/盗版游戏常识别不到 exeName, 退化为**游戏名模糊匹配**(进程名/路径/窗口标题
  包含关键字)——可能误匹配修改器、汉化补丁等进程。请留意日志中实际匹配到的进程名
 , 有误判可在复查日志中发现。
- 时长状态为事件驱动推断; 若在其他设备/网页暂停过, 客户端下次操作前状态可能不准。
- **判断入口以时长状态为准**(`state` ≠ running 就延后判断): 暂停时长不会停止
  加速会话, 只看加速状态会在暂停后重复触发暂停。担心 ps 枚举瞬时异常导致
  误暂停时可设 `notFoundConfirmSeconds > 0` 开启「未找到进程」二次确认。