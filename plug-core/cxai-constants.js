// 共享常量模块 — 在所有 content script 中可访问（非 MAIN world）
// 注意：page-inject.js 和 task-page-inject.js 运行在 MAIN world，无法访问此处的 window.CXAI_CONST
// 它们需要各自定义或通过 postMessage 传递（目前超时值保留在各自文件顶部以避免跨 world 问题）
(function () {
  'use strict';

  // 超时毫秒 —— 顶层只允许 content/background 使用
  var TIMEOUTS = {
    PAGE_CALL: 120000,        // window.postMessage 调用超时
    CHAT_RESPONSE: 120000,    // AI 老师回复等待（新架构流式 SSE，加缓冲）
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
    CODE_GENERATE: 120000,     // DeepSeek code generation timeout
    CODE_EVALUATE: 180000,     // Code evaluation polling timeout
    CODE_EVAL_POLL: 2000,      // Code evaluation poll interval
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
    SCAN_CACHE: 'cxai_scan_cache',       // 扫描结果缓存 { url, courseKey, tasks, time }
    MODEL_CACHE: 'cxai_model_cache',     // 官方 /models 接口返回缓存 { sig, models, time }
    STATS: 'cxai_stats',                 // token 使用统计
    UI_STATE: 'cxai_ui_state',           // 面板展开状态与拖拽位置
    BATCH_AUTO_AI: 'cxai_batch_auto_ai', // 批量执行时 AI 实践页自动开始开关
  };

  // 最大历史记录条数
  var LIMITS = {
    MAX_HISTORY: 50,
    MAX_RETRY_ATTEMPTS: 10,
    SCAN_CACHE_TTL: 3600000, // 1小时
    MODEL_CACHE_TTL: 21600000, // 6小时
  };

  // 无网/未填 Key 时的兜底默认模型清单
  var DEFAULT_MODELS = [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', effortLevels: ['low', 'high', 'max'] },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', effortLevels: ['low', 'high', 'max'] },
  ];

  // DeepSeek 模型定价 (元/1M token, 官方 2026-11 阶梯定价; 空闲时段为高峰价的 50%)
  // 高峰时段(北京时间): 周一至周五 09:00-12:00, 14:00-18:00
  var PRICING = {
    'deepseek-flash':  { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
    'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 },
  };

  // 旧版模型名 -> 新版官方模型 ID 迁移映射
  var MODEL_ALIASES = {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-chat':     'deepseek-flash',
    'deepseek-reasoner': 'deepseek-v4-pro',
  };

  // 导出到 window（content script 隔离 world 内共享）
  window.CXAI_CONST = {
    TIMEOUTS: TIMEOUTS,
    STORAGE_KEYS: STORAGE_KEYS,
    LIMITS: LIMITS,
    PRICING: PRICING,
    MODEL_ALIASES: MODEL_ALIASES,
    DEFAULT_MODELS: DEFAULT_MODELS,
  };
})();
