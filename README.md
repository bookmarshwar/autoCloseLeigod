# autoCloseLeigod — 雷神加速器「没人玩游戏就自动暂停时长」看门狗

调用 leigod-sdk 的编译产物 `sdk/leigod-sdk.exe`(已随本仓库分发)完成全部底层能力,
本仓库只实现**决策逻辑**, 零第三方依赖。

看门狗的全部行为都由**策略**组成, 每个策略可独立开关:

| 策略 | 作用 | 默认 |
|---|---|---|
| [策略0: 主流程](#策略0-主流程默认开) | 轮询时长 → 识别游戏 → 复查 → 进程检查 → 自动暂停 | 开 |
| [策略1: 定时关闭](#策略1-定时关闭) | 每天到点自动暂停时长 | 关 |
| [策略2: 键鼠检测](#策略2-键鼠活动检测关闭前延后判断) | 关闭前探测键鼠活动, 有活动则延后判断 | 关 |

## 目录结构

- `src/` — 看门狗决策逻辑(零第三方依赖)
- `sdk/leigod-sdk.exe` — leigod-sdk 编译产物(单文件 exe, 免装 Node, 随仓库分发;
  首次运行自动生成同目录 `sdk/config.json` 绑定信息, 不入库)

## 策略与工作流程(config.json 的 `strategies` 段, 各自独立开关)

### 策略0: 主流程(默认开)

配置(参数都在 `strategy0` 内):

```json
"strategy0": {
  "enabled": true,
  "pollIntervalSeconds": 30,
  "checkIntervalMinutes": 10,
  "gameQuerySeconds": 8,
  "processMaxResults": 50,
  "notFoundConfirmSeconds": 0
}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 主流程开关 |
| `pollIntervalSeconds` | 30 | 轮询加速状态的间隔(秒) |
| `checkIntervalMinutes` | 10 | 识别到游戏后复查加速状态的间隔(分钟) |
| `gameQuerySeconds` | 8 | 每次 game 查询最长等待(秒) |
| `processMaxResults` | 50 | 进程搜索最大返回数 |
| `notFoundConfirmSeconds` | 0 | 未找到进程后的二次确认等待(秒); 0 = 直接关闭 |

> 兼容: 旧配置若把以上参数写在顶层(`pollIntervalSeconds` 等), 仍会被读取
> (`strategy0` 内未显式配置的字段会回退到顶层旧写法)。

工作流程:

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

要点:

- 「关闭」= `pause --force` **暂停时长**(等效界面按钮, 云端回放, 不改雷神任何文件);
  暂停后雷神**会自动停止加速游戏**(无需 stop 接口)。
- 暂停后看门狗**继续驻留监听**(不退出), 下次开启加速会自动重新守护; 按 `Ctrl+C` 结束。
- 关闭本策略后: 不再轮询/守护/自动暂停; 策略1 可独立运行; 策略2 依附本策略的
  关闭判断, 本策略关闭时策略2 不生效(启动时会有提示)。
- **所有策略都关闭时看门狗直接退出**。
- `--strategy0` 参数可临时开启。

### 策略1: 定时关闭

配置:

```json
"strategy1": { "enabled": true, "closeTimes": ["23:30", "01:00"] }
```

工作流程:

```
每 30 秒检查当前时间(独立于轮询, 当天每个时间点只触发一次)
 ├─ 未到达 closeTimes 中的时间 → 继续等待
 └─ 到达 → 查询时长状态
      ├─ 未在计时 → 无需处理
      └─ 计时中 ──► ⛔ 关闭: pause --force(暂停时长; 雷神随后自动停止加速)
```

- 适合睡前/固定时间兜底, 防止挂机烧时长。
- **可脱离策略0 独立运行**(只开本策略时看门狗就是一台定时暂停器)。
- `--strategy1` 参数可临时开启(时间仍需在配置里给出)。

### 策略2: 键鼠活动检测(双模式)

配置:

```json
"strategy2": { "enabled": true, "listenSeconds": 3, "deferMinutes": 10, "idleMinutes": 15 }
```

**依附模式**(策略0 主流程启用时)——关闭前延后判断:

```
即将执行「关闭」时
 ├─ 探测系统最后键鼠输入(listenSeconds 秒窗口, 起点/终点各采样一次)
 │    ├─ 检测到键鼠活动 → 延后 deferMinutes 分钟再判断(人还在电脑前,
 │    │      可能是正在启动游戏/临时忙, 不急着暂停)
 │    └─ 无键鼠活动(或探测失败, 按无活动处理) → 继续关闭流程
```

**独立模式**(策略0 主流程关闭时)——自己按空闲探测守护:

```
每 pollIntervalSeconds 探测一次键鼠
 ├─ 检测到键鼠活动 → 重置空闲计时
 └─ 无键鼠活动 → 累计空闲时间
      └─ 连续空闲超过 idleMinutes 分钟 ──► ⛔ 关闭: pause --force
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 策略2 开关 |
| `listenSeconds` | 3 | 每次探测的监听窗口(秒) |
| `deferMinutes` | 10 | 依附模式: 检测到活动后延后再判断的分钟数 |
| `idleMinutes` | 15 | 独立模式: 连续无键鼠活动的暂停阈值(分钟) |

- 实现: Win32 `GetLastInputInfo`, **纯查询、无钩子/驱动**, 与雷神无关。
- 两种模式自动切换: 主流程(策略0)开→依附模式; 主流程关→独立模式(此时
  关掉策略2 且策略0/1 也关 → 看门狗退出)。
- `--strategy2` 参数可临时开启; `--idle-min <分钟>` 可临时调整独立模式阈值。

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
| `dryRun` | false | true 时「关闭」只预览、不真正暂停时长 |
| `debug` | false | true 时打印每次 SDK 调用参数与返回的完整 JSON(排查用) |
| `logFile` | `watchdog.log` | 日志文件(空串则只输出控制台) |
| `strategies` | 见上方「策略与工作流程」 | 策略0/1/2, 各自独立开关 |

> 策略参数(`pollIntervalSeconds` / `checkIntervalMinutes` / `gameQuerySeconds` /
> `processMaxResults` / `notFoundConfirmSeconds`)位于 `strategies.strategy0` 内,
> 见上方「策略0」小节; 顶层仅保留全局项。

没有 config.json 时使用默认值; 可 `copy config.example.json config.json`。

## CLI 参数(优先级高于 config.json)

```
--poll <秒>          策略0轮询间隔     --check-min <分钟>    策略0复查间隔
--game-seconds <秒>  策略0查询等待     --sdk <路径>          SDK exe 路径
--max-ps <数量>      策略0进程上限     --dry                dry-run, 不真正暂停
--idle-min <分钟>    策略2独立模式空闲阈值(默认 15)
--once               只跑一轮判断退出    --no-log             不写日志文件
--debug              打印所有 SDK 调用与返回 JSON
--strategy0          临时开启策略0(主流程, 默认开)
--strategy1          临时开启策略1(定时关闭, 时间取自 config.json)
--strategy2          临时开启策略2(键鼠活动检测延后)
```

## 已知局限

- **进程搜索**: 优先用 SDK 识别出的 exeName(如 `DyingLightGame.exe`);
  本地/盗版游戏常识别不到 exeName, 退化为**游戏名模糊匹配**(进程名/路径/窗口标题
  包含关键字)——可能误匹配修改器、汉化补丁等进程。请留意日志中实际匹配到的进程名,
  有误判可在复查日志中发现。
- 时长状态为事件驱动推断; 若在其他设备/网页暂停过, 客户端下次操作前状态可能不准。
- **判断入口以时长状态为准**(`state` ≠ running 就延后判断): 暂停时长不会停止
  加速会话, 只看加速状态会在暂停后重复触发暂停。担心 ps 枚举瞬时异常导致
  误暂停时可设 `notFoundConfirmSeconds > 0` 开启「未找到进程」二次确认。