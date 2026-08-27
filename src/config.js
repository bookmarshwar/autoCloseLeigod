'use strict';

/**
 * 配置加载: 默认值 → config.json(项目根目录) → CLI 参数(优先级最高)。
 *
 * 结构:
 * - 全局项(sdkExe/dryRun/debug/logFile)在顶层;
 * - 策略项都在 strategies 段, 每个策略独立 enabled:
 *   - strategy0 主流程: 轮询间隔/复查间隔/查询等待/进程上限/二次确认
 *   - strategy1 定时关闭: closeTimes
 *   - strategy2 键鼠检测: listenSeconds/deferMinutes
 * - 兼容: strategy0 未显式配置的参数会回退到顶层旧写法
 *   (pollIntervalSeconds 等曾在顶层, 新配置请写入 strategies.strategy0)。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

const GLOBAL_KEYS = ['sdkExe', 'dryRun', 'debug', 'logFile'];
const PARAM_KEYS = ['pollIntervalSeconds', 'checkIntervalMinutes', 'gameQuerySeconds', 'processMaxResults', 'notFoundConfirmSeconds'];

const DEFAULTS = {
  sdkExe: path.join(ROOT, 'sdk', 'leigod-sdk.exe'),  // 仓库内 exe(随仓库分发)
  dryRun: false,             // true 时「关闭」只预览不真正暂停
  debug: false,              // true=全量日志(每次 SDK 调用/轮询/探测明细); false=仅重要事件
  logFile: 'watchdog.log',   // 日志文件, 空串则不写文件
  strategies: {
    // 策略0: 主流程 —— 轮询时长状态 → 询问游戏 → 复查 → 进程检查 → 暂停时长
    strategy0: {
      enabled: true,              // 开关
      pollIntervalSeconds: 30,    // 轮询加速状态的间隔(秒)
      checkIntervalMinutes: 10,   // 识别到游戏后, 复查加速状态的间隔(分钟)
      gameQuerySeconds: 8,        // 每次 game 查询最长等待(秒)
      processMaxResults: 50,      // 进程搜索最大返回数
      notFoundConfirmSeconds: 0,  // 未找到游戏进程后二次确认等待(秒); 0 = 不确认直接关闭
    },
    // 策略1: 定时关闭 —— 到达 closeTimes(HH:MM 列表)且时长在计时中 → 暂停时长
    //         (pause 后雷神会自动停止加速游戏, 不使用 stop 接口)
    strategy1: { enabled: false, closeTimes: [] },
    // 策略2: 键鼠活动检测 —— 两种互斥模式, 参数各自归组, 不再并列冗余:
  //  attached(依附模式, 策略0 启用): 主流程「关闭」前探测键鼠, 有活动则延后
  //    - listenSeconds: 监听窗口(秒); deferMinutes: 延后再判断分钟数
  //  standalone(独立模式, 策略0 关闭): 自己按探测定时器守护时长
  //    - listenSeconds: 每次监听窗口(秒); probeIntervalSeconds: 探测间隔;
  //      idleMinutes: 连续空闲暂停阈值(分钟)
    strategy2: {
      enabled: false,
      attached: { listenSeconds: 3, deferMinutes: 10 },
      standalone: { listenSeconds: 3, idleMinutes: 15, probeIntervalSeconds: 30 },
    },
  },
};

const LEGACY_S2_KEYS = ['listenSeconds', 'deferMinutes', 'idleMinutes', 'probeIntervalSeconds'];

function parseArgs(argv) {
  const flags = {};
  const takesValue = {
    '--poll': 'pollIntervalSeconds',
    '--check-min': 'checkIntervalMinutes',
    '--game-seconds': 'gameQuerySeconds',
    '--max-ps': 'processMaxResults',
    '--idle-min': 'idleMinutes',
    '--probe': 'probeIntervalSeconds',
    '--sdk': 'sdkExe',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (takesValue[a] && argv[i + 1] != null) { flags[takesValue[a]] = argv[++i]; continue; }
    if (a === '--dry') flags.dryRun = true;
    else if (a === '--debug') flags.debug = true;
    else if (a === '--once') flags.once = true;
    else if (a === '--strategy0') flags.strategy0 = true;
    else if (a === '--strategy1') flags.strategy1 = true;
    else if (a === '--strategy2') flags.strategy2 = true;
    else if (a === '--no-log') flags.logFile = false;
  }
  return flags;
}

function loadConfig(argv = []) {
  const cfg = { ...DEFAULTS };
  // 策略对象重建副本, 避免共享 DEFAULTS 引用被变异
  cfg.strategies = {
    strategy0: { ...DEFAULTS.strategies.strategy0 },
    strategy1: { ...DEFAULTS.strategies.strategy1 },
    strategy2: {
      enabled: DEFAULTS.strategies.strategy2.enabled,
      attached: { ...DEFAULTS.strategies.strategy2.attached },
      standalone: { ...DEFAULTS.strategies.strategy2.standalone },
    },
  };

  const file = path.join(ROOT, 'config.json');
  let local = {};
  if (fs.existsSync(file)) {
    try {
      // 容错: 兼容带 UTF-8 BOM 的文件(如 PowerShell Set-Content -Encoding UTF8 产物)
      local = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    }
    catch (e) {
      console.error(`[配置] config.json 解析失败: ${e.message}`);
      process.exit(1);
    }
    for (const k of GLOBAL_KEYS) {
      if (local[k] === undefined || local[k] === null) continue;
      // M-3: config.json 里的相对路径统一相对项目根目录解析(与 CLI --sdk 一致),
      //       避免从其他目录启动时按 CWD 解析导致 sdkExe 找不到
      if (k === 'sdkExe') {
        cfg.sdkExe = path.isAbsolute(local.sdkExe) ? local.sdkExe : path.resolve(ROOT, local.sdkExe);
      } else {
        cfg[k] = local[k];
      }
    }
    if (local.logFile === '') cfg.logFile = null;
  }

  // 策略深度合并(递归): 只覆盖显式给出的字段, 子对象(如 attached/standalone)局部覆盖
  function deepAssign(dst, src) {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
        deepAssign(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
  }
  for (const key of Object.keys(DEFAULTS.strategies)) {
    const src = local.strategies && local.strategies[key];
    if (src && typeof src === 'object') deepAssign(cfg.strategies[key], src);
  }

  // 策略2 旧版扁平写法兼容: strategy2 直接挂 listenSeconds/deferMinutes/
  // idleMinutes/probeIntervalSeconds → 自动映射到 attached/standalone 子对象
  const s2Given = (local.strategies && typeof local.strategies.strategy2 === 'object') ? local.strategies.strategy2 : {};
  if (LEGACY_S2_KEYS.some((k) => s2Given[k] !== undefined)) {
    console.warn('[配置] strategy2 检测到旧版扁平参数, 已自动映射到 attached/standalone 子对象 (推荐迁移: 见 README「策略2」)');
    const at = cfg.strategies.strategy2.attached;
    const st = cfg.strategies.strategy2.standalone;
    const atGiven = (s2Given.attached && typeof s2Given.attached === 'object') ? s2Given.attached : {};
    const stGiven = (s2Given.standalone && typeof s2Given.standalone === 'object') ? s2Given.standalone : {};
    if (atGiven.listenSeconds === undefined && s2Given.listenSeconds !== undefined) at.listenSeconds = s2Given.listenSeconds;
    if (atGiven.deferMinutes === undefined && s2Given.deferMinutes !== undefined) at.deferMinutes = s2Given.deferMinutes;
    if (stGiven.listenSeconds === undefined && s2Given.listenSeconds !== undefined) st.listenSeconds = s2Given.listenSeconds;
    if (stGiven.idleMinutes === undefined && s2Given.idleMinutes !== undefined) st.idleMinutes = s2Given.idleMinutes;
    if (stGiven.probeIntervalSeconds === undefined && s2Given.probeIntervalSeconds !== undefined) st.probeIntervalSeconds = s2Given.probeIntervalSeconds;
  }
  for (const k of LEGACY_S2_KEYS) delete cfg.strategies.strategy2[k];  // 清理顶层残留

  // 兼容旧顶层写法: strategy0 未显式配置的参数回退到顶层旧字段
  const s0Given = (local.strategies && typeof local.strategies.strategy0 === 'object') ? local.strategies.strategy0 : {};
  for (const k of PARAM_KEYS) {
    if (!(k in s0Given) && local[k] !== undefined && local[k] !== null) {
      cfg.strategies.strategy0[k] = local[k];
    }
  }

  const flags = parseArgs(argv);
  if (flags.once) cfg.once = true;
  if (flags.dryRun) cfg.dryRun = true;
  if (flags.debug) cfg.debug = true;
  if (flags.strategy0) cfg.strategies.strategy0.enabled = true;
  if (flags.strategy1) cfg.strategies.strategy1.enabled = true;
  if (flags.strategy2) cfg.strategies.strategy2.enabled = true;
  if (flags.logFile === false) cfg.logFile = null;
  if (flags.sdkExe) cfg.sdkExe = path.resolve(ROOT, flags.sdkExe);
  for (const k of PARAM_KEYS) {
    if (flags[k] !== undefined) {
      const n = Number(flags[k]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`[配置] 参数 ${k}=${flags[k]} 无效`);
        process.exit(1);
      }
      cfg.strategies.strategy0[k] = n;
    }
  }
  if (flags.idleMinutes !== undefined) {
    const n = Number(flags.idleMinutes);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`[配置] 参数 idleMinutes=${flags.idleMinutes} 无效`);
      process.exit(1);
    }
    cfg.strategies.strategy2.standalone.idleMinutes = n;
  }
  if (flags.probeIntervalSeconds !== undefined) {
    const n = Number(flags.probeIntervalSeconds);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`[配置] 参数 probeIntervalSeconds=${flags.probeIntervalSeconds} 无效`);
      process.exit(1);
    }
    cfg.strategies.strategy2.standalone.probeIntervalSeconds = n;
  }

  // 回填顶层(兼容代码直接读 cfg.pollIntervalSeconds) + 兜底下限
  for (const k of PARAM_KEYS) {
    cfg[k] = cfg.strategies.strategy0[k];
  }
  if (cfg.pollIntervalSeconds < 5) { cfg.pollIntervalSeconds = 5; cfg.strategies.strategy0.pollIntervalSeconds = 5; }
  if (cfg.checkIntervalMinutes < 1) { cfg.checkIntervalMinutes = 1; cfg.strategies.strategy0.checkIntervalMinutes = 1; }
  if (cfg.gameQuerySeconds < 3) { cfg.gameQuerySeconds = 3; cfg.strategies.strategy0.gameQuerySeconds = 3; }
  if (cfg.notFoundConfirmSeconds < 0) { cfg.notFoundConfirmSeconds = 0; cfg.strategies.strategy0.notFoundConfirmSeconds = 0; }
  if (cfg.strategies.strategy2.attached.listenSeconds < 1) cfg.strategies.strategy2.attached.listenSeconds = 1;
  if (cfg.strategies.strategy2.attached.deferMinutes < 1) cfg.strategies.strategy2.attached.deferMinutes = 1;
  if (cfg.strategies.strategy2.standalone.listenSeconds < 1) cfg.strategies.strategy2.standalone.listenSeconds = 1;
  // 独立模式空闲阈值下限: 0.05 分钟≈3 秒, 仅用于小阈值快速实测, 正常使用建议整分钟
  if (cfg.strategies.strategy2.standalone.idleMinutes < 0.05) cfg.strategies.strategy2.standalone.idleMinutes = 0.05;
  if (cfg.strategies.strategy2.standalone.probeIntervalSeconds < 1) cfg.strategies.strategy2.standalone.probeIntervalSeconds = 1;

  // 策略1 closeTimes 规范化: "H:MM" → "HH:MM"(匹配用补零格式), 非法项忽略并警告
  if (Array.isArray(cfg.strategies.strategy1.closeTimes)) {
    const normalized = [];
    for (const t of cfg.strategies.strategy1.closeTimes) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
      if (m) {
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
          normalized.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
          continue;
        }
      }
      console.warn(`[配置] 策略1 closeTimes 含无效时间 "${t}", 已忽略 (格式应为 HH:MM, 如 "23:30")`);
    }
    cfg.strategies.strategy1.closeTimes = normalized;
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, ROOT };