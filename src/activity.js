'use strict';

/**
 * 键鼠活动检测(策略2 用)。
 *
 * 原理: 调用 Win32 GetLastInputInfo 获取「系统最后一次键鼠输入的时间」,
 * 与当前 TickCount 求差得到空闲毫秒数 —— 空闲时间 ≤ 监听窗口即有活动。
 * 无需后台钩子/驱动, 纯查询, 与雷神无关(满足只读约束)。
 *
 * 通过 powershell -EncodedCommand 内联执行(免外部脚本文件, 与 SDK 的
 * searchProcesses 同思路); PS5.1 兼容。
 */

const { spawn } = require('child_process');

const PS_SCRIPT = [
  "$src = 'using System;using System.Runtime.InteropServices;public class Inp{[DllImport(\"user32.dll\")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);public struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}}'",
  'Add-Type -TypeDefinition $src',
  '$p = New-Object Inp+LASTINPUTINFO',
  '$p.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($p)',
  '[Inp]::GetLastInputInfo([ref]$p) | Out-Null',
  '$idle = [uint32]([Environment]::TickCount) - [uint32]($p.dwTime)',
  "Write-Output ('{\"idleMs\":' + $idle + '}')",
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 探测一次系统空闲毫秒数; 失败返回 null */
function probeIdleMs(timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      const b64 = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* noop */ }
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/\{"idleMs"\s*:\s*(\d+)\}/);
      resolve(m ? Number(m[1]) : null);
    });
  });
}

/**
 * listenSeconds 窗口内是否有键鼠活动(窗口起点/终点各采样一次)。
 * 返回 { active, samples, windowMs }; 探测失败视为无活动(fail-open: 不阻塞关闭)。
 */
async function detectActivity(listenSeconds) {
  const windowMs = Math.max(1, listenSeconds) * 1000;
  const t0 = await probeIdleMs();
  await sleep(windowMs);
  const t1 = await probeIdleMs();
  const samples = [t0, t1];
  const active = samples.some((v) => v !== null && v <= windowMs);
  return { active, samples, windowMs };
}

module.exports = { probeIdleMs, detectActivity };