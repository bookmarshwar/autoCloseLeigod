#!/usr/bin/env node
/**
 * autoCloseLeigod — 雷神加速器「没人玩游戏就自动暂停时长」看门狗
 *
 * 流程(全部时间可配置):
 *   1. 定时轮询 (time --acc, 每 pollIntervalSeconds)
 *      时长未在计时(state≠running) → 延后判断, 不做任何动作
 *   2. 计时中 → 用 game 询问是否有加速游戏(不依赖 acc, acc 只作参考)
 *        有游戏 → 启动复查计时器(checkIntervalMinutes, 默认 10 分钟)并关闭轮询
 *        无游戏 → 同样进入复查节奏, 复查间隔后再次检测(到时仍无游戏 → 自动暂停)
 *   3. 计时到期 → 先看时长状态; 仍计时中 → 再次询问加速状态
 *        没有游戏在加速 → 关闭: pause --force(暂停时长)
 *        有游戏 → 搜索进程 (ps 关键字 = exeName 优先, 否则游戏名)
 *          进程不存在 → 关闭: pause --force(默认直接关闭, 可配二次确认)
 *          进程存在   → 重新计时, 循环监控
 *
 * 附加策略(config.json strategies, 各自 enabled 独立开关):
 *   策略0 主流程: 轮询时长→询问游戏→复查→进程检查→暂停时长(默认开)
 *   策略1 定时关闭: 每天到达 closeTimes(HH:MM)且计时中 → 暂停时长
 *         (pause 后雷神自动停止加速, 不使用 stop 接口)
 *   策略2 键鼠检测: 依附模式(主流程开): 「关闭」前监听键鼠活动
 *         (listenSeconds 窗口), 有活动则延后 deferMinutes 再判断;
 *         独立模式(主流程关): 自身轮询键鼠, 连续空闲 idleMinutes
 *         分钟自动暂停时长(GetLastInputInfo, 纯查询无钩子)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./config');
const Leigod = require('./sdk');
const activity = require('./activity');

const cfg = loadConfig(process.argv.slice(2));
const sdk = new Leigod({ exe: cfg.sdkExe, debug: cfg.debug, log });

let cycle = 0;          // 轮询计数
let guardNo = 0;        // 复查计数
let firstPoll = true;   // 首轮轮询兼作启动健康检查(未绑定快速报错)
let pollTimer = null;   // 轮询定时器
let guardTimer = null;  // 复查计时器
let pollBusy = false;   // 轮询执行中标记(防止 interval 重叠)
let guardBusy = false;  // 复查执行中标记(防止计时器并发)
let scheduleTimer = null;              // 策略1: 定时检查定时器
let activityTimer = null;              // 策略2 独立模式: 键鼠探测定时器
const lastScheduledFired = new Map();  // 策略1: closeTime -> 当天日期(防同一天重复触发)
const checkMs = cfg.checkIntervalMinutes * 60 * 1000;

/* ---------------- 日志 ---------------- */

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  if (cfg.logFile) {
    try {
      const f = path.resolve(ROOT_DIR(), cfg.logFile);
      fs.appendFileSync(f, line + '\n');
    } catch (e) { /* 日志文件写失败不影响运行 */ }
  }
}

function ROOT_DIR() { return path.resolve(__dirname, '..'); }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 核心动作 ---------------- */

/** 关闭: 暂停时长(等效界面「暂停时长」按钮, SDK 云端回放, 不动雷神任何文件) */
async function closeGuard(reason, opts = {}) {
  log(`[关闭] 触发: ${reason}`);
  // 策略2: 执行关闭前检测键鼠活动, 有活动则延后判断
  const s2 = cfg.strategies.strategy2;
  if (opts.defer && s2.enabled) {
    log(`[策略2] 关闭前检测键鼠活动 (监听窗口 ${s2.listenSeconds}s, 全无键鼠才关闭)`);
    const r = await activity.detectActivity(s2.listenSeconds);
    log(`[策略2] 空闲采样: ${r.samples.map((v) => (v === null ? '失败' : v + 'ms')).join(' / ')}`);
    if (r.active) {
      log(`[策略2] 检测到键鼠活动 → 延后 ${s2.deferMinutes} 分钟再判断`);
      if (cfg.once) {
        log('[策略2] --once 诊断模式: 仅报告, 不执行任何操作');
        process.exit(0);
      }
      guardTimer = setTimeout(runGuardCheck, s2.deferMinutes * 60 * 1000);
      return;
    }
    log('[策略2] 无键鼠活动, 继续关闭流程');
  }
  if (cfg.once) {
    log('[关闭] --once 诊断模式: 仅报告, 不执行任何操作');
    process.exit(0);
  }
  if (cfg.dryRun) {
    log('[关闭] dry-run: 不真正暂停时长 (去掉 config.dryRun 或注释后生效)');
    process.exit(0);
  }
  const r = await sdk.pause();
  const ok = !!r.ok;
  log(`[关闭] 已执行暂停时长: ok=${ok} action=${r.action || '-'} httpStatus=${r.httpStatus || '-'}${r.effect ? ' effect=' + r.effect : ''}`);
  if (ok) {
    log('[关闭] 时长已暂停。看门狗继续驻留监听: 下次开启加速会自动重新守护 (Ctrl+C 退出)');
  } else {
    log('[关闭] 暂停执行失败, 继续驻留, 下次复查会重试 (Ctrl+C 退出)');
  }
  // 不管成功失败都不退出: 常驻看门狗, 等待用户下次开启加速
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }  // 策略2 独立模式探测停止
  if (cfg.strategies.strategy0.enabled) {
    startPolling();
  } else {
    log('[关闭] 主流程(策略0)已关闭, 不恢复轮询(策略1 定时检查仍生效; Ctrl+C 退出)');
  }
}

