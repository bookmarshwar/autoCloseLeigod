'use strict';

/**
 * leigod-sdk.exe 的轻量封装。
 * SDK CLI 契约: 成功时 stdout 输出 JSON、退出码 0; 失败时错误在 stderr、退出码非 0。
 * 注意: game/pause/bind 等命令会在 JSON 之后追加人类可读行, 因此按「第一个 JSON 对象」提取。
 */
const { spawn } = require('child_process');

/** 从混合文本中提取第一个 JSON 对象(带引号/转义/嵌套处理) */
function extractFirstJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

class Leigod {
  constructor({ exe, timeoutMs = 90000 } = {}) {
    if (!exe) throw new Error('缺少 sdkExe 路径');
    this.exe = exe;
    this.timeoutMs = timeoutMs;
  }

  run(args, timeoutMs) {
    const t = timeoutMs || this.timeoutMs;
    return new Promise((resolve, reject) => {
      const child = spawn(this.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`命令超时(${t}ms): ${args.join(' ')}`));
      }, t);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const obj = extractFirstJson(out);
        if (code === 0 && obj) return resolve(obj);
        const tail = (err.trim() || out.trim() || `退出码 ${code}`).split(/\r?\n/).slice(-1)[0];
        const e = new Error(`SDK 命令失败 (${args.join(' ')}): ${tail}`);
        e.exitCode = code;
        reject(e);
      });
    });
  }

  /** 当前时长状态 + 加速状态(只读): { state, acc: { wsConnected, accelerating, gameId } } */
  time() { return this.run(['time', '--acc']); }

  /** 当前加速的游戏(只读): { accelerating, gameId, gameName, exeName, ... } */
  game(seconds = 8) { return this.run(['game', '--seconds', String(seconds)], 45000); }

  /** 按关键字搜索进程(只读): { total, count, processes: [{ name, pid, path, windowTitle, ... }] } */
  ps(keyword, maxResults = 50) {
    return this.run(['ps', String(keyword), '--max', String(maxResults)], 120000);
  }

  /** 暂停时长(云端回放, 等效界面「暂停时长」按钮): { ok, action, httpStatus, ... } */
  pause() { return this.run(['pause', '--force'], 45000); }
}

module.exports = Leigod;