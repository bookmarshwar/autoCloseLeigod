'use strict';

/**
 * 配置加载: 默认值 → config.json(项目根目录) → CLI 参数(优先级最高)。
 * 时间全部可配置: 轮询间隔 / 复查间隔(默认 10 分钟)/ 游戏查询等待。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  sdkExe: path.join(ROOT, '..', 'leigod-sdk', 'build', 'leigod-sdk.exe'),
  pollIntervalSeconds: 30,   // 轮询加速状态的间隔(秒)
  checkIntervalMinutes: 10,  // 识别到游戏后, 复查加速状态的间隔(分钟)
  gameQuerySeconds: 8,       // 每次 game 查询最长等待(秒)
  processMaxResults: 50,     // 进程搜索最大返回数
  notFoundConfirmSeconds: 0,  // 未找到游戏进程后二次确认等待(秒); 默认 0 = 不确认直接关闭, 需要时再开启
  dryRun: false,             // true 时「关闭」只预览不真正暂停
  logFile: 'watchdog.log',   // 日志文件, 空串则不写文件
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
    else if (a === '--once') flags.once = true;
    else if (a === '--no-log') flags.logFile = false;
    else if (a === '--verbose') flags.verbose = true;
  }
  return flags;
}

function loadConfig(argv = []) {
  const cfg = { ...DEFAULTS };
  const file = path.join(ROOT, 'config.json');
  if (fs.existsSync(file)) {
    let local = {};
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

  // 兜底下限, 防止误配置造成高频/无效调用
  if (cfg.pollIntervalSeconds < 5) cfg.pollIntervalSeconds = 5;
  if (cfg.checkIntervalMinutes < 1) cfg.checkIntervalMinutes = 1;
  if (cfg.gameQuerySeconds < 3) cfg.gameQuerySeconds = 3;
  if (cfg.notFoundConfirmSeconds < 0) cfg.notFoundConfirmSeconds = 0;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, ROOT };