/** 轮询一次: 查询加速状态; 加速中则询问是否有加速游戏 */
async function pollOnce() {
  if (pollBusy) return;   // 上一轮还没结束(例如 game 查询超时), 跳过本次
  pollBusy = true;
  try {
    cycle++;
    let t;
    try {
      t = await sdk.time();
      if (firstPoll) log(`[启动] 初始状态: state=${t.state} accelerating=${t.acc ? t.acc.accelerating : '-'}`);
    } catch (e) {
      if (firstPoll && /未绑定|bind/i.test(e.message)) {
        console.error('[启动] SDK 未绑定雷神加速器, 请先执行: leigod-sdk.exe bind --auto');
        process.exit(1);
      }
      log(`[轮询#${cycle}] time 查询失败: ${e.message} (继续轮询)`);
      return;
    }
    const acc = t.acc || {};
    // 先判断时长是否在计时: 时长没在消耗(state≠running)就直接延后, 不做任何判断/动作
    if (t.state !== 'running') {
      log(`[轮询#${cycle}] 时长未在计时 (state=${t.state}), 延后判断`);
      return;
    }

    // 计时中 → 用 game 接口确认是否有游戏在加速(acc 只作参考:
    // 暂停时长不会停加速会话, WS 瞬时抖动也可能漏报加速)
    let g;
    try {
      g = await sdk.game(cfg.gameQuerySeconds);
    } catch (e) {
      log(`[轮询#${cycle}] game 查询失败: ${e.message} (继续轮询)`);
      return;
    }

    if (g.accelerating && g.gameId) {
      const name = g.gameName || ('game_id=' + g.gameId);
      log(`[轮询#${cycle}] 计时中, 识别到游戏: ${name}${g.exeName ? ' / exe=' + g.exeName : ''}${acc.accelerating ? '' : ' (acc 未报加速, 以 game 为准)'}`);
      await enterGuard();
    } else {
      // 计时中但查不到游戏: 进入复查节奏——复查间隔后再次检测, 到时仍无游戏则自动暂停
      log(`[轮询#${cycle}] 计时中但未识别到加速游戏 (acc=${acc.accelerating}, gameId=${g.gameId || '-'}), ${cfg.checkIntervalMinutes} 分钟后再次检测`);
      await enterGuard();
    }
  } finally {
    pollBusy = false;
    firstPoll = false;
  }
}

/** 进入计时阶段: 关闭轮询, 启动复查计时器 */
async function enterGuard() {
  stopPolling();
  if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }  // 防计时器叠加
  log(`[计时] 已停止轮询, ${cfg.checkIntervalMinutes} 分钟后复查加速状态`);
  if (cfg.once) return runGuardCheck();
  guardTimer = setTimeout(runGuardCheck, checkMs);
}

