#!/usr/bin/env node
/**
 * autoCloseLeigod — 雷神加速器「没人玩游戏就自动暂停时长」看门狗
 *
 * 流程(全部时间可配置):
 *   1. 定时轮询加速状态 (time --acc, 每 pollIntervalSeconds)
 *   2. 加速中 → 询问是否有加速游戏 (game)
 *        有游戏 → 启动复查计时器(checkIntervalMinutes, 默认 10 分钟)并关闭轮询
 *        无游戏 → 继续轮询, 等待游戏出现
 *   3. 计时到期 → 再次询问加速状态
 *        没有游戏在加速 → 关闭: pause --force(暂停时长)
 *        有游戏 → 搜索进程 (ps 关键字 = exeName 优先, 否则游戏名)
 *          进程不存在 → 关闭: pause --force
 *          进程存在   → 重新计时, 循环监控
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./config');
const Leigod = require('./sdk');

const cfg = loadConfig(process.argv.slice(2));
const sdk = new Leigod({ exe: cfg.sdkExe });

let cycle = 0;          // 轮询计数
let guardNo = 0;        // 复查计数
let pollTimer = null;   // 轮询定时器
let guardTimer = null;  // 复查计时器
let pollBusy = false;   // 轮询执行中标记(防止 interval 重叠)
let guardBusy = false;  // 复查执行中标记(防止计时器并发)
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

/* ---------------- 核心动作 ---------------- */

/** 关闭: 暂停时长(等效界面「暂停时长」按钮, SDK 云端回放, 不动雷神任何文件) */
async function closeGuard(reason) {
  log(`[关闭] 触发: ${reason}`);
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
    log('[关闭] 完成, 看门狗退出。需要恢复时: 雷神界面点「开启时长」或 leigod-sdk.exe resume --force');
  } else {
    log('[关闭] 暂停执行失败, 请查看上方输出');
  }
  process.exit(ok ? 0 : 1);
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
    } catch (e) {
      log(`[轮询#${cycle}] time 查询失败: ${e.message} (继续轮询)`);
      return;
    }
    const acc = t.acc || {};
    if (!acc.accelerating) {
      log(`[轮询#${cycle}] 当前未在加速 (state=${t.state}), 继续轮询`);
      return;
    }

    // 加速中 → 询问是否有加速游戏
    let g;
    try {
      g = await sdk.game(cfg.gameQuerySeconds);
    } catch (e) {
      log(`[轮询#${cycle}] game 查询失败: ${e.message} (继续轮询)`);
      return;
    }

    if (g.accelerating && g.gameId) {
      const name = g.gameName || ('game_id=' + g.gameId);
      log(`[轮询#${cycle}] 加速中, 识别到游戏: ${name}${g.exeName ? ' / exe=' + g.exeName : ''}`);
      await enterGuard();
    } else {
      log(`[轮询#${cycle}] 加速中但未识别到游戏 (accelerating=${g.accelerating}, gameId=${g.gameId || '-'}), 继续轮询等待游戏出现`);
    }
  } finally {
    pollBusy = false;
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
      await closeGuard('复查时没有游戏在加速');
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
      await closeGuard(`搜索进程「${keyword}」无结果`);
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

/* ---------------- 启动 ---------------- */

async function main() {
  const exe = cfg.sdkExe;
  if (!fs.existsSync(exe)) {
    console.error(`[启动] SDK exe 不存在: ${exe}`);
    console.error('       请在 config.json 配置正确的 sdkExe (默认 ..\\leigod-sdk\\build\\leigod-sdk.exe)');
    process.exit(1);
  }

  log(`[启动] sdkExe=${exe}`);
  log(`[启动] 轮询间隔=${cfg.pollIntervalSeconds}s | 复查间隔=${cfg.checkIntervalMinutes}min | game查询等待=${cfg.gameQuerySeconds}s | dryRun=${cfg.dryRun} | once=${!!cfg.once}`);

  // 启动健康检查(只读): 未绑定立刻提示
  try {
    const t = await sdk.time();
    log(`[启动] 初始状态: state=${t.state} accelerating=${t.acc ? t.acc.accelerating : '-'}`);
  } catch (e) {
    if (/未绑定|bind/i.test(e.message)) {
      console.error('[启动] SDK 未绑定雷神加速器, 请先执行: leigod-sdk.exe bind --auto');
      process.exit(1);
    }
    log(`[启动] 初始 time 查询异常: ${e.message} (继续运行)`);
  }

  if (cfg.once) {
    await pollOnce();
    log('[--once] 单轮诊断结束');
    process.exit(0);
  }

  log('[启动] 开始轮询加速状态 (Ctrl+C 退出)');
  // 注意: 必须先注册 interval 再跑第一轮, 否则第一轮进入计时阶段时
  //       pollTimer 还是 null, stopPolling() 清不掉轮询 → 轮询无法停止
  pollTimer = setInterval(() => pollOnce(), cfg.pollIntervalSeconds * 1000);
  await pollOnce();
}

process.on('SIGINT', () => {
  log('收到 Ctrl+C, 看门狗退出');
  process.exit(130);
});

main().catch((e) => {
  console.error('[致命]', e);
  process.exit(1);
});