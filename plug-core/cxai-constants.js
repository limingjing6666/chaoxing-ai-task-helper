// 共享常量模块 — 在所有 content script 中可访问（非 MAIN world）
// 注意：page-inject.js 和 task-page-inject.js 运行在 MAIN world，无法访问此处的 window.CXAI_CONST
// 它们需要各自定义或通过 postMessage 传递（目前超时值保留在各自文件顶部以避免跨 world 问题）
(function () {
  'use strict';

  // 超时毫秒 —— 顶层只允许 content/background 使用
  var TIMEOUTS = {
    PAGE_CALL: 120000,        // window.postMessage 调用超时
    CHAT_RESPONSE: 90000,     // AI 老师回复等待
    EVALUATE: 180000,         // 评估结果轮询总时长
    EVAL_POLL: 2000,          // 评估轮询间隔
    FILE_UPLOAD: 120000,      // 文件上传 + 解析等待
    UPLOAD_POLL: 2000,        // 上传轮询间隔
    FILE_PARSE: 60000,        // 文件解析等待（用于 runFileTask 循环）
    DEEPSEEK_DEFAULT_MAX_TOKENS: 1200,
    DEEPSEEK_DOC_MAX_TOKENS: 4000,
    SUBMIT_WAIT: 3000,        // 提交前等待
    RETRY_DELAY: 3000,        // 重试间隔
    EMPTY_REPLY_RETRY: 3000,  // 空回复重试间隔
    RUN_RETRY_AUTO_DELAY: 4000, // 重试自动启动延时
  };

  // chrome.storage.local 键名
  var STORAGE_KEYS = {
    CONFIG: 'cxai_config',               // 旧版单配置（迁移用）
    PROFILES: 'cxai_profiles',           // 多 profile 字典 { name: config }
    ACTIVE_PROFILE: 'cxai_active_profile',
    HISTORY: 'cxai_history',
    RETRY_STATE: 'cxai_retry_state',
    BATCH_QUEUE: 'cxai_batch_queue',
    BATCH_AUTO: 'cxai_batch_auto',
    BATCH_TOTAL: 'cxai_batch_total',
    BATCH_TASKS: 'cxai_batch_tasks',
    BATCH_FAILED: 'cxai_batch_failed',   // 批量中失败的 url 列表
    SCAN_CACHE: 'cxai_scan_cache',       // 扫描结果缓存 { url, tasks, time }
    STATS: 'cxai_stats',                 // token 使用统计
  };

  // 最大历史记录条数
  var LIMITS = {
    MAX_HISTORY: 50,
    MAX_RETRY_ATTEMPTS: 10,
    SCAN_CACHE_TTL: 3600000, // 1小时
  };

  // DeepSeek 模型定价 (元/1M token, 参考官网)
  var PRICING = {
    'deepseek-chat':     { input: 2.0, output: 8.0 },   // V3: ￥2/1M 输入, ￥8/1M 输出
    'deepseek-reasoner': { input: 4.0, output: 16.0 },  // R1: ￥4/1M 输入, ￥16/1M 输出
  };

  // 导出到 window（content script 隔离 world 内共享）
  window.CXAI_CONST = {
    TIMEOUTS: TIMEOUTS,
    STORAGE_KEYS: STORAGE_KEYS,
    LIMITS: LIMITS,
    PRICING: PRICING,
  };
})();