/** 计时到期: 再次询问加速状态; 无游戏 → 关闭; 有游戏 → 搜索进程 */
async function runGuardCheck() {
  if (guardBusy) return;   // 防止多个计时器同时触发
  guardBusy = true;
  try {
    guardTimer = null;
    guardNo++;
    // 先判断时长状态: 已暂停/未计时 → 无需暂停动作, 直接恢复轮询驻留
    let t;
    try {
      t = await sdk.time();
    } catch (e) {
      log(`[检查#${guardNo}] time 查询失败: ${e.message}, ${cfg.checkIntervalMinutes} 分钟后重试`);
      if (!cfg.once) guardTimer = setTimeout(runGuardCheck, checkMs);
      return;
    }
    if (t.state !== 'running') {
      log(`[检查#${guardNo}] 时长未在计时 (state=${t.state}), 无需处理, 恢复轮询驻留`);
      startPolling();
      return;
    }
    let g;
    try {
      g = await sdk.game(cfg.gameQuerySeconds);
    } catch (e) {
      log(`[检查#${guardNo}] game 查询失败: ${e.message}, ${cfg.checkIntervalMinutes} 分钟后重试`);
      if (!cfg.once) guardTimer = setTimeout(runGuardCheck, checkMs);
      return;
    }

    if (!(g.accelerating && g.gameId)) {
      // 没有游戏在加速 → 关闭
      log(`[检查#${guardNo}] 加速状态: 没有游戏在加速 (accelerating=${g.accelerating}, gameId=${g.gameId || '-'})`);
      await closeGuard('复查时没有游戏在加速', { defer: true });
      return;
    }

    // 有游戏在加速 → 搜索进程
    const keyword = g.exeName || g.gameName || String(g.gameId);
    log(`[检查#${guardNo}] 加速中: ${g.gameName || ('game_id=' + g.gameId)} → 搜索进程关键字: ${keyword}`);
    let p;
    try {
      p = await sdk.ps(keyword, cfg.processMaxResults);
    } catch (e) {
      log(`[检查#${guardNo}] 进程搜索失败: ${e.message}, ${cfg.checkIntervalMinutes} 分钟后重试`);
      if (!cfg.once) guardTimer = setTimeout(runGuardCheck, checkMs);
      return;
    }

    if (p.count === 0) {
      log(`[检查#${guardNo}] 未找到进程「${keyword}」, 游戏不在运行`);
      // 二次确认: 防止 ps 枚举瞬时抽风(进程刚启动等)导致误暂停
      if (cfg.notFoundConfirmSeconds > 0) {
        log(`[检查#${guardNo}] ${cfg.notFoundConfirmSeconds} 秒后二次确认...`);
        await sleep(cfg.notFoundConfirmSeconds * 1000);
        try {
          const p2 = await sdk.ps(keyword, cfg.processMaxResults);
          if (p2.count > 0) {
            const names = p2.processes
              .map((pr) => pr.name + (pr.windowTitle ? `("${pr.windowTitle}")` : ''))
              .join(', ');
            log(`[检查#${guardNo}] 二次确认发现进程「${keyword}」: ${names}, 游戏仍在运行, ${cfg.checkIntervalMinutes} 分钟后再次复查`);
            if (!cfg.once) guardTimer = setTimeout(runGuardCheck, checkMs);
            return;
          }
          log(`[检查#${guardNo}] 二次确认仍未找到进程「${keyword}」`);
        } catch (e) {
          log(`[检查#${guardNo}] 二次确认进程搜索失败: ${e.message}, 按未找到处理`);
        }
      }
      await closeGuard(`搜索进程「${keyword}」无结果${cfg.notFoundConfirmSeconds > 0 ? '(已二次确认)' : ''}`, { defer: true });
      return;
    }

    const names = p.processes
      .map((pr) => pr.name + (pr.windowTitle ? `("${pr.windowTitle}")` : ''))
      .join(', ');
    log(`[检查#${guardNo}] 进程「${keyword}」存在: ${names}`);
    log(`[计时] 游戏仍在运行, ${cfg.checkIntervalMinutes} 分钟后再次复查`);
    if (!cfg.once) guardTimer = setTimeout(runGuardCheck, checkMs);
  } finally {
    guardBusy = false;
  }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** 启动轮询(先注册 timer 再跑第一轮, 保证 stopPolling 生效) */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => pollOnce(), cfg.pollIntervalSeconds * 1000);
  pollOnce();
}

/* ---------------- 策略1: 定时关闭 ---------------- */

/** 到达配置的 closeTimes(HH:MM)且时长在计时中 → 暂停时长(可选一并停止加速) */
function checkScheduledClose() {
  const s1 = cfg.strategies.strategy1;
  if (!s1.enabled || guardBusy) return;
  const times = Array.isArray(s1.closeTimes) ? s1.closeTimes : [];
  if (times.length === 0) return;
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hhmm = `${p(now.getHours())}:${p(now.getMinutes())}`;
  if (!times.includes(hhmm)) return;
  const dayKey = now.toDateString();
  if (lastScheduledFired.get(hhmm) === dayKey) return;  // 当天已触发过
  lastScheduledFired.set(hhmm, dayKey);
  log(`[策略1] 到达定时关闭时间 ${hhmm}, 检查时长状态`);
  sdk.time().then((t) => {
    if (t.state !== 'running') {
      log(`[策略1] 当前未在计时 (state=${t.state}), 无需关闭`);
      return;
    }
    log(`[策略1] 时长仍在计时, 执行定时关闭`);
    // 不调用 stop: pause 暂停时长后雷神会自动停止加速游戏, stop 只会清除
    // game 检测到的状态, 没有额外意义
    closeGuard(`定时关闭 ${hhmm}`);
  }).catch((e) => log(`[策略1] time 查询失败: ${e.message}`));
}

