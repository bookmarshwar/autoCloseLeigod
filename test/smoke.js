'use strict';

/**
 * 冒烟测试(全部只读, 无副作用):
 *   1. 配置加载正常
 *   2. SDK exe 存在
 *   3. time --acc 输出结构合法
 *   4. ps 搜索输出结构合法
 * 不执行任何暂停/恢复动作。
 */
const fs = require('fs');
const assert = require('assert');
const { loadConfig } = require('../src/config');
const Leigod = require('../src/sdk');

(async () => {
  const cfg = loadConfig([]);
  assert.ok(cfg.sdkExe, '配置缺少 sdkExe');
  assert.ok(fs.existsSync(cfg.sdkExe), `SDK exe 不存在: ${cfg.sdkExe}`);
  console.log(`[ok] 配置: sdkExe=${cfg.sdkExe} poll=${cfg.pollIntervalSeconds}s check=${cfg.checkIntervalMinutes}min dryRun=${cfg.dryRun}`);

  const sdk = new Leigod({ exe: cfg.sdkExe });

  const t = await sdk.time();
  assert.ok(typeof t.state === 'string', 'time.state 应为字符串');
  assert.ok(['paused', 'running', 'unknown'].includes(t.state), `time.state 值异常: ${t.state}`);
  assert.ok(t.acc && typeof t.acc.accelerating === 'boolean', 'time --acc 应返回 acc.accelerating 布尔值');
  console.log(`[ok] time --acc: state=${t.state} accelerating=${t.acc.accelerating}`);

  const p = await sdk.ps('leigod', 10);
  assert.ok(Array.isArray(p.processes) && typeof p.count === 'number', 'ps 输出结构异常');
  console.log(`[ok] ps leigod: total=${p.total} count=${p.count}`);

  console.log('冒烟测试通过(全部只读)');
})().catch((e) => {
  console.error('冒烟测试失败:', e.message);
  process.exit(1);
});