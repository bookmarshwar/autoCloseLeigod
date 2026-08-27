'use strict';

/**
 * 配置加载: 默认值 → config.json(项目根目录) → CLI 参数(优先级最高)。
 * 时间全部可配置: 轮询间隔 / 复查间隔(默认 10 分钟)/ 游戏查询等待。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  sdkExe: path.join(ROOT, 'sdk', 'leigod-sdk.exe'),  // 仓库内 exe(随仓库分发)
  pollIntervalSeconds: 30,   // 轮询加速状态的间隔(秒)
  checkIntervalMinutes: 10,  // 识别到游戏后, 复查加速状态的间隔(分钟)
  gameQuerySeconds: 8,       // 每次 game 查询最长等待(秒)
  processMaxResults: 50,     // 进程搜索最大返回数
  notFoundConfirmSeconds: 0,  // 未找到游戏进程后二次确认等待(秒); 默认 0 = 不确认直接关闭, 需要时再开启
  dryRun: false,             // true 时「关闭」只预览不真正暂停
  debug: false,              // true 时打印每次 SDK 调用参数与返回的完整 JSON
  logFile: 'watchdog.log',   // 日志文件, 空串则不写文件
  // 附加策略(全部可配置, enabled 控制开关):
  strategies: {
    // 策略0: 主流程 —— 轮询时长状态 → 询问游戏 → 复查 → 进程检查 → 暂停时长
    strategy0: { enabled: true },
    // 策略1: 定时关闭 —— 到达 closeTimes(HH:MM 列表)且时长在计时中 → 暂停时长
    //         (pause 后雷神会自动停止加速游戏, 不使用 stop 接口)
    strategy1: { enabled: false, closeTimes: [] },
    // 策略2: 键鼠活动检测 —— 执行「关闭」前用 GetLastInputInfo 监听键鼠
    //         (窗口 listenSeconds 秒); 检测到活动 → 延后 deferMinutes 分钟再判断
    strategy2: { enabled: false, listenSeconds: 3, deferMinutes: 10 },
  },
};

function parseArgs(argv) {
  const flags = {};
  const takesValue = {
    '--poll': 'pollIntervalSeconds',
    '--check-min': 'checkIntervalMinutes',
    '--game-seconds': 'gameQuerySeconds',
    '--max-ps': 'processMaxResults',
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
    else if (a === '--verbose') flags.verbose = true;
  }
  return flags;
}

function loadConfig(argv = []) {
  const cfg = { ...DEFAULTS };
  // 策略对象重建副本, 避免共享 DEFAULTS 引用被变异
  cfg.strategies = {
    strategy1: { ...DEFAULTS.strategies.strategy1 },
    strategy2: { ...DEFAULTS.strategies.strategy2 },
  };
  const file = path.join(ROOT, 'config.json');
  let local = {};
  if (fs.existsSync(file)) {
    try { local = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      console.error(`[配置] config.json 解析失败: ${e.message}`);
      process.exit(1);
    }
    for (const k of Object.keys(DEFAULTS)) {
      if (local[k] !== undefined && local[k] !== null) cfg[k] = local[k];
    }
    if (local.logFile === '') cfg.logFile = null;
  }

  const flags = parseArgs(argv);
  if (flags.once) cfg.once = true;
  if (flags.verbose) cfg.verbose = true;
  if (flags.dryRun) cfg.dryRun = true;
  if (flags.debug) cfg.debug = true;
  if (flags.strategy0) cfg.strategies.strategy0.enabled = true;
  if (flags.strategy1) cfg.strategies.strategy1.enabled = true;
  if (flags.strategy2) cfg.strategies.strategy2.enabled = true;
  if (flags.logFile === false) cfg.logFile = null;
  if (flags.sdkExe) cfg.sdkExe = path.resolve(ROOT, flags.sdkExe);
  for (const k of ['pollIntervalSeconds', 'checkIntervalMinutes', 'gameQuerySeconds', 'processMaxResults', 'notFoundConfirmSeconds']) {
    if (flags[k] !== undefined) {
      const n = Number(flags[k]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`[配置] 参数 ${k}=${flags[k]} 无效`);
        process.exit(1);
      }
      cfg[k] = n;
    }
  }

  // strategies 深度合并: 允许只写部分字段(在 DEFAULTS 拷贝之后覆盖)
  if (local.strategies && typeof local.strategies === 'object') {
    for (const key of Object.keys(DEFAULTS.strategies)) {
      const src = local.strategies[key];
      if (src && typeof src === 'object') {
        cfg.strategies[key] = { ...DEFAULTS.strategies[key], ...src };
      }
    }
  }

  // 兜底下限, 防止误配置造成高频/无效调用
  if (cfg.pollIntervalSeconds < 5) cfg.pollIntervalSeconds = 5;
  if (cfg.checkIntervalMinutes < 1) cfg.checkIntervalMinutes = 1;
  if (cfg.gameQuerySeconds < 3) cfg.gameQuerySeconds = 3;
  if (cfg.notFoundConfirmSeconds < 0) cfg.notFoundConfirmSeconds = 0;
  if (cfg.strategies.strategy2.listenSeconds < 1) cfg.strategies.strategy2.listenSeconds = 1;
  if (cfg.strategies.strategy2.deferMinutes < 1) cfg.strategies.strategy2.deferMinutes = 1;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, ROOT };