/* ---------------- 策略2: 键鼠活动检测 ---------------- */

/** 策略2 独立模式(主流程关闭时): 周期性探测键鼠, 连续空闲超过 idleMinutes 自动暂停 */
function startActivityGuard() {
  const s2 = cfg.strategies.strategy2;
  log(`[策略2] 独立模式启动: 每 ${cfg.pollIntervalSeconds}s 探测键鼠, 连续空闲超过 ${s2.idleMinutes}min 自动暂停时长`);
  let lastActiveMs = Date.now();
  activityTimer = setInterval(() => {
    (async () => {
      const r = await activity.detectActivity(s2.listenSeconds);
      if (r.active) {
        lastActiveMs = Date.now();
        log('[策略2] 检测到键鼠活动, 重置空闲计时');
        return;
      }
      const idleMs = Date.now() - lastActiveMs;
      log(`[策略2] 空闲中: 已连续 ${(idleMs / 60000).toFixed(1)}min / 阈值 ${s2.idleMinutes}min`);
      if (idleMs >= s2.idleMinutes * 60 * 1000) {
        closeGuard(`策略2 独立模式: 连续无键鼠活动 ${s2.idleMinutes} 分钟`);
      }
    })();
  }, cfg.pollIntervalSeconds * 1000);
}

/* ---------------- 启动 ---------------- */

async function main() {
  const exe = cfg.sdkExe;
  if (!fs.existsSync(exe)) {
    console.error(`[启动] SDK exe 不存在: ${exe}`);
    console.error('       请在 config.json 配置正确的 sdkExe (默认 ..\\leigod-sdk\\build\\leigod-sdk.exe)');
    process.exit(1);
  }

  log(`[启动] sdkExe=${exe} | dryRun=${cfg.dryRun} | debug=${cfg.debug} | once=${!!cfg.once}`);
  const s0 = cfg.strategies.strategy0;
  const s1 = cfg.strategies.strategy1;
  const s2 = cfg.strategies.strategy2;
  const s2Standalone = s2.enabled && !s0.enabled;  // 策略2 独立模式(主流程关闭时)
  log(`[启动] 策略0 主流程(轮询→守护→关闭): ${s0.enabled ? `开 (轮询${cfg.pollIntervalSeconds}s/复查${cfg.checkIntervalMinutes}min/查询${cfg.gameQuerySeconds}s/进程上限${cfg.processMaxResults}/二次确认${cfg.notFoundConfirmSeconds}s)` : '关'}`);
  log(`[启动] 策略1 定时关闭: ${s1.enabled ? `开 (每天 ${s1.closeTimes.length ? s1.closeTimes.join(',') : '未设置时间'})` : '关'}`);
  if (s1.enabled && (!Array.isArray(s1.closeTimes) || s1.closeTimes.length === 0)) {
    log('[启动] 警告: 策略1 已启用但未设置 closeTimes, 不会触发任何定时关闭 —— 请配置如 ["23:30"]');
  }
  log(`[启动] 策略2 键鼠检测: ${s2.enabled ? (s2Standalone ? `开 (独立模式: 空闲${s2.idleMinutes}min 自动暂停)` : `开 (监听 ${s2.listenSeconds}s, 有活动延后 ${s2.deferMinutes}min)`) : '关'}`);
  if (s2Standalone) {
    log('[启动] 策略2 以独立模式运行: 主流程未启用, 直接按键鼠空闲探测守护时长');
  }
  if (!s0.enabled && !s1.enabled && !s2Standalone) {
    log('[启动] 没有任何策略启用, 看门狗退出 (可改 config.json 的 strategies 段)');
    process.exit(0);
  }

  if (cfg.once) {
    if (!s0.enabled) {
      log('[--once] 主流程(策略0)已关闭, 无可诊断内容');
      process.exit(0);
    }
    await pollOnce();
    log('[--once] 单轮诊断结束');
    process.exit(0);
  }

  if (s0.enabled) {
    log('[启动] 开始轮询加速状态 (Ctrl+C 退出)');
    startPolling();
  } else if (s2Standalone) {
    startActivityGuard();
  } else {
    log('[启动] 主流程已关闭, 仅运行策略1 定时检查');
  }
  if (s1.enabled) {
    scheduleTimer = setInterval(checkScheduledClose, 30 * 1000);
    checkScheduledClose();
  }
}

process.on('SIGINT', () => {
  log('收到 Ctrl+C, 看门狗退出');
  process.exit(130);
});

main().catch((e) => {
  console.error('[致命]', e);
  process.exit(1);
});