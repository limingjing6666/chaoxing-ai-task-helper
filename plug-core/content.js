(function () {
  'use strict';

  // ==================== 共享常量（有 fallback 保底） ====================
  var _CONST = window.CXAI_CONST || {};
  var K = _CONST.STORAGE_KEYS || {
    CONFIG: 'cxai_config', PROFILES: 'cxai_profiles', ACTIVE_PROFILE: 'cxai_active_profile',
    HISTORY: 'cxai_history', RETRY_STATE: 'cxai_retry_state',
    BATCH_QUEUE: 'cxai_batch_queue', BATCH_AUTO: 'cxai_batch_auto',
    BATCH_TOTAL: 'cxai_batch_total', BATCH_TASKS: 'cxai_batch_tasks',
    BATCH_FAILED: 'cxai_batch_failed', SCAN_CACHE: 'cxai_scan_cache', STATS: 'cxai_stats',
    UI_STATE: 'cxai_ui_state', BATCH_AUTO_AI: 'cxai_batch_auto_ai'
  };
  var T = _CONST.TIMEOUTS || {
    PAGE_CALL: 120000, DEEPSEEK_DEFAULT_MAX_TOKENS: 1200, DEEPSEEK_DOC_MAX_TOKENS: 4000,
    RETRY_DELAY: 3000, EMPTY_REPLY_RETRY: 3000, SUBMIT_WAIT: 3000, RUN_RETRY_AUTO_DELAY: 4000,
    FILE_PARSE: 60000
  };
  var L = _CONST.LIMITS || { MAX_HISTORY: 50, MAX_RETRY_ATTEMPTS: 10, SCAN_CACHE_TTL: 3600000 };
  var PRICING = _CONST.PRICING || {
    'deepseek-flash':  { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
    'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 }
  };
  var MODEL_ALIASES = _CONST.MODEL_ALIASES || {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-chat':     'deepseek-flash',
    'deepseek-reasoner': 'deepseek-v4-pro'
  };

  function normalizeModelId(model) {
    var m = String(model || 'deepseek-flash').trim();
    return MODEL_ALIASES[m] || m;
  }

  // ==================== 配置 ====================
  const DEFAULT_CONFIG = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    thinkingMode: 'none',      // none(关闭) / low / high
    rounds: 5,
    delay: 3,
    customPrompt: '',
    promptStyle: 'balanced',
    targetScore: 0,
    discussLength: 'medium',   // 讨论字数: short(120-200) / medium(200-400) / long(400-600)
  };

  // 讨论字数档位
  const DISCUSS_LENGTHS = {
    short:  { range: '120-200', label: '短 (120-200字)' },
    medium: { range: '200-400', label: '中 (200-400字)' },
    long:   { range: '400-600', label: '长 (400-600字)' },
  };

  const PROMPT_STYLES = {
    balanced: '',
    curious: '\n\n【风格：探究追问】\n- 以探索和追问为主，逐步推进对话\n- 主动指出边界条件、隐含假设和特殊场景\n- 在回应对方观点后补充自己的判断与追问\n- 保持思辨感，但不要脱离当前角色设定',
    deep: '\n\n【风格：落地实战】\n- 以真实场景中的执行、取舍和落地路径为重点\n- 主动讨论风险、成本、效率、协作或实施细节\n- 优先给出可操作的分析，而不是停留在抽象概念\n- 保持专业、稳健，贴合当前任务身份',
    concise: '\n\n【风格：精准高效】\n- 回复尽量简洁，控制在80字以内\n- 直接表达核心判断、关键依据和下一步推进点\n- 避免铺垫和重复，保持高信息密度\n- 即使简短，也必须符合当前角色和场景'
  };

  const PROMPT_STYLE_LABELS = {
    balanced: '🎯 专业均衡',
    curious: '🧭 探究追问',
    deep: '🛠 落地实战',
    concise: '⚡ 精准高效'
  };

  let config = { ...DEFAULT_CONFIG };
  let isRunning = false;
  let isPaused = false;
  let aborted = false;
  let lastFeedback = null;

  // 把评估反馈汇总成重试注入用的文本（兼容新旧架构）
  // 新架构 feedback: { score, dimensions:[{name,score}], shortcoming, suggestions:[], rawText }
  // 旧架构 feedback: { score, shortcoming, suggestions, points:[{name,score}] }
  function summarizeFeedback(fb) {
    if (!fb) return '';
    var parts = [];
    if (fb.dimensions && fb.dimensions.length > 0) {
      var lowDims = fb.dimensions.filter(function (d) { return d.score < 20; });
      if (lowDims.length) parts.push('低分项: ' + lowDims.map(function (d) { return d.name + '(' + d.score + ')'; }).join(', '));
    }
    if (fb.shortcoming) {
      parts.push('不足: ' + fb.shortcoming);
    } else if (fb.rawText) {
      var shortM = fb.rawText.match(/不足[：:][\s\S]*?(?=建议|本次成绩|$)/);
      if (shortM) parts.push('不足: ' + shortM[0].replace(/^不足[：:]/, '').trim());
    }
    if (fb.suggestions && fb.suggestions.length > 0) {
      parts.push('建议: ' + fb.suggestions.join('; '));
    } else if (fb.rawText) {
      var sugM = fb.rawText.match(/建议[：:][\s\S]*?(?=本次成绩|$)/);
      if (sugM) parts.push('建议: ' + sugM[0].replace(/^建议[：:]/, '').trim());
    }
    if (fb.points && fb.points.length > 0) {
      var lowPoints = fb.points.filter(function (p) { return p.score && parseInt(p.score) < 20; });
      if (lowPoints.length) parts.push('低分项: ' + lowPoints.map(function (p) { return p.name + '(' + p.score + ')'; }).join(', '));
    }
    return parts.join('\n');
  }
  let activeProfile = 'default';   // 当前 profile 名
  let profiles = {};                // { name: config }
  let sessionUsage = { input: 0, output: 0, cost: 0, calls: 0 }; // 本次会话累计
  let totalStats = { input: 0, output: 0, cost: 0, calls: 0 };   // 历史累计
  let lastTaskData = null;          // 最近一次 getState 返回值
  let batchAutoRunAi = true;        // 批量时 AI 实践页是否自动执行

  // DOM 引用
  let panelEl, logEl, logPreviewEl, statusEl, progressBarEl, startBtn, stopBtn, continueBtn, evalNowBtn, taskInfoEl, evalCardEl;
  let dockSide = 'right';

  function cxIcon(name, size) {
    var s = size || 14;
    var map = {
      brand: '<rect x="3" y="3" width="18" height="18" rx="4"/><polyline points="8 9 11 12 8 15"/><line x1="13" y1="15" x2="16" y2="15"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
      history: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
      terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 10 10 13 7 16"/><line x1="12" y1="16" x2="17" y2="16"/>',
      play: '<polygon points="6 4 20 12 6 20 6 4"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
      bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
      scan: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
      filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
      checkAll: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
      check: '<polyline points="20 6 9 17 4 12"/>',
      rocket: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
      save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
      plug: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
      sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"/>',
      copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      dockLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
      dockRight: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>',
      minimize: '<line x1="5" y1="12" x2="19" y2="12"/>',
      eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
      eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>',
      plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
      minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
      target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
      award: '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/>',
      image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
      bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8a6 6 0 0 0-12 0c0 1.33.47 2.48 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>'
    };
    var body = map[name] || '';
    return '<span class="cxai-svg"><svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg></span>';
  }

  // 页面检测
  var isLegacyTaskListPage = location.hostname === 'mobilelearn.chaoxing.com' && location.pathname.indexOf('/page/active/stuActiveList') !== -1;
  var isFanyaTaskListPage = location.hostname === 'mooc2-ans.chaoxing.com' && location.pathname.indexOf('/mooc2-ans-vue/fanyav3/studentCourse') !== -1;
  var isTaskListPage = isLegacyTaskListPage || isFanyaTaskListPage;
  var isAiPracticePage = /\/ai-evaluate\//.test(location.pathname) || /\/mooc2-ans\/ai-evaluate\//.test(location.pathname) || /\/mooc2-ans-vue\/situationalDialogue/.test(location.pathname);
  var isDiscussPage = (
    location.pathname.indexOf('/page/active/stuTopicDetail') !== -1
    || location.pathname.indexOf('/page/active/') !== -1 && /topic|discuss|reply/i.test(location.href)
    || location.pathname.indexOf('/bbs/') !== -1
    || location.hostname === 'groupweb.chaoxing.com' && (
      location.pathname.indexOf('/course/topicDiscuss') !== -1
      || location.pathname.indexOf('/pc/topic/jumpToTopicDetail') !== -1
      || location.pathname.indexOf('/course/topic/v3/bbs/') !== -1
    )
    || /回复话题|话题详情|主题讨论/.test(document.title)
    || !!document.querySelector('.textareawrap textarea[placeholder*="回复"], textarea[placeholder*="回复话题"], textarea[placeholder*="回复"], .reply-box textarea, .reply-topic textarea, .editContainer .replyEdit textarea')
  );
  var isSupportedPage = isTaskListPage || isAiPracticePage || isDiscussPage;
  // 新架构（Vue3 SPA situationalDialogue）标识，对话型主流程据此分支
  var isNewArchPage = /\/mooc2-ans-vue\/situationalDialogue/.test(location.pathname);

  // 批量模式状态（任务列表页）
  var collectedTasks = [];
  var batchTaskSelection = {};
  var isCollecting = false;

  // ==================== 工具函数 ====================

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  function escHtml(s) {
    if (!s && s !== 0) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function normalizeRuntimeError(err) {
    var msg = err && err.message ? String(err.message) : String(err || '未知错误');
    if (/Extension context invalidated/i.test(msg)
      || /Receiving end does not exist/i.test(msg)
      || /Could not establish connection/i.test(msg)) {
      return '扩展刚刚已更新，当前页面仍在运行旧脚本。请刷新页面后重试。';
    }
    return msg;
  }

  function isExtensionAlive() {
    try {
      return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function storageGet(keys, cb) {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.get(keys, function (r) {
        if (!isExtensionAlive() || chrome.runtime.lastError) return;
        if (cb) cb(r || {});
      });
    } catch (e) {}
  }

  function storageSet(obj, cb) {
    if (!isExtensionAlive()) return false;
    try {
      chrome.storage.local.set(obj, function () {
        if (!isExtensionAlive() || chrome.runtime.lastError) return;
        if (cb) cb();
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function runtimeSend(msg, cb) {
    if (!isExtensionAlive()) {
      if (cb) cb(null, new Error('Extension context invalidated'));
      return false;
    }
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        var lastErr = isExtensionAlive() ? chrome.runtime.lastError : new Error('Extension context invalidated');
        if (cb) cb(resp, lastErr);
      });
      return true;
    } catch (e) {
      if (cb) cb(null, e);
      return false;
    }
  }

  // ==================== 日志 + Toast ====================

  function log(msg, type = '') {
    console.log('[ChaoxingAI]', msg);
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = 'cxai-log-line' + (type ? ` cxai-log-${type}` : '');
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const ts = document.createElement('span');
    ts.className = 'cxai-log-time';
    ts.textContent = '[' + time + ']';
    const tx = document.createElement('span');
    tx.className = 'cxai-log-text';
    tx.textContent = msg;
    line.appendChild(ts);
    line.appendChild(tx);
    logEl.appendChild(line);
    logEl.scrollTo({ top: logEl.scrollHeight, behavior: 'smooth' });
    if (logPreviewEl) {
      var preview = String(msg || '').replace(/^\n+/, '').replace(/\s+/g, ' ').trim();
      if (preview) {
        logPreviewEl.textContent = preview;
        logPreviewEl.style.color = type === 'error' ? '#dc2626'
          : (type === 'success' ? '#059669'
          : (type === 'warn' ? '#d97706' : '#64748b'));
      }
    }
  }

  // Toast 通知 — 重要事件的视觉反馈
  var _toastContainer = null;
  function toast(msg, type) {
    type = type || 'info';
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'cxai-toast-container';
      document.body.appendChild(_toastContainer);
    }
    var icons = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' };
    var el = document.createElement('div');
    el.className = 'cxai-toast cxai-toast-' + type;
    var icon = document.createElement('span');
    icon.className = 'cxai-toast-icon';
    icon.textContent = icons[type] || icons.info;
    var txt = document.createElement('span');
    txt.className = 'cxai-toast-text';
    txt.textContent = msg;
    el.appendChild(icon);
    el.appendChild(txt);
    _toastContainer.appendChild(el);
    // 3.5秒后淡出
    setTimeout(function () {
      el.classList.add('cxai-toast-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
    }, type === 'error' ? 5000 : 3500);
  }

  let liveDotEl, scoreEl;

  function formatStatusText(text) {
    var t = String(text || '');
    if (t === 'IDLE') return '待命中';
    if (t === 'RUNNING') return '运行中...';
    if (t === 'ABORTED') return '已中止';
    if (t === 'BATCH_START') return '启动批量中...';
    if (t === 'EVAL_ERR') return '评估异常';
    if (t === 'SUBMIT_ERR') return '提交失败';
    if (t === 'ERROR') return '运行出错';
    if (t === 'DONE') return '已完成';
    if (t.indexOf('DONE · ') === 0) return '已完成 · ' + t.slice(7);
    return t;
  }

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.className = 'cxai-status-bar cxai-st-' + cls;
    statusEl.querySelector('.cxai-status-text').textContent = formatStatusText(text);
    if (liveDotEl) {
      if (cls === 'running') liveDotEl.classList.add('cxai-active');
      else liveDotEl.classList.remove('cxai-active');
    }
    if (progressBarEl) {
      progressBarEl.classList.toggle('is-done', cls === 'done');
      progressBarEl.classList.toggle('is-error', cls === 'error');
    }
    var toggleBtnEl = document.getElementById('cxai-toggle-btn');
    if (toggleBtnEl) {
      toggleBtnEl.classList.toggle('cxai-is-running', cls === 'running');
    }
    if (scoreEl && cls === 'done') {
      var m = String(text).match(/(\d+)/);
      if (m) scoreEl.textContent = m[1];
    }
  }

  function setProgress(pct) {
    if (progressBarEl) progressBarEl.style.width = pct + '%';
  }

  // ==================== 页面注入（与 Vue 应用交互） ====================

  let _pageCallId = 0;
  const _pageCallbacks = {};

  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'cxai-page') {
      const cb = _pageCallbacks[e.data.id];
      if (cb) {
        delete _pageCallbacks[e.data.id];
        if (e.data.error) cb.reject(new Error(e.data.error));
        else cb.resolve(e.data.data);
      }
    }
  });

  function pageCall(action, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = ++_pageCallId;
      _pageCallbacks[id] = { resolve, reject };
      window.postMessage({ source: 'cxai-content', action, id, ...payload }, '*');
      setTimeout(() => {
        if (_pageCallbacks[id]) {
          delete _pageCallbacks[id];
          reject(new Error('pageCall("' + action + '") 超时(' + Math.round(T.PAGE_CALL / 1000) + 's)'));
        }
      }, T.PAGE_CALL);
    });
  }

  // ==================== background.js 通信 ====================

  function bgMessage(msg) {
    return new Promise(function (resolve, reject) {
      runtimeSend(msg, function (resp, err) {
        if (err) return reject(new Error(normalizeRuntimeError(err)));
        if (!resp) return reject(new Error('无响应'));
        if (resp.success) resolve(resp.data);
        else reject(new Error(resp.error || '未知错误'));
      });
    });
  }

  // bgChat: 发送 DeepSeek 请求，自动注入 thinkingMode 并累计 token/费用
  function bgChat(payload) {
    var msg = Object.assign({ type: 'DEEPSEEK_CHAT', thinkingMode: config.thinkingMode }, payload);
    return new Promise(function (resolve, reject) {
      runtimeSend(msg, function (resp, err) {
        if (err) return reject(new Error(normalizeRuntimeError(err)));
        if (!resp) return reject(new Error('无响应'));
        if (!resp.success) return reject(new Error(resp.error || '未知错误'));
        if (resp.usage) recordUsage(msg.model || config.model, resp.usage);
        resolve(resp.data);
      });
    });
  }

  // ==================== Token 统计 ====================
  function getDeepSeekPeakMultiplier() {
    // 北京时间 (UTC+8): 周一至周五 09:00-12:00 及 14:00-18:00 为高峰时段，其余时段为 5 折
    var bj = new Date(Date.now() + 8 * 3600000);
    var day = bj.getUTCDay();
    var hour = bj.getUTCHours();
    var isWeekday = day >= 1 && day <= 5;
    var isPeak = isWeekday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
    return isPeak ? 1.0 : 0.5;
  }

  function recordUsage(model, usage) {
    var inputT = usage.prompt_tokens || 0;
    var outputT = usage.completion_tokens || 0;
    var cacheHitT = usage.prompt_cache_hit_tokens != null
      ? usage.prompt_cache_hit_tokens
      : (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens != null ? usage.prompt_tokens_details.cached_tokens : 0);
    var cacheMissT = usage.prompt_cache_miss_tokens != null
      ? usage.prompt_cache_miss_tokens
      : Math.max(0, inputT - cacheHitT);

    var resolved = normalizeModelId(model);
    var p = PRICING[resolved] || PRICING['deepseek-flash'];
    var mult = getDeepSeekPeakMultiplier();
    var cost = ((cacheHitT / 1e6) * p.cacheHit + (cacheMissT / 1e6) * p.cacheMiss + (outputT / 1e6) * p.output) * mult;

    sessionUsage.input += inputT;
    sessionUsage.output += outputT;
    sessionUsage.cost += cost;
    sessionUsage.calls += 1;

    totalStats.input += inputT;
    totalStats.output += outputT;
    totalStats.cost += cost;
    totalStats.calls += 1;
    updateUsageUI();

    // 累计到 storage
    storageGet([K.STATS], function (r) {
      var s = r[K.STATS] || { input: 0, output: 0, cost: 0, calls: 0 };
      s.input += inputT;
      s.output += outputT;
      s.cost += cost;
      s.calls += 1;
      totalStats = s;
      var o = {}; o[K.STATS] = s;
      storageSet(o);
      updateUsageUI();
    });
  }

  function loadTotalStats() {
    storageGet([K.STATS], function (r) {
      if (r[K.STATS]) {
        totalStats = r[K.STATS];
        updateUsageUI();
      }
    });
  }

  function updateUsageUI() {
    if (!panelEl) return;
    var el = panelEl.querySelector('#cxai-usage-info');
    if (!el) return;
    var curTokens = formatTokens(sessionUsage.input + sessionUsage.output);
    var allTokens = formatTokens((totalStats.input || 0) + (totalStats.output || 0));
    el.innerHTML =
      '<div class="cxai-usage-row"><span class="cxai-usage-dot is-cur"></span><span>本次: ' + sessionUsage.calls + ' 次 · ' + curTokens + ' tokens · <b style="color:#2563eb;">¥' + (sessionUsage.cost || 0).toFixed(4) + '</b></span></div>'
      + '<div class="cxai-usage-row" style="color:#64748b;"><span class="cxai-usage-dot is-all"></span><span>累计: ' + (totalStats.calls || 0) + ' 次 · ' + allTokens + ' tokens · <b style="color:#059669;">¥' + (totalStats.cost || 0).toFixed(4) + '</b>'
      + ' <button type="button" class="cxai-usage-reset" id="cxai-btn-reset-stats">清零</button></span></div>';
    var resetBtn = el.querySelector('#cxai-btn-reset-stats');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        totalStats = { input: 0, output: 0, cost: 0, calls: 0 };
        var o = {}; o[K.STATS] = totalStats;
        storageSet(o);
        updateUsageUI();
        toast('累计费用统计已清零', 'info');
      });
    }
  }

  function isImageOnlyTask(td) {
    if (!td || td.type !== 1 || !Array.isArray(td.rules) || td.rules.length === 0) return false;
    return !td.rules.some(function (r) {
      var exts = r && Array.isArray(r.extensions) ? r.extensions.join(',').toLowerCase() : '';
      return /doc|docx|pdf|txt|md/.test(exts) || r.category === 'document';
    });
  }

  function buildImagePromptDraft(td) {
    var title = (td && td.title) ? td.title.trim() : '课程主题画作';
    var req = (td && td.requirement) ? td.requirement.trim() : '';
    return '创作一幅高质量插画/画作，主题为「' + title + '」。'
      + (req ? ('具体要求：' + req + '。') : '')
      + '构图饱满、色彩和谐、细节丰富、富有艺术感染力，画面中不要出现乱码文字或水印。';
  }

  function renderEvalCard(evalResult) {
    if (!evalCardEl || !evalResult || evalResult.status !== 'success') return;
    var fb = evalResult.feedback || {};
    var dims = Array.isArray(fb.dimensions) ? fb.dimensions : [];
    var dimHtml = dims.map(function (d) {
      var lowCls = (typeof d.score === 'number' && d.score < 20) ? ' is-low' : '';
      return '<span class="cxai-eval-dim' + lowCls + '">' + escHtml(d.name) + ' <b>' + escHtml(String(d.score)) + '</b></span>';
    }).join('');

    var detailParts = [];
    if (fb.advantage) detailParts.push('<p><span class="cxai-fb-tag is-good">优点</span>' + escHtml(fb.advantage) + '</p>');
    if (fb.shortcoming) detailParts.push('<p><span class="cxai-fb-tag is-warn">不足</span>' + escHtml(fb.shortcoming) + '</p>');
    if (Array.isArray(fb.suggestions) && fb.suggestions.length > 0) {
      detailParts.push('<p><span class="cxai-fb-tag is-tip">建议</span>' + escHtml(fb.suggestions.join('；')) + '</p>');
    }
    if (detailParts.length === 0 && fb.rawText) {
      detailParts.push('<p>' + escHtml(truncate(fb.rawText, 300)) + '</p>');
    }

    evalCardEl.innerHTML =
      '<div class="cxai-eval-head">'
      + '<span class="cxai-eval-title">' + cxIcon('award', 14) + '<span>评估结果摘要</span></span>'
      + '<span class="cxai-eval-total">' + escHtml(String(evalResult.score)) + ' 分</span>'
      + '</div>'
      + (dimHtml ? ('<div class="cxai-eval-dims">' + dimHtml + '</div>') : '')
      + (detailParts.length ? ('<div class="cxai-eval-detail">' + detailParts.join('') + '</div>') : '');
    evalCardEl.classList.add('cxai-open');
    if (typeof evalCardEl.scrollIntoView === 'function') {
      setTimeout(function () { evalCardEl.scrollIntoView({ block: 'nearest' }); }, 60);
    }
  }

  function formatTokens(n) {
    if (n < 1000) return n + '';
    if (n < 1e6) return (n / 1000).toFixed(1) + 'K';
    return (n / 1e6).toFixed(2) + 'M';
  }

  // ==================== 执行历史 ====================

  function saveHistory(record) {
    record.time = new Date().toLocaleString('zh-CN', { hour12: false });
    storageGet([K.HISTORY], function (r) {
      var list = r[K.HISTORY] || [];
      list.unshift(record);
      if (list.length > L.MAX_HISTORY) list = list.slice(0, L.MAX_HISTORY);
      var setObj = {}; setObj[K.HISTORY] = list;
      storageSet(setObj);
      renderHistory(list);
    });
  }

  function extractTaskIdentityKeys(rawUrl) {
    var keys = [];
    if (!rawUrl) return keys;
    try {
      var u = new URL(String(rawUrl), location.origin);
      var rel = u.searchParams.get('publishRelationUuid');
      if (rel) keys.push('ai:' + rel.toLowerCase());
      var bbsPath = u.pathname.match(/\/bbs\/([^/?#]+)\/([^/?#]+)/);
      if (bbsPath) {
        keys.push('discuss:' + decodeURIComponent(bbsPath[1]) + ':' + decodeURIComponent(bbsPath[2]));
      } else {
        var bbsid = u.searchParams.get('bbsid');
        var uuid = u.searchParams.get('uuid');
        if (bbsid && uuid) keys.push('discuss:' + bbsid + ':' + uuid);
      }
      var cleanUrl = u.origin + u.pathname;
      keys.push('path:' + cleanUrl);
    } catch (e) {
      keys.push('raw:' + String(rawUrl));
    }
    return keys;
  }

  function markTaskDoneInScanCache(taskUrl, scoreVal) {
    var targetKeys = extractTaskIdentityKeys(taskUrl || location.href);
    if (targetKeys.length === 0) return;
    storageGet([K.SCAN_CACHE, K.BATCH_TASKS], function (r) {
      var patchTaskList = function (arr) {
        if (!Array.isArray(arr)) return false;
        var changed = false;
        arr.forEach(function (t) {
          if (!t || !t.url) return;
          var keys = extractTaskIdentityKeys(t.url);
          var hit = keys.some(function (k) { return targetKeys.indexOf(k) !== -1; });
          if (!hit) return;
          var numScore = (scoreVal !== undefined && scoreVal !== null && scoreVal !== '✓') ? Number(scoreVal) : NaN;
          if (!isNaN(numScore)) t.answerScore = numScore;
          var reach = t.reachStandard ? Number(t.reachStandard) : 0;
          if (!isNaN(numScore) && reach > 0 && numScore < reach) {
            t.isFinish = false;
            t.belowStandard = true;
          } else {
            t.isFinish = true;
            t.isEnded = false;
            t.belowStandard = false;
            if (scoreVal === '✓') t.replied = true;
          }
          changed = true;
        });
        return changed;
      };
      var cache = r[K.SCAN_CACHE];
      var batchTasks = r[K.BATCH_TASKS];
      var cChanged = cache && Array.isArray(cache.tasks) ? patchTaskList(cache.tasks) : false;
      var bChanged = Array.isArray(batchTasks) ? patchTaskList(batchTasks) : false;
      if (cChanged || bChanged) {
        var out = {};
        if (cChanged) out[K.SCAN_CACHE] = cache;
        if (bChanged) out[K.BATCH_TASKS] = batchTasks;
        storageSet(out);
      }
    });
  }

  function renderHistory(list) {
    var el = panelEl ? panelEl.querySelector('#cxai-history-list') : null;
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = '<div class="cxai-history-empty">暂无执行记录<br/>完成一次任务后会自动记录在此</div>';
      return;
    }
    var modeMeta = {
      chat: { label: '对话', cls: '' },
      file: { label: '文档', cls: 'is-file' },
      discuss: { label: '讨论', cls: 'is-discuss' },
      code: { label: '代码', cls: 'is-code' },
      ladder: { label: '阶梯', cls: 'is-ladder' }
    };
    function scoreCls(s) {
      if (s === 'ERR') return 'err';
      if (s === '✓') return 'done';
      var n = parseInt(s);
      if (isNaN(n)) return 'done';
      if (n >= 90) return 'high';
      if (n >= 70) return 'mid';
      return 'low';
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      var meta = modeMeta[h.taskMode] || { label: '任务', cls: '' };
      html += '<div class="cxai-history-item">'
        + '<div class="cxai-history-left">'
        + '<span class="cxai-history-tag ' + meta.cls + '">' + meta.label + '</span>'
        + '<span class="cxai-history-title" title="' + escHtml(h.title || '') + '">' + escHtml(truncate(h.title || '未知', 18)) + '</span>'
        + '</div>'
        + '<div class="cxai-history-right">'
        + '<span class="cxai-score-badge ' + scoreCls(h.score) + '">' + escHtml(String(h.score)) + '</span>'
        + '<span class="cxai-history-time">' + escHtml((h.time || '').replace(/^\d{4}\//, '')) + '</span>'
        + '</div></div>';
    }
    el.innerHTML = html;
  }

  // ==================== DeepSeek ====================

  function getRoundStrategy(current, total) {
    if (total <= 2) return '';
    const ratio = current / total;
    // 每轮通用纪律：结尾必问一个具体问题（对应提分点"主动体现/提问"）
    var askRule = '\n- 本轮回复结尾必须抛出一个具体、可深入的问题（避免空泛的"您觉得呢"）';
    if (ratio < 0.34) {
      return '\n\n【当前阶段：切入(第' + (current + 1) + '/' + total + '轮)】\n'
        + '- 开场即主动抛出你对本主题的预习框架（核心概念+技术栈关联），引导对方按你的节奏推进\n'
        + '- 用专业术语精准描述理解，主动关联相关技术点展示知识面\n'
        + '- 复述对方讲解的关键点并做一层扩展，而非简单附和'
        + askRule;
    } else if (ratio < 0.67) {
      return '\n\n【当前阶段：深入(第' + (current + 1) + '/' + total + '轮)】\n'
        + '- 复述对方刚讲解的命令/操作要点，再补充你想到的扩展场景或边界条件\n'
        + '- 用实际操作命令、参数或代码片段验证理解，体现动手能力\n'
        + '- 对比不同方案的优劣与适用场景，体现工程思维\n'
        + '- 主动覆盖任务要求中尚未提及的技术点'
        + askRule;
    } else {
      return '\n\n【当前阶段：收尾(第' + (current + 1) + '/' + total + '轮)】\n'
        + '- 体系化串讲所讨论的技术要点，形成完整知识框架（分层/分模块）\n'
        + '- 结合一个具体落地场景说明如何应用，指出可能的坑\n'
        + '- 对仍存疑的边界点提问，体现深度思考'
        + askRule;
    }
  }

  // 任务类型自适应检测
  const TASK_TYPES = {
    tech: {
      keywords: ['git', 'java', 'python', 'c++', 'c语言', 'html', 'css', 'javascript', 'sql', 'mysql', 'linux', '数据库', '编程', '开发', '框架', 'spring', 'vue', 'react', 'docker', 'kubernetes', 'api', '算法', '数据结构', '网络', 'tcp', 'http', '服务器', '前端', '后端', '运维', '部署', '测试', '代码', '版本控制', '操作系统', '云计算', 'ai', '人工智能', '机器学习', '深度学习', '大数据', 'hadoop', 'spark', '微服务', '安全', '加密', '网络安全', '渗透'],
      identity: '拥有极强计算机技术功底的专业人士，对底层原理和实操经验有深刻理解。',
      strategy: '【回复策略 - 高分关键】\n'
        + '1. 回复必须包含具体的技术细节：命令、参数、配置项、原理说明等\n'
        + '2. 主动展示动手实操能力：描述操作步骤和遇到的现象\n'
        + '3. 对对方的内容进行专业级别的复述和扩展，而不仅是简单附和\n'
        + '4. 用对比分析体现深度思考：不同方案的优劣、适用场景、底层原理差异\n'
        + '5. 主动关联任务要求中的所有技术点，确保覆盖完整\n'
        + '6. 回复长度150-300字，信息密度高，每句话都有技术含量',
      style: '- 自然流畅，像有经验的开发者在进行技术讨论\n'
        + '- 常用句式："我的实践经验是…""从底层原理看…""考虑到实际的性能开销…"'
    },
    business: {
      keywords: ['管理', '营销', '市场', '财务', '会计', '金融', '经济', '商业', '战略', '人力资源', '供应链', '项目管理', '风险', '投资', '预算', '绩效', '组织', '领导力', '团队', '决策', '商业模式', '创业', '运营', '品牌', '电商', '用户', '客户', '产品经理'],
      identity: '具备扎实商业理论框架与丰富实战视野的商界精英。',
      strategy: '【回复策略 - 高分关键】\n'
        + '1. 回复必须引用具体的管理理论、模型或框架（如SWOT、波特五力、PDCA等）\n'
        + '2. 用真实或贴近真实的企业案例佐证观点\n'
        + '3. 进行多维度分析：成本、效率、风险、可行性\n'
        + '4. 展示对行业趋势和最新商业实践的敏锐洞察\n'
        + '5. 主动关联任务要求中的所有知识点，确保覆盖完整\n'
        + '6. 回复长度150-300字，逻辑严密，论证有力',
      style: '- 像有丰富实战经验的管理咨询师或高管\n'
        + '- 常用句式："从商业模式的角度看…""结合行业最佳实践…""如果评估这项战略的投入产出比…"'
    },
    writing: {
      keywords: ['写作', '文案', '文学', '新闻', '报告', '论文', '策划', '文档', '编辑', '出版', '传媒', '公文', '公关', '广告', '新媒体', '短视频', '内容', '翻译', '语言', '英语', '日语', '演讲', '沟通', '表达', '叙事'],
      identity: '文字功底深厚、对传播心理与文本结构有精妙把控的资深内容创作者。',
      strategy: '【回复策略 - 高分关键】\n'
        + '1. 展示对文体规范和写作技巧的专业理解\n'
        + '2. 用具体的修辞手法、结构分析、受众心理分析来体现深度\n'
        + '3. 提出具体的优化思路和创造性重构方案\n'
        + '4. 引用经典作品或行业爆款作为参照对象\n'
        + '5. 主动关联任务要求中的所有写作要素，确保覆盖完整\n'
        + '6. 回复长度150-300字，文字精练，极具感染力',
      style: '- 像资深编辑或爆款策划人在探讨内容逻辑\n'
        + '- 常用句式："为了强化读者的共鸣…""如果将叙事结构调整为…""这种表达的张力在于…"'
    },
    design: {
      keywords: ['设计', 'ui', 'ux', 'photoshop', 'ps', 'illustrator', 'sketch', 'figma', '平面', '视觉', '交互', '用户体验', '原型', '色彩', '排版', '品牌设计', '包装', '3d', '建模', 'cad', '室内', '建筑', '动画', '影视', '摄影', '剪辑', 'pr', 'ae'],
      identity: '审美卓越、兼具艺术直觉与工程可行性的资深设计师。',
      strategy: '【回复策略 - 高分关键】\n'
        + '1. 融入具体的设计原则和方法论（如格式塔原理、设计思维等）\n'
        + '2. 引用优秀设计案例或前沿美学趋势佐证观点\n'
        + '3. 展示对设计工具和落地的深度理解\n'
        + '4. 从用户体验、视觉层次、信息传达等维度展开立体分析\n'
        + '5. 主动关联任务要求中的所有设计要素，确保覆盖完整\n'
        + '6. 回复长度150-300字，兼具美学高度与专业理性',
      style: '- 像资深设计总监在剖析作品思路\n'
        + '- 常用句式："从视觉层级的引导来看…""为了优化交互的微体验…""这种设计语言的核心是…"'
    }
  };

  function detectTaskTypeProfile(title, requirement, scene, openingMessage) {
    var titleText = String(title || '').toLowerCase();
    var reqText = String(requirement || '').toLowerCase();
    var sceneText = String(scene || '').toLowerCase();
    var openText = String(openingMessage || '').toLowerCase();

    var scores = {};
    for (var type in TASK_TYPES) {
      scores[type] = 0;
      var kws = TASK_TYPES[type].keywords || [];
      for (var i = 0; i < kws.length; i++) {
        var kw = String(kws[i] || '').toLowerCase();
        if (!kw) continue;
        if (titleText.indexOf(kw) !== -1) scores[type] += 3;
        if (reqText.indexOf(kw) !== -1) scores[type] += 2;
        if (sceneText.indexOf(kw) !== -1) scores[type] += 2;
        if (openText.indexOf(kw) !== -1) scores[type] += 1;
      }
    }

    var ranked = Object.keys(scores).map(function (k) {
      return { type: k, score: scores[k] };
    }).sort(function (a, b) {
      return b.score - a.score;
    });

    var top = ranked[0] || { type: 'tech', score: 0 };
    var second = ranked[1] || { type: '', score: 0 };
    var margin = top.score - second.score;
    var lowConfidence = top.score < 4 || margin < 2;

    return {
      type: top.type || 'tech',
      score: top.score || 0,
      secondScore: second.score || 0,
      margin: margin,
      lowConfidence: lowConfidence
    };
  }

  function detectTaskType(title, requirement, scene, openingMessage) {
    return detectTaskTypeProfile(title, requirement, scene, openingMessage).type;
  }

  // 角色推断辅助（优先使用页面显式提供的角色名）
  function inferRoles(scene, requirement, title, explicitRoles) {
    var expMy = explicitRoles && explicitRoles.myRole ? String(explicitRoles.myRole).trim() : '';
    var expAi = explicitRoles && explicitRoles.aiRole ? String(explicitRoles.aiRole).trim() : '';
    var combined = String(title || '') + '\n' + String(requirement || '') + '\n' + String(scene || '');

    var myRole = expMy || '任务执行者/参与者';
    var aiRole = expAi || '任务考官/对话对象';

    if (!expMy) {
      var myRoleMatch = combined.match(/(?:你(?:将)?(?:扮演|以)|你是|作为|你是一名?|你的身份是)([^，。！\n]{2,18}?)(?:的身份|参与|进行|$|[，。！\n])/);
      if (myRoleMatch && !myRoleMatch[1].includes('回答') && !myRoleMatch[1].includes('准备')) {
        myRole = myRoleMatch[1].trim();
      }
    }

    if (!expAi) {
      var aiRoleMatch = combined.match(/(?:AI(?:将)?扮演|对方是|面对(?:的)?是一名?|与一位)([^，。！\n]{2,18}?)(?:平等交流|交流|对话|$|[，。！\n])/);
      if (aiRoleMatch) {
        aiRole = aiRoleMatch[1].trim();
      } else if (!expMy) {
        if (combined.includes('学生') && combined.includes('老师')) {
          myRole = '学生'; aiRole = '老师';
        } else if (combined.includes('客服') && combined.includes('客户')) {
          myRole = combined.indexOf('你是客户') !== -1 ? '客户' : '客服';
          aiRole = myRole === '客服' ? '客户' : '客服';
        } else if (combined.includes('面试')) {
          myRole = '面试者'; aiRole = '面试官';
        } else if (combined.includes('同事')) {
          myRole = '职场员工'; aiRole = '同事/领导';
        }
      }
    }

    return { myRole: myRole, aiRole: aiRole };
  }

  function buildDeepSeekMessages(conversationHistory, taskInfo) {
    var profile = taskInfo.taskProfile || detectTaskTypeProfile(taskInfo.title, taskInfo.requirement, taskInfo.scene);
    var taskType = profile.type;
    var tp = TASK_TYPES[taskType] || TASK_TYPES.tech;
    var effectivePromptStyle = profile.lowConfidence ? 'balanced' : (taskInfo.promptStyle || 'balanced');

    // 动态提取角色关系（优先采用任务页明确标注的角色）
    var roles = inferRoles(taskInfo.scene, taskInfo.requirement, taskInfo.title, {
      myRole: taskInfo.myRole,
      aiRole: taskInfo.aiRole
    });

    var identityText = profile.lowConfidence
      ? '拥有极强综合素养与跨领域洞察力的专家。'
      : tp.identity;

    var strategyText = profile.lowConfidence
      ? '【回复策略 - 通用稳健】\n'
      + '1. 先确认题意与对话边界，避免偏题\n'
      + '2. 用“观点 + 依据 + 追问”结构推进，每轮至少一个有意义的抛论\n'
      + '3. 避免堆砌术语，切合当前身份与场景设定\n'
      + '4. 结合任务要求中的关键词，覆盖核心得分点\n'
      + '5. 回复长度120-220字，逻辑清晰具体'
      : tp.strategy;

    var styleText = profile.lowConfidence
      ? '- 语气自然、符合角色设定，避免说空话\n- 多提出有建设性的思考与可执行方案'
      : tp.style;

    const sys = '你现在正在完成一项在线情景实践对话任务。\n\n'
      + '【角色设定】\n'
      + '- 你的身份：' + roles.myRole + '\n'
      + '- 对方的身份：' + roles.aiRole + '\n'
      + '- 专业内核：' + identityText + ' (虽然你有特定的扮演身份，但你的回复质量必须极高，远超普通水准)\n\n'
      + '【任务背景】\n'
      + '任务主题：' + taskInfo.title + '\n'
      + '任务要求：' + taskInfo.requirement + '\n'
      + '场景描述：' + (taskInfo.scene || '(无特定场景)') + '\n\n'
      + '【核心纪律】绝对服从你的角色设定（' + roles.myRole + '），并以恰当的称谓与对方（' + roles.aiRole + '）交流。禁止破离角色。禁止说自己是AI或语言模型。\n'
      + '- 首轮即主动展示预习框架并抛出关键概念，引导对方按你的节奏推进；每轮结尾必抛一个具体可深入的问题\n\n'
      + strategyText + '\n'
      + '7. 直接输出你的回复台词，不要输出任何前缀（如“学生：”、“客服：”）、也不要加引号和动作括号\n\n'
      + '【语言风格】\n'
      + styleText + '\n'
      + '- 每句话都应推进当前情景的发展\n\n'
      + '【禁止事项】\n'
      + '- 绝对不能串演对方的角色\n'
      + '- 绝不示弱（不说“我完全不懂”、“我不会”），即使在请教对方也要展示自己深度的思考框架\n'
      + '- 对方回复很短时，你要主动抛出具有深度的扩展分析'
      + (PROMPT_STYLES[effectivePromptStyle] || '')
      + (taskInfo.roundInfo ? getRoundStrategy(taskInfo.roundInfo.current, taskInfo.roundInfo.total) : '')
      + (taskInfo.retryFeedback ? '\n\n【上次评估反馈 - 需改进】\n' + taskInfo.retryFeedback : '')
      + (taskInfo.customPrompt ? '\n\n【补充要求】\n' + taskInfo.customPrompt : '');

    const msgs = [{ role: 'system', content: sys }];
    for (const m of conversationHistory) {
      var role = m.role === 'assistant' ? 'user' : 'assistant';
      var content = (m.content || '').trim();
      if (!content) continue;
      // 合并连续同角色消息，避免 API 报错
      if (msgs.length > 0 && msgs[msgs.length - 1].role === role) {
        msgs[msgs.length - 1].content += '\n' + content;
      } else {
        msgs.push({ role: role, content: content });
      }
    }
    return msgs;
  }

  async function callDeepSeek(conversationHistory, taskInfo) {
    const messages = buildDeepSeekMessages(conversationHistory, taskInfo);
    return bgChat({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinkingMode: config.thinkingMode,
      messages,
    });
  }

  function buildFallbackReply(taskInfo, myRole) {
    if (myRole === '客服') return '您好，我已经了解了您的需求核心。为确保方案完全匹配，我为您梳理了以下几个落地要点，您看看是否与您的预期一致？如果您这边确认无误，我们可以马上推进下一步。';
    if (myRole === '老师') return '同学，你的思考方向很有价值。跳出表层概念，如果我们把这个现象放在真实的行业案例中去推演，你会发现什么不同的结果？我希望你能再深挖一下它的底层逻辑。';
    if (myRole === '面试者') return '针对这个问题，我在过去的项目中有过类似的实践。当时的核心难点在于平衡成本与效率。如果您允许，我想进一步从执行层面向您阐述我的解决方案框架。';
    return '关于刚才讨论的关键点，我已经梳理了底层逻辑。为了确保推演的严密性，我认为还可以从实际落地场景的盲区做进一步探讨。针对这一点，您有什么补充视角吗？';
  }

  async function callDeepSeekSafe(messages, taskInfo) {
    var roles = inferRoles(taskInfo.scene, taskInfo.requirement, taskInfo.title, {
      myRole: taskInfo.myRole,
      aiRole: taskInfo.aiRole
    });
    var maxAttempts = 3;
    
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      let reply = await callDeepSeek(messages, taskInfo);

      if (!reply || !reply.trim()) {
        if (attempt < maxAttempts) {
          log('⚠ DeepSeek 返回空回复，重试(' + attempt + '/' + maxAttempts + ')...', 'warn');
          continue;
        }
        break;
      }

      reply = reply.trim();
      
      // 不再强制检测"老师/同学"，因为角色多变
      // 仅清理可能存在的非法前缀（如"客服："、"学生："）
      reply = reply.replace(/^(?:学生|老师|客服|客户|面试官|面试者|同事)[：:]\s*/, '');

      if (reply && reply.trim()) return reply;
    }

    log('⚠ DeepSeek 多次生成失败，使用兜底回复', 'warn');
    return buildFallbackReply(taskInfo, roles.myRole);
  }

  // ==================== 测试连接 ====================

  function testConnection() {
    if (!isExtensionAlive()) {
      var staleMsg = normalizeRuntimeError('Extension context invalidated');
      log('❌ ' + staleMsg, 'error');
      toast(staleMsg, 'warn');
      return;
    }
    saveConfig();
    if (!config.apiKey) {
      log('❌ 请先填写 API Key', 'error');
      toast('请先填写 API Key', 'warn');
      return;
    }
    const testBtn = panelEl.querySelector('#cxai-btn-test');
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="cxai-spinner"></span> 测试中';
    log('正在测试 DeepSeek 连接...', 'info');

    runtimeSend({
      type: 'DEEPSEEK_TEST',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinkingMode: config.thinkingMode,
    }, (resp, err) => {
      testBtn.disabled = false;
      testBtn.innerHTML = cxIcon('plug', 13) + '<span>测试连接</span>';
      if (err) {
        var msg = normalizeRuntimeError(err);
        log('❌ 通信失败: ' + msg, 'error');
        toast('连接失败: ' + msg, 'error');
        return;
      }
      if (resp && resp.success) {
        log('✓ ' + resp.data, 'success');
        toast('连接成功', 'success');
      } else {
        var errMsg = resp ? resp.error : '未知错误';
        log('❌ ' + errMsg, 'error');
        toast('连接失败: ' + errMsg, 'error');
      }
    });
  }

  // ==================== 对话型任务 ====================

  async function runChatTask(st, detectedType, taskProfile, startFromRound) {
    var roles = inferRoles(st.scene, st.requirement, st.title, st);
    log('ROLE: 你的身份 → ' + roles.myRole, 'info');
    log('ROLE: 对方身份 → ' + roles.aiRole, 'info');
    log('STYLE: 当前风格 → ' + (PROMPT_STYLE_LABELS[config.promptStyle || 'balanced'] || (config.promptStyle || 'balanced')), 'info');

    // 新架构：未进入对话页时先点"开始对话"，并重新读取工程师开场白与角色
    if (isNewArchPage && !st.chatStarted) {
      log('EXEC: 点击"开始对话"进入对话页...', 'action');
      try {
        await pageCall('startChat');
        log('✓ 已进入对话页', 'success');
        const freshState = await pageCall('getState');
        st = Object.assign({}, st, freshState, {
          title: freshState.title || st.title,
          requirement: freshState.requirement || st.requirement,
          scene: freshState.scene || st.scene,
          myRole: freshState.myRole || st.myRole || '',
          aiRole: freshState.aiRole || st.aiRole || '',
          messages: freshState.messages || [],
          chatStarted: true
        });
        roles = inferRoles(st.scene, st.requirement, st.title, st);
      } catch (err) {
        log('⚠ 进入对话页失败: ' + normalizeRuntimeError(err), 'warn');
        return;
      }
    }

    let messages = st.messages || [];
    if (messages.length > 0 && !startFromRound) {
      log('✓ AI老师开场白: ' + truncate(messages[0].content, 60), 'chat-teacher');
    }

    const rounds = config.rounds;
    var resumeFrom = startFromRound || 0;
    const baseCtx = {
      title: st.title,
      requirement: st.requirement,
      scene: st.scene,
      myRole: st.myRole || roles.myRole,
      aiRole: st.aiRole || roles.aiRole,
      customPrompt: config.customPrompt,
      promptStyle: config.promptStyle,
      retryFeedback: config.retryFeedback || '',
      taskProfile: taskProfile || null
    };
    if (resumeFrom > 0) {
      log('\nRESUME: 从第' + (resumeFrom + 1) + '轮继续 (共' + rounds + '轮)', 'info');
    } else {
      log('\nEXEC: 开始自动对话 (' + rounds + ' 轮)', 'info');
    }

    for (let i = resumeFrom; i < rounds; i++) {
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      const pct = 5 + Math.round(((i + 1) / rounds) * 70);
      const phase = i < rounds * 0.34 ? '探索' : (i < rounds * 0.67 ? '深入' : '总结');
      log('\n── 第' + (i + 1) + '/' + rounds + '轮 [' + phase + '期] ──', 'info');

      const taskCtx = Object.assign({}, baseCtx, { roundInfo: { current: i, total: rounds } });
      setStatus('第 ' + (i + 1) + '/' + rounds + ' 轮 · AI 生成中', 'running');
      log('AI: DeepSeek 生成回复中...', 'info');
      const studentReply = await callDeepSeekSafe(messages, taskCtx);
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      log('READY: 回复已生成', 'success');

      if (i > 0 && config.delay > 0) {
        setStatus('第 ' + (i + 1) + '/' + rounds + ' 轮 · 冷却 ' + config.delay + 's', 'running');
        log('WAIT: ' + config.delay + 's...', 'info');
        await sleep(config.delay * 1000);
        if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      }

      if (!studentReply || !studentReply.trim()) {
        log('⚠ 学生回复为空，跳过本轮', 'warn');
        continue;
      }

      setStatus('第 ' + (i + 1) + '/' + rounds + ' 轮 · 等待老师回复', 'running');
      log('SEND: 学生 → ' + truncate(studentReply, 80), 'chat-student');
      log('EXEC: 发送消息给AI老师...', 'action');
      let result;
      try {
        result = await pageCall('sendMessage', { text: studentReply });
      } catch (err) {
        if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
        // 仅对 sendMessage 超时做恢复尝试；其他错误直接抛
        if (!/pageCall.*sendMessage.*超时/.test(err.message)) throw err;
        log('⚠ sendMessage 超时，尝试从页面状态恢复...', 'warn');
        // 超时后 page-inject 的流式可能仍在进行，或已完成但 reply 回调被丢弃
        // 轮询 getState 直接读 DOM，等最后一条 assistant 文本稳定后取用
        let recovered = null;
        let lastText = '';
        for (let r = 0; r < 6; r++) { // 最多再等 12s
          if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
          await sleep(2000);
          const freshState = await pageCall('getState');
          const freshMsgs = freshState.messages || [];
          const lastMsg = freshMsgs[freshMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
            const curText = lastMsg.content.trim();
            // 文本连续稳定且非空即认为流式已完成（兼容短回复）
            if (curText === lastText && curText.length > 0) {
              recovered = { response: curText, messages: freshMsgs };
              break;
            }
            lastText = curText;
          }
        }
        if (recovered) {
          log('✓ 超时恢复成功，已获取到 AI 回复', 'success');
          result = recovered;
        } else {
          throw err; // 真的没回复，重抛原错误
        }
      }
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      if (!result.response || !result.response.trim()) {
        log('⚠ 老师回复为空，3s后重试...', 'warn');
        await sleep(3000);
        if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
        const freshState = await pageCall('getState');
        const freshMsgs = freshState.messages || [];
        const lastMsg = freshMsgs[freshMsgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content && lastMsg.content.trim()) {
          result = { response: lastMsg.content, messages: freshMsgs };
          log('✓ 延迟获取到回复', 'success');
        } else {
          log('⚠ 老师回复仍为空，跳过本轮', 'warn');
          messages = result.messages;
          setProgress(pct);
          continue;
        }
      }

      log('RECV: 老师 → ' + truncate(result.response, 80), 'chat-teacher');
      messages = result.messages;
      setProgress(pct);

      // 收尾语检测：老师表示讲完/掌握则本轮后提前结束（config.rounds 仍作兜底上限）
      if (/讲完啦|完全掌握|没有.*要问|还有.*疑问|还有哪里|吃透|都讲完了|练习结束/.test(result.response)) {
        log('✓ 检测到老师收尾语，提前结束对话', 'success');
        break;
      }
    }
  }

  // ==================== 文件上传型任务 ====================

  function buildDocPrompt(title, requirement) {
    return '你是一个专业能力极强的大学生，正在完成一个课程实践作业。\n\n'
      + '任务主题：' + title + '\n'
      + '任务要求：' + requirement + '\n\n'
      + '请根据任务要求，生成一份高质量的实践报告/作业文档内容。\n\n'
      + '【格式要求】\n'
      + '1. 使用 Markdown 格式输出，包含清晰的标题层级（# ## ### 等）\n'
      + '2. 内容要专业、详实，展示你的实操过程和深入理解\n'
      + '3. 包含以下部分（根据任务灵活调整）：\n'
      + '   - 任务概述/背景\n'
      + '   - 实施步骤（详细的操作过程，命令、截图描述等）\n'
      + '   - 运行结果/实验现象\n'
      + '   - 分析与总结\n'
      + '   - 遇到的问题与解决方案（如有）\n'
      + '4. 字数 800-1500 字，内容充实但不冗余\n'
      + '5. 直接输出文档内容，不要加任何开头说明\n\n'
      + '【质量要求】\n'
      + '- 体现你真正动手做过，不是纸上谈兵\n'
      + '- 包含具体的命令输出、配置参数、版本信息等细节\n'
      + '- 分析部分要有深度，不要只是罗列步骤';
  }

  // ---- 纯 JS 实现 .docx 生成（OOXML ZIP 格式） ----

  function escXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function crc32(data) {
    var table = crc32.table;
    if (!table) {
      table = crc32.table = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function createZipBlob(files) {
    // files: [{name, content: Uint8Array}]  — STORE (无压缩)
    var parts = [], centralParts = [], offset = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var nameBytes = new TextEncoder().encode(f.name);
      var data = f.content;
      var crc = crc32(data);
      // Local file header
      var lh = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 0, true); // STORE
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);
      parts.push(lh, data);
      // Central directory
      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      centralParts.push(ch);
      offset += lh.length + data.length;
    }
    var cdSize = 0;
    for (var j = 0; j < centralParts.length; j++) cdSize += centralParts[j].length;
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(parts.concat(centralParts, [eocd]), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  function markdownToOoxml(md) {
    var lines = md.split('\n');
    var xml = '';
    var inCode = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) { inCode = !inCode; continue; }
      if (inCode) {
        xml += '<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr>'
          + '<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="20"/></w:rPr>'
          + '<w:t xml:space="preserve">' + escXml(line) + '</w:t></w:r></w:p>';
        continue;
      }
      var m;
      if ((m = line.match(/^(#{1,3}) (.+)$/))) {
        var lvl = m[1].length;
        var sz = lvl === 1 ? '36' : (lvl === 2 ? '30' : '26');
        xml += '<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>'
          + '<w:r><w:rPr><w:b/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>'
          + '<w:t>' + escXml(m[2]) + '</w:t></w:r></w:p>';
      } else if ((m = line.match(/^[-*]\s+(.+)$/))) {
        xml += '<w:p><w:pPr><w:ind w:left="720"/></w:pPr>'
          + '<w:r><w:t xml:space="preserve">\u2022 ' + escXml(processInline(m[1])) + '</w:t></w:r></w:p>';
      } else if ((m = line.match(/^(\d+)\.\s+(.+)$/))) {
        xml += '<w:p><w:pPr><w:ind w:left="720"/></w:pPr>'
          + '<w:r><w:t xml:space="preserve">' + m[1] + '. ' + escXml(processInline(m[2])) + '</w:t></w:r></w:p>';
      } else if (!line.trim()) {
        xml += '<w:p/>';
      } else {
        xml += '<w:p><w:r><w:t xml:space="preserve">' + escXml(processInline(line)) + '</w:t></w:r></w:p>';
      }
    }
    return xml;
  }

  function processInline(text) {
    return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  }

  function buildDocxFiles(markdownContent) {
    var enc = new TextEncoder();
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>';
    var wordRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
    var bodyXml = markdownToOoxml(markdownContent);
    var docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<w:body>' + bodyXml
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
      + '</w:sectPr></w:body></w:document>';
    return [
      { name: '[Content_Types].xml', content: enc.encode(contentTypes) },
      { name: '_rels/.rels', content: enc.encode(rels) },
      { name: 'word/_rels/document.xml.rels', content: enc.encode(wordRels) },
      { name: 'word/document.xml', content: enc.encode(docXml) }
    ];
  }

  function docxBlobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var b64 = reader.result.split(',')[1];
        resolve(b64);
      };
      reader.onerror = function () { reject(new Error('Blob读取失败')); };
      reader.readAsDataURL(blob);
    });
  }

  async function runFileTask(st, detectedType) {
    if (Array.isArray(st.rules) && st.rules.length > 0) {
      var allowDoc = st.rules.some(function (r) {
        var exts = r && Array.isArray(r.extensions) ? r.extensions.join(',').toLowerCase() : '';
        return /doc|docx|pdf|txt|md/.test(exts) || r.category === 'document';
      });
      if (!allowDoc) {
        var allowedExts = st.rules.map(function (r) { return (r.extensions || []).join('/'); }).filter(Boolean).join(', ');
        throw new Error('该任务仅允许上传 [' + (allowedExts || '图片/指定格式') + ']，不支持自动生成 .docx 上传');
      }
    }

    setStatus('正在生成实践文档...', 'running');
    log('\nGEN: 使用 DeepSeek 生成文档内容...', 'info');
    setProgress(10);

    // 构建文档生成提示词
    var docPrompt = buildDocPrompt(st.title, st.requirement);
    if (config.customPrompt) {
      docPrompt += '\n\n【补充要求】\n' + config.customPrompt;
    }
    if (config.retryFeedback) {
      docPrompt += '\n\n【上次评估反馈 - 请针对性改进】\n' + config.retryFeedback
        + '\n注意：这次要重点改进上述不足，优化文档质量。';
    }

    var docContent = await bgChat({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      messages: [
        { role: 'system', content: docPrompt },
        { role: 'user', content: '请根据任务要求生成完整的实践报告文档。' }
      ],
      maxTokens: T.DEEPSEEK_DOC_MAX_TOKENS
    });
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
    if (!docContent || !docContent.trim()) throw new Error('DeepSeek 返回内容为空');

    log('GEN: 文档内容已生成 (' + docContent.length + ' 字)', 'success');
    log('PREVIEW: ' + truncate(docContent, 120), 'info');
    setProgress(40);

    // 生成 .docx (OOXML ZIP)
    log('\nBUILD: 构建 .docx 文档...', 'info');
    var docxFiles = buildDocxFiles(docContent);
    var docxBlob = createZipBlob(docxFiles);
    var b64 = await docxBlobToBase64(docxBlob);
    var fileName = (st.title || '实践报告').replace(/[\\/:*?"<>|]/g, '_') + '.docx';
    log('BUILD: ' + fileName + ' (' + Math.round(b64.length * 3 / 4 / 1024) + 'KB)', 'success');
    setProgress(50);

    // 上传文件
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
    setStatus('正在上传 .docx 文档...', 'running');
    log('\nUPLOAD: 上传文件到超星...', 'info');
    var uploadResult = await pageCall('uploadFile', { fileData: b64, fileName: fileName });
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

    if (uploadResult.status === 'success') {
      log('UPLOAD: 文件上传成功 → ' + uploadResult.fileName, 'success');
      log('UPLOAD: 文件ID: ' + uploadResult.fileObjectId + ', 解析状态: ' + (uploadResult.fileParseStatus || 'N/A'), 'info');
    } else {
      throw new Error('文件上传失败: ' + JSON.stringify(uploadResult));
    }
    setProgress(75);

    // 等待可以评估
    setStatus('等待文档解析完成...', 'running');
    log('WAIT: 等待文件解析完成...', 'info');
    var parsePollMs = 2000;
    var parseMaxIter = Math.ceil(T.FILE_PARSE / parsePollMs);
    var waitCount = 0;
    while (waitCount < parseMaxIter) {
      await sleep(parsePollMs);
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      var checkSt = await pageCall('getState');
      if (checkSt.canStartEvaluate) {
        log('READY: 文件解析完成，可以评估', 'success');
        break;
      }
      waitCount++;
      if (waitCount % 5 === 0) log('WAIT: 仍在解析... (' + waitCount * 2 + 's)', 'info');
    }
    if (waitCount >= parseMaxIter) throw new Error('文件解析超时(' + Math.round(T.FILE_PARSE / 1000) + 's)');
    setProgress(80);
  }

  // ==================== 主题讨论任务 ====================

  function buildDiscussPrompt(topicTitle, topicContent) {
    var lenKey = config.discussLength || 'medium';
    var lenRange = (DISCUSS_LENGTHS[lenKey] || DISCUSS_LENGTHS.medium).range;
    return '你是一名认真且有独立见解的大学生，正在参与一个课程的主题讨论。\n\n'
      + '【讨论话题】\n'
      + (topicTitle ? '标题：' + topicTitle + '\n' : '')
      + '内容：' + (topicContent || topicTitle || '(按标题发表见解)') + '\n\n'
      + '【要求】\n'
      + '1. 以大学生身份发表你对该话题的看法和理解\n'
      + '2. 观点要有深度，结合所学知识和实际案例分析\n'
      + '3. 结构清晰：先表明核心观点，再展开论述（2-3个要点），最后总结\n'
      + '4. 字数控制在' + lenRange + '字，不要太长也不要敷衍\n'
      + '5. 语言自然、有个人见解，避免空话套话和AI味\n'
      + '6. 不要使用markdown格式、列表符号，用纯文本自然段落表达\n'
      + '7. 直接输出你的讨论回复内容，不要加任何前缀';
  }

  async function runDiscussTask() {
    if (isRunning) return;
    isRunning = true;
    aborted = false;
    collapseSettingsIfOpen();
    logEl.innerHTML = '';
    updateButtons();

    try {
      if (!config.apiKey) throw new Error('请先设置 DeepSeek API Key');
      setStatus('正在读取讨论话题...', 'running');
      setProgress(0);

      // 1. 读取话题内容
      log('INIT: 读取讨论话题...', 'info');
      const st = await pageCall('getDiscussState');

      if (!st.topicContent && !st.topicTitle) {
        throw new Error('无法读取话题内容，请检查页面是否已加载完成');
      }

      log('TOPIC: ' + truncate(st.topicTitle || st.topicContent, 80), 'success');

      if (st.hasReplied) {
        log('⚠ 检测到你可能已经回复过此话题', 'warn');
      }
      if (!st.canReply) {
        throw new Error('页面上找不到回复输入框，无法自动回复');
      }

      setProgress(10);

      // 2. 构建提示词并调用 DeepSeek
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      setStatus('AI 正在生成回复...', 'running');
      log('AI: DeepSeek 生成回复中...', 'info');

      var prompt = buildDiscussPrompt(st.topicTitle, st.topicContent);
      if (config.customPrompt) {
        prompt += '\n\n【补充要求】\n' + config.customPrompt;
      }

      var replyText = await bgChat({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || DEFAULT_CONFIG.baseUrl,
        model: config.model || DEFAULT_CONFIG.model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: '请对以上话题发表你的看法。' }
        ],
        maxTokens: T.DEEPSEEK_DEFAULT_MAX_TOKENS
      });

      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      if (!replyText || !replyText.trim()) {
        throw new Error('DeepSeek 返回内容为空');
      }

      // 清理可能的前缀
      replyText = replyText.trim().replace(/^(?:回复|我的看法|我认为)[：:]\s*/i, '');
      log('READY: 回复已生成 (' + replyText.length + '字)', 'success');
      log('REPLY: ' + truncate(replyText, 120), 'chat-student');
      setProgress(50);

      // 3. 提交回复
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      setStatus('正在填写并提交...', 'running');
      log('SUBMIT: 填写并提交回复...', 'action');
      await sleep(1000);

      var submitResult = await pageCall('submitDiscussReply', { text: replyText });

      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      setProgress(100);

      if (submitResult.status === 'success') {
        log('\nDONE: 讨论回复已提交成功！', 'success');
        setStatus('DONE', 'done');
        toast('讨论回复已提交', 'success');
        saveHistory({ title: st.topicTitle || '主题讨论', score: '✓', type: 'discuss', rounds: 1, taskMode: 'discuss' });
        markTaskDoneInScanCache(location.href, '✓');
      } else {
        log('⚠ 提交结果: ' + JSON.stringify(submitResult), 'warn');
        setStatus('SUBMIT_ERR', 'error');
      }

    } catch (err) {
      log('\n❌ ' + normalizeRuntimeError(err), 'error');
      setStatus('ERROR', 'error');
      console.error('[ChaoxingAI]', err);
    } finally {
      isRunning = false;
      updateButtons();
    }
  }

  // ==================== 代码编辑型任务 ====================

  function buildCodePrompt(title, requirement, languageName) {
    return '你是一名资深软件工程师，正在完成一个编程实践作业。\n\n'
      + '【任务主题】\n' + title + '\n\n'
      + '【任务要求】\n' + requirement + '\n\n'
      + '【编程语言】\n' + (languageName || '根据任务要求自动选择') + '\n\n'
      + '【要求】\n'
      + '1. 直接输出完整的可运行代码，不要输出任何解释说明\n'
      + '2. 代码必须包含必要的注释（中文注释）\n'
      + '3. 代码必须符合该语言的编码规范\n'
      + '4. 如果任务要求特定格式（如XML配置文件），严格按照要求的格式输出\n'
      + '5. 不要使用 markdown 代码块格式（不要 ```），直接输出纯代码\n'
      + '6. 确保代码语法正确，可以直接运行或编译\n'
      + '7. 如果任务涉及数据库操作，使用标准 SQL 语法\n'
      + '8. 如果任务涉及框架配置，遵循该框架的标准配置格式';
  }

  function inferCodeLanguage(requirement, title, langList) {
    var text = (requirement + ' ' + title).toLowerCase();
    var langKeywords = {
      'Java': ['java', 'spring', 'mybatis', 'hibernate', 'maven', 'gradle', 'servlet', 'jsp'],
      'Python3.12.12': ['python3', 'python 3', 'django', 'flask', 'pandas', 'numpy'],
      'Python3.6.9': ['python3.6', 'python 3.6'],
      'Python2': ['python2', 'python 2'],
      'C': [' c ', 'clang', 'gcc', 'stdio.h', 'stdlib.h'],
      'C++': ['c++', 'cpp', 'iostream', 'vector', 'algorithm', 'stl'],
      'C#': ['c#', 'csharp', '.net', 'asp.net', 'visual studio'],
      'JavaScript': ['javascript', 'js', 'node', 'react', 'vue', 'angular', 'typescript'],
      'Golang': ['golang', 'go语言', 'go 语言'],
      'MySQL': ['mysql', 'sql', '数据库查询', 'select ', 'insert ', 'update ', 'delete '],
      'HTML': ['html', '网页', '标签'],
      'CSS': ['css', '样式', '布局'],
      'Bash': ['bash', 'shell', '脚本'],
    };

    for (var lang in langKeywords) {
      var keywords = langKeywords[lang];
      for (var i = 0; i < keywords.length; i++) {
        if (text.indexOf(keywords[i]) !== -1) {
          for (var key in langList) {
            if (langList[key].codeName === lang) return langList[key];
          }
        }
      }
    }
    for (var k in langList) {
      if (langList[k].codeName === 'Java') return langList[k];
    }
    return null;
  }

  async function runCodeTask(st) {
    var langList = st.langList || {};
    var langInfo = inferCodeLanguage(st.requirement, st.title, langList);
    var langName = langInfo ? langInfo.codeName : 'Java';
    var langCodeNum = langInfo ? langInfo.codeNum : 3;

    log('LANG: 推断语言 → ' + langName + ' (codeNum=' + langCodeNum + ')', 'info');
    setProgress(5);

    log('\nGEN: 使用 DeepSeek 生成代码...', 'info');
    var codePrompt = buildCodePrompt(st.title, st.requirement, langName);
    if (config.customPrompt) {
      codePrompt += '\n\n【补充要求】\n' + config.customPrompt;
    }
    if (config.retryFeedback) {
      codePrompt += '\n\n【上次评估反馈 - 请针对性改进】\n' + config.retryFeedback;
    }

    var codeContent = await bgChat({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      messages: [
        { role: 'system', content: codePrompt },
        { role: 'user', content: '请根据任务要求生成完整的代码。' }
      ],
      maxTokens: T.DEEPSEEK_DOC_MAX_TOKENS
    });

    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
    if (!codeContent || !codeContent.trim()) throw new Error('DeepSeek 返回内容为空');

    codeContent = codeContent.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();

    log('GEN: 代码已生成 (' + codeContent.length + ' 字符)', 'success');
    log('PREVIEW: ' + truncate(codeContent, 120), 'info');
    setProgress(30);

    log('\nLANG: 设置编程语言 → ' + langName, 'info');
    var langResult = await pageCall('setLanguage', { codeNum: langCodeNum });
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
    log('LANG: ' + langResult.languageName + ' 已设置', 'success');
    setProgress(40);

    // Wait for UI to settle after language selection
    await sleep(1000);
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

    log('CODE: 填入代码...', 'info');
    var codeResult = await pageCall('setCode', { code: codeContent });
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
    log('CODE: 代码已填入 (' + codeResult.length + ' 字符)', 'success');
    setProgress(50);

    await sleep(1500);
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

    log('\nEVAL: 提交代码评估...', 'info');
    setProgress(60);
    await pageCall('evaluateCode');
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

    // Poll for evaluation result via getState
    log('EVAL: 等待评估结果...', 'info');
    var evalWaited = 0;
    var evalMax = 180000;
    var evalPoll = 2000;
    var evalResult = null;

    while (evalWaited < evalMax) {
      await sleep(evalPoll);
      evalWaited += evalPoll;
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      var checkSt = await pageCall('getState');
      if (checkSt.evaluateStatus == 2) {
        var result = checkSt.evaluateResult || {};
        // score 可能是数字或 {score: N} 对象
        var score = (result.score && typeof result.score === 'object' ? result.score.score : result.score)
          || result.totalScore
          || checkSt.recordScore
          || checkSt.answerScore
          || '未知';
        evalResult = { status: 'success', score: score, evaluateResult: result };
        log('EVAL: 评估完成，得分: ' + score, 'success');
        break;
      } else if (checkSt.evaluateStatus == -1) {
        throw new Error('代码评估失败');
      }

      if (evalWaited % 10000 === 0) {
        log('EVAL: 仍在评估... (' + Math.round(evalWaited / 1000) + 's)', 'info');
      }
    }

    if (!evalResult) throw new Error('代码评估超时(' + Math.round(evalMax / 1000) + 's)');
    setProgress(100);

    return evalResult;
  }

  // ==================== AI思维阶梯任务 ====================

  var LADDER_STATE_KEY = 'cxai_ladder_state';

  function buildThinkLadderPrompt(question, requirement) {
    var optionsText = question.options.map(function(o) {
      return o.option + '. ' + o.optionContent;
    }).join('\n');

    return '请直接输出答案字母（如A或AC），不要输出任何其他内容。\n\n'
      + '题目：' + question.stem + '\n\n'
      + '选项：\n' + optionsText + '\n'
      + '提示：' + question.knowledgePoint + ' - ' + question.type;
  }

  async function runThinkLadderTask(st) {
    var state = await pageCall('getThinkLadderState');
    log('TASK: AI思维阶梯', 'info');

    if (!state.currentQuestion || !state.currentQuestion.stem) {
      log('DONE: 没有待答题目，任务完成', 'success');
      return { status: 'success', score: '✓' };
    }

    var question = state.currentQuestion;
    setProgress(10);

    log('\n── [' + question.type + '] ──', 'info');
    log('DIMENSION: ' + question.dimension, 'info');
    log('TOPIC: ' + question.knowledgePoint, 'info');
    log('STEM: ' + truncate(question.stem, 80), 'info');

    // 使用DeepSeek分析（思维阶梯只需单字母答案，关闭思考模式避免耗尽 token）
    log('AI: DeepSeek 分析中...', 'info');
    var aiAnswer = await bgChat({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinkingMode: 'none',
      messages: [
        { role: 'system', content: buildThinkLadderPrompt(question, st.requirement) },
        { role: 'user', content: '正确答案是？' }
      ],
      maxTokens: 200
    });

    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

    // 重试空回复
    if (!aiAnswer || !aiAnswer.trim()) {
      log('⚠ DeepSeek 返回空，重试...', 'warn');
      aiAnswer = await bgChat({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        thinkingMode: 'none',
        messages: [
          { role: 'system', content: buildThinkLadderPrompt(question, st.requirement) },
          { role: 'user', content: '直接给答案字母' }
        ],
        maxTokens: 50
      });
    }

    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

    var answer = aiAnswer ? aiAnswer.trim().match(/^[A-E]+/) : null;
    var finalAnswer = answer ? answer[0] : 'A';
    log('ANSWER: ' + finalAnswer, 'success');
    setProgress(40);

    // 通过sendMessage发送答案
    log('SEND: 提交答案...', 'action');
    var sendResult = await pageCall('sendThinkLadderAnswer', { answer: finalAnswer });
    if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

    setProgress(80);

    if (sendResult && sendResult.status === 'success') {
      if (sendResult.isCorrect) log('✓ 回答正确！', 'success');
      else if (sendResult.isWrong) log('✗ 回答错误', 'warn');
    }

    setProgress(100);

    // 保存状态，页面刷新后自动继续
    var saveObj = {}; saveObj[LADDER_STATE_KEY] = { count: 1 };
    storageSet(saveObj);

    return { status: 'success', score: '✓' };
  }

  function checkThinkLadderAutoStart() {
    storageGet([LADDER_STATE_KEY], function(r) {
      var state = r[LADDER_STATE_KEY];
      if (!state || !state.count) return;

      // 清除状态
      var o = {}; o[LADDER_STATE_KEY] = null;
      storageSet(o);

      log('LADDER: 自动继续下一题...', 'info');
      setTimeout(function() {
        if (!isRunning) {
          runTaskWithRetry();
        }
      }, T.RUN_RETRY_AUTO_DELAY);
    });
  }

  // ==================== 主流程 ====================

  function collapseSettingsIfOpen() {
    if (!panelEl) return;
    var body = panelEl.querySelector('#cxai-settings-body');
    var toggle = panelEl.querySelector('#cxai-settings-toggle');
    if (body && body.classList.contains('cxai-open')) {
      body.classList.remove('cxai-open');
      if (toggle) toggle.classList.remove('cxai-open');
    }
  }

  async function continueAutoTask() {
    if (isRunning) return;
    isRunning = true;
    aborted = false;
    collapseSettingsIfOpen();
    updateButtons();

    try {
      if (!config.apiKey) throw new Error('请先设置 DeepSeek API Key');
      setStatus('RUNNING', 'running');

      log('\nRESUME: 读取当前任务状态...', 'info');
      const st = await pageCall('getState');
      log('LOAD: 任务 → ' + st.title, 'success');
      renderTaskInfo(st);

      if (st.recordStatus === 1 || st.recordStatus === 2) {
        throw new Error('当前任务已提交/已评估，无法继续');
      }

      var isFileTask = (st.type === 1);
      var isCodeTask = (st.type === 4);
      var isThinkLadderTask = (st.type === 2);
      if (isFileTask) {
        throw new Error('文件型任务不支持继续，请重新开始');
      }
      if (isCodeTask) {
        throw new Error('代码型任务不支持继续，请重新开始');
      }
      if (isThinkLadderTask) {
        throw new Error('思维阶梯任务不支持继续，请重新开始');
      }

      // 计算已完成的对话轮数：页面上学生发言的次数
      var existingMsgs = st.messages || [];
      var completedRounds = 0;
      for (var mi = 0; mi < existingMsgs.length; mi++) {
        if (existingMsgs[mi].role === 'user') completedRounds++;
      }

      var totalRounds = config.rounds;
      if (completedRounds >= totalRounds) {
        log('RESUME: 已完成 ' + completedRounds + '/' + totalRounds + ' 轮，直接进入提交', 'info');
      } else {
        log('RESUME: 已完成 ' + completedRounds + '/' + totalRounds + ' 轮，继续剩余 ' + (totalRounds - completedRounds) + ' 轮', 'info');
      }

      var openingMsg = existingMsgs.length > 0 ? existingMsgs[0].content : '';
      var taskProfile = detectTaskTypeProfile(st.title, st.requirement, st.scene, openingMsg);
      var detectedType = taskProfile.type;

      if (completedRounds < totalRounds) {
        await runChatTask(st, detectedType, taskProfile, completedRounds);
      }

      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      // 提交 + 评估
      setStatus('正在提交并 AI 评估...', 'running');
      log('\nSUBMIT: 提交作答并开始AI评估...', 'info');
      await sleep(1500);
      setProgress(85);

      const evalResult = await pageCall('submitEvaluate');
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      setProgress(100);

      lastFeedback = null;
      if (evalResult.status === 'success') {
        log('\nDONE: 评估完成。最终得分: ' + evalResult.score, 'success');
        setStatus('DONE · ' + evalResult.score, 'done');
        toast('任务完成 · 得分 ' + evalResult.score, 'success');
        renderEvalCard(evalResult);
        if (evalResult.feedback) {
          lastFeedback = evalResult.feedback;
          var fbSummary2 = summarizeFeedback(evalResult.feedback);
          if (fbSummary2) log('📝 评估反馈: ' + truncate(fbSummary2, 120), 'warn');
        }
        saveHistory({ title: st.title, score: evalResult.score, type: detectedType, rounds: config.rounds, taskMode: 'chat' });
        markTaskDoneInScanCache(location.href, evalResult.score);
      } else {
        log('⚠ 评估结果: ' + JSON.stringify(evalResult), 'warn');
        setStatus('EVAL_ERR', 'error');
        toast('评估失败', 'error');
        saveHistory({ title: st.title, score: 'ERR', type: detectedType, rounds: config.rounds, taskMode: 'chat' });
      }
    } catch (err) {
      var friendlyErrC = normalizeRuntimeError(err);
      log('\n❌ ' + friendlyErrC, 'error');
      setStatus('ERROR', 'error');
      toast(friendlyErrC || '任务出错', 'error');
      console.error('[ChaoxingAI]', err);
    } finally {
      isRunning = false;
      updateButtons();
      pageCall('getState').then(function (s) { renderTaskInfo(s); }).catch(function () {});
    }
  }

  async function evaluateCurrentTaskNow() {
    if (isRunning) return;
    isRunning = true;
    aborted = false;
    collapseSettingsIfOpen();
    updateButtons();
    if (evalCardEl) evalCardEl.classList.remove('cxai-open');

    try {
      setStatus('RUNNING', 'running');
      setProgress(50);
      log('\nSUBMIT: 立即结束练习并开始 AI 评估...', 'info');
      const st = await pageCall('getState');
      if (st.recordStatus === 2) {
        throw new Error('当前任务已评估完成');
      }
      var taskProfile = detectTaskTypeProfile(st.title, st.requirement, st.scene, '');
      setProgress(80);
      const evalResult = await pageCall('submitEvaluate');
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      setProgress(100);

      lastFeedback = null;
      if (evalResult && evalResult.status === 'success') {
        log('\nDONE: 评估完成。最终得分: ' + evalResult.score, 'success');
        setStatus('DONE · ' + evalResult.score, 'done');
        toast('任务完成 · 得分 ' + evalResult.score, 'success');
        renderEvalCard(evalResult);
        if (evalResult.feedback) {
          lastFeedback = evalResult.feedback;
          var fbSummary = summarizeFeedback(evalResult.feedback);
          if (fbSummary) log('📝 评估反馈: ' + truncate(fbSummary, 120), 'warn');
        }
        saveHistory({ title: st.title, score: evalResult.score, type: taskProfile.type, rounds: 0, taskMode: 'chat' });
        markTaskDoneInScanCache(location.href, evalResult.score);
      } else {
        throw new Error('评估未返回成绩');
      }
    } catch (err) {
      log('\n❌ ' + normalizeRuntimeError(err), 'error');
      setStatus('ERROR', 'error');
      toast(normalizeRuntimeError(err) || '评估出错', 'error');
    } finally {
      isRunning = false;
      updateButtons();
      pageCall('getState').then(function (s) { renderTaskInfo(s); }).catch(function () {});
    }
  }

  async function startAutoTask(preserveLog) {
    if (isRunning) return;
    isRunning = true;
    aborted = false;
    collapseSettingsIfOpen();
    if (!preserveLog && logEl) logEl.innerHTML = '';
    if (evalCardEl) evalCardEl.classList.remove('cxai-open');
    updateButtons();

    try {
      if (!config.apiKey) throw new Error('请先设置 DeepSeek API Key');
      setStatus('RUNNING', 'running');
      setProgress(0);

      // 1. 获取当前任务状态
      log('INIT: 读取任务状态...', 'info');
      let st = await pageCall('getState');
      log('LOAD: 任务 → ' + st.title, 'success');
      log('LOAD: 要求 → ' + truncate(st.requirement, 60), 'info');
      renderTaskInfo(st);

      if (st.remainAnswerCount !== undefined && st.remainAnswerCount !== null && st.remainAnswerCount <= 0) {
        throw new Error('作答次数已用尽');
      }
      if (st.recordStatus === 1 || st.recordStatus === 2) {
        if (isNewArchPage) {
          log('REUSE: 检测到已评估页面，自动触发"重新练习"开启新一轮...', 'info');
          var rRes = await pageCall('retryTask');
          if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
          if (rRes && rRes.method === 'inplace') {
            await sleep(600);
            st = await pageCall('getState');
            renderTaskInfo(st);
          } else {
            return;
          }
        } else {
          throw new Error('当前任务已提交/已评估，请点击页面上的"重新练习"新建作答');
        }
      }

      var openingMsg = (st.messages && st.messages.length > 0) ? st.messages[0].content : '';
      var taskProfile = detectTaskTypeProfile(st.title, st.requirement, st.scene, openingMsg);
      if (st.scene) log('SCENE: ' + truncate(st.scene, 80), 'info');
      var detectedType = taskProfile.type;
      var typeLabels = { tech: '💻 技术', business: '📊 商业/管理', writing: '✍ 写作/文案', design: '🎨 设计/创意' };
      if (taskProfile.lowConfidence) {
        log('MODE: 自适应策略 → ⚖️ 通用平衡（低置信度，跨学科）', 'info');
      } else {
        log('MODE: 自适应策略 → ' + (typeLabels[detectedType] || detectedType), 'info');
      }

      // 根据任务类型分流
      var isFileTask = (st.type === 1);
      var isCodeTask = (st.type === 4);
      var isThinkLadderTask = (st.type === 2);
      if (isFileTask) {
        log('TYPE: 📄 文件上传型任务', 'info');
      } else if (isCodeTask) {
        log('TYPE: 💻 代码编辑型任务', 'info');
      } else if (isThinkLadderTask) {
        log('TYPE: 🧠 AI思维阶梯任务', 'info');
      } else {
        log('TYPE: 💬 对话型任务', 'info');
      }
      setProgress(5);

      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      var evalResult;
      if (isFileTask) {
        // ===== 文件上传型任务流程 =====
        await runFileTask(st, detectedType);
      } else if (isCodeTask) {
        // ===== 代码编辑型任务流程 =====
        evalResult = await runCodeTask(st);
      } else if (isThinkLadderTask) {
        // ===== AI思维阶梯任务流程 =====
        evalResult = await runThinkLadderTask(st);
      } else {
        // ===== 对话型任务流程 =====
        await runChatTask(st, detectedType, taskProfile);
      }

      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      // 代码任务和思维阶梯的评估已在各自函数中完成，跳过 submitEvaluate
      if (!isCodeTask && !isThinkLadderTask) {
        // 提交 + 评估（对话型和文件型）
        setStatus('正在提交并 AI 评估...', 'running');
        log('\nSUBMIT: 提交作答并开始AI评估...', 'info');
        await sleep(1500);
        setProgress(85);

        evalResult = await pageCall('submitEvaluate');
        if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
        setProgress(100);
      }

      lastFeedback = null;
      if (evalResult && evalResult.status === 'success') {
        log('\nDONE: 评估完成。最终得分: ' + evalResult.score, 'success');
        setStatus('DONE · ' + evalResult.score, 'done');
        toast('任务完成 · 得分 ' + evalResult.score, 'success');
        renderEvalCard(evalResult);
        // 保存评估反馈供重试优化使用
        if (evalResult.feedback) {
          lastFeedback = evalResult.feedback;
          var fbSummary = summarizeFeedback(evalResult.feedback);
          if (fbSummary) log('📝 评估反馈: ' + truncate(fbSummary, 120), 'warn');
        }
        // 记录执行历史
        var taskMode = isCodeTask ? 'code' : (isFileTask ? 'file' : 'chat');
        saveHistory({ title: st.title, score: evalResult.score, type: detectedType, rounds: isCodeTask ? 0 : (isFileTask ? 0 : config.rounds), taskMode: taskMode });
        markTaskDoneInScanCache(location.href, evalResult.score);
      } else {
        log('⚠ 评估结果: ' + JSON.stringify(evalResult), 'warn');
        setStatus('EVAL_ERR', 'error');
        toast('评估失败', 'error');
        var taskMode2 = isCodeTask ? 'code' : (isFileTask ? 'file' : 'chat');
        saveHistory({ title: st.title, score: 'ERR', type: detectedType, rounds: isCodeTask ? 0 : (isFileTask ? 0 : config.rounds), taskMode: taskMode2 });
      }

    } catch (err) {
      var friendlyErrA = normalizeRuntimeError(err);
      log('\n❌ ' + friendlyErrA, 'error');
      setStatus('ERROR', 'error');
      toast(friendlyErrA || '任务出错', 'error');
      console.error('[ChaoxingAI]', err);
    } finally {
      isRunning = false;
      updateButtons();
      pageCall('getState').then(function (s) { renderTaskInfo(s); }).catch(function () {});
    }
  }

  async function runTaskWithRetry() {
    if (!isExtensionAlive()) {
      var staleMsg = normalizeRuntimeError('Extension context invalidated');
      log('❌ ' + staleMsg, 'error');
      toast(staleMsg, 'warn');
      return;
    }

    try {
      saveConfig(true);
      collapseSettingsIfOpen();
      aborted = false;
      // 首次手动点击时没有 retryFeedback，只有 checkRetryAutoStart 设置过才有
      if (!config.retryFeedback) config.retryFeedback = '';

      var retryState = await new Promise(function (resolve) {
        storageGet([K.RETRY_STATE], function (r) { resolve(r[K.RETRY_STATE] || null); });
        if (!isExtensionAlive()) resolve(null);
      });
      var attempt = retryState ? (retryState.attempt || 1) : 1;

      var isLoopRetry = false;
      while (true) {
        await startAutoTask(isLoopRetry);

        // 目标分数 <= 0 表示不循环
        if (!config.targetScore || config.targetScore <= 0) return;
        if (aborted) return;

        // 读取得分
        var score = parseFloat(scoreEl ? scoreEl.textContent : '');
        if (isNaN(score)) {
          log('⚠ 无法读取分数，停止重试', 'warn');
          return;
        }

        if (score >= config.targetScore) {
          log('✓ 已达到目标分数: ' + score + ' >= ' + config.targetScore, 'success');
          setStatus('DONE · ' + score + ' ✓', 'done');
          var clearObj = {}; clearObj[K.RETRY_STATE] = null;
          storageSet(clearObj);
          return;
        }

        if (attempt >= L.MAX_RETRY_ATTEMPTS) {
          log('⚠ 已达最大重试次数 (' + L.MAX_RETRY_ATTEMPTS + ')，当前: ' + score, 'warn');
          var clearObj2 = {}; clearObj2[K.RETRY_STATE] = null;
          storageSet(clearObj2);
          return;
        }

        log('RETRY: 分数 ' + score + ' < 目标 ' + config.targetScore + ' (第' + attempt + '次)，准备重新练习...', 'warn');
        await sleep(T.RETRY_DELAY);
        if (aborted) return;

        var feedbackSummary = summarizeFeedback(lastFeedback);
        var setObj = {};
        setObj[K.RETRY_STATE] = { targetScore: config.targetScore, attempt: attempt + 1, feedback: feedbackSummary };
        storageSet(setObj);

        log('RETRY: 触发"重新练习"...', 'info');
        try {
          var retryRes = await pageCall('retryTask');
          if (retryRes && retryRes.method === 'inplace') {
            // 新版网页原地重置不刷新页面，直接在当前循环继续下一轮
            var clearInplace = {}; clearInplace[K.RETRY_STATE] = null;
            storageSet(clearInplace);
            config.retryFeedback = feedbackSummary;
            attempt++;
            isLoopRetry = true;
            log('RETRY: 页面已原地重置，继续第 ' + attempt + ' 次尝试...', 'info');
            await sleep(1000);
            continue;
          }
          // 页面导航/刷新重练，等待新页面加载后 checkRetryAutoStart 接管
          return;
        } catch (e) {
          log('RETRY: 重新练习失败 - ' + normalizeRuntimeError(e), 'error');
          var clearObj3 = {}; clearObj3[K.RETRY_STATE] = null;
          storageSet(clearObj3);
          return;
        }
      }
    } catch (err) {
      var friendly = normalizeRuntimeError(err);
      log('❌ ' + friendly, 'error');
      setStatus('ERROR', 'error');
      toast(friendly, 'error');
    }
  }

  function stopTask() {
    isRunning = false;
    isPaused = false;
    aborted = true;
    log('⚠ 正在停止... (可点击"继续"接上任务)', 'warn');
    setStatus('ABORTED', 'idle');
    updateButtons();
    // 手动停止时清除所有自动执行标志
    var stopClear = {};
    stopClear[K.BATCH_AUTO] = false;
    stopClear[K.BATCH_QUEUE] = [];
    stopClear[K.BATCH_FAILED] = [];
    stopClear[K.RETRY_STATE] = null;
    storageSet(stopClear);
  }

  function checkRetryAutoStart() {
    storageGet([K.RETRY_STATE], function (r) {
      var state = r[K.RETRY_STATE];
      if (!state || !state.targetScore) return;

      // 恢复目标分数到配置
      config.targetScore = state.targetScore;
      var tsEl = panelEl.querySelector('#cxai-target-score');
      if (tsEl) tsEl.value = state.targetScore;

      // 恢复评估反馈到配置
      config.retryFeedback = state.feedback || '';

      log('RETRY: 自动恢复重试 (第' + state.attempt + '次，目标: ' + state.targetScore + ')', 'info');
      if (state.feedback) {
        log('📋 上次评估反馈已加载，将用于优化本次对话', 'info');
      }

      setTimeout(function () {
        runTaskWithRetry();
      }, T.RUN_RETRY_AUTO_DELAY);
    });
  }

  // ==================== 批量模式自动接力 ====================

  function showBatchProgress(current, total, remaining) {
    var bar = panelEl.querySelector('#cxai-batch-bar');
    if (!bar) return;
    bar.style.display = 'block';
    var countEl = bar.querySelector('#cxai-batch-count');
    var progressEl = bar.querySelector('#cxai-batch-progress');
    countEl.textContent = '第 ' + current + ' / ' + total + ' 个 · 剩余 ' + remaining;
    var pct = Math.round((current / total) * 100);
    progressEl.style.width = pct + '%';
  }

  async function executeCurrentTaskForBatch() {
    var currentUrl = location.href;
    var failed = false;
    try {
      if (isDiscussPage) {
        await runDiscussTask();
      } else {
        await startAutoTask();
      }
      // 根据最终状态判断是否失败（status bar 的 class）
      if (statusEl && /cxai-st-error/.test(statusEl.className)) failed = true;
    } catch (e) {
      failed = true;
      log('BATCH: 当前任务异常 - ' + e.message + '，自动跳过', 'warn');
    }
    if (failed) {
      // 记录失败
      storageGet([K.BATCH_FAILED], function (r) {
        var list = r[K.BATCH_FAILED] || [];
        if (list.indexOf(currentUrl) === -1) list.push(currentUrl);
        var o = {}; o[K.BATCH_FAILED] = list;
        storageSet(o);
      });
    }
    return !failed;
  }

  // 批量流程：执行当前任务 → (如暂停则等待) → 导航到下一个
  function advanceBatch(queue, total, current, bar) {
    setTimeout(async function () {
      await executeCurrentTaskForBatch();
      if (aborted) {
        log('BATCH: 已中止，批量停止', 'warn');
        return;
      }
      if (isPaused) {
        log('BATCH: 已暂停，点击「继续」恢复', 'info');
        showBatchPauseButton(queue, total, current, bar);
        return;
      }
      if (queue.length > 0) {
        var nextUrl = queue.shift();
        showBatchProgress(current + 1, total, queue.length);
        log('BATCH: 导航到下一个任务...', 'info');
        runtimeSend({ type: 'NAVIGATE_TASK', url: nextUrl, queue: queue });
      } else {
        (function () { var o = {}; o[K.BATCH_AUTO] = false; o[K.BATCH_QUEUE] = []; o[K.BATCH_TOTAL] = 0; storageSet(o); })();
        showBatchComplete(total, bar);
      }
    }, 3000);
  }

  function showBatchComplete(total, bar) {
    storageGet([K.BATCH_FAILED], function (r) {
      var failed = r[K.BATCH_FAILED] || [];
      var titleEl = bar.querySelector('#cxai-batch-bar-title');
      var pauseBtn = bar.querySelector('#cxai-batch-pause');
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (titleEl) {
        titleEl.textContent = failed.length > 0 ? '⚠ 批量完成 (有失败)' : '✅ 批量已完成';
        titleEl.style.color = failed.length > 0 ? '#b45309' : '#059669';
      }
      if (failed.length === 0) {
        bar.style.background = '#ecfdf5';
        bar.style.borderColor = '#a7f3d0';
      }
      bar.querySelector('#cxai-batch-count').textContent = failed.length > 0
        ? ('完成 · 失败 ' + failed.length + ' 个')
        : '全部完成!';
      var bpEl = bar.querySelector('#cxai-batch-progress');
      if (bpEl) {
        bpEl.style.width = '100%';
        if (failed.length === 0) bpEl.style.background = 'linear-gradient(90deg,#10b981,#059669)';
      }
      log('BATCH: 全部 ' + total + ' 个任务执行完成' + (failed.length ? ' · ' + failed.length + ' 个失败' : '!'), 'success');
      if (failed.length > 0) {
        toast('批量完成 · 失败 ' + failed.length + ' 个，可重新扫描后手动重试', 'warn');
      } else {
        toast('批量执行完成 · 共 ' + total + ' 个', 'success');
      }
      // 清除失败记录
      var o = {}; o[K.BATCH_FAILED] = [];
      storageSet(o);
    });
  }

  function showBatchPauseButton(queue, total, current, bar) {
    bar.innerHTML =
      '<div style="margin-bottom:8px;"><span style="font-size:12px;font-weight:600;color:#f59e0b;">⏸ 批量已暂停</span></div>'
      + '<div style="font-size:12px;color:#555;margin-bottom:10px;">剩余 ' + queue.length + ' 个任务</div>'
      + '<div style="display:flex;gap:8px;">'
      + '<button id="cxai-batch-resume-pause" style="flex:1;padding:7px 0;background:#4f8ff7;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">▶ 继续</button>'
      + '<button id="cxai-batch-stop-pause" style="flex:1;padding:7px 0;background:#fff;color:#dc2626;border:1.5px solid #fca5a5;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">✕ 停止</button>'
      + '</div>';
    bar.querySelector('#cxai-batch-resume-pause').addEventListener('click', function () {
      isPaused = false;
      if (queue.length === 0) { showBatchComplete(total, bar); return; }
      var nextUrl = queue.shift();
      runtimeSend({ type: 'NAVIGATE_TASK', url: nextUrl, queue: queue });
    });
    bar.querySelector('#cxai-batch-stop-pause').addEventListener('click', function () {
      isPaused = false;
      (function () { var o = {}; o[K.BATCH_AUTO] = false; o[K.BATCH_QUEUE] = []; o[K.BATCH_TOTAL] = 0; storageSet(o); })();
      bar.style.display = 'none';
      log('BATCH: 用户停止批量', 'warn');
    });
  }

  // 渲染批量运行中 UI（带暂停按钮）
  function renderBatchRunningBar(bar) {
    bar.style.display = 'block';
    bar.style.background = '#f0f4ff';
    bar.style.borderColor = '#c5dfff';
    bar.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
      + '<span id="cxai-batch-bar-title" style="font-size:12px;font-weight:600;color:#2b7de9;">📋 批量执行中</span>'
      + '<div style="display:flex;gap:6px;align-items:center;">'
      + '<span id="cxai-batch-count" style="font-size:12px;color:#555;"></span>'
      + '<button id="cxai-batch-pause" title="暂停批量" style="padding:2px 8px;background:#fff;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:11px;color:#f59e0b;">⏸</button>'
      + '</div></div>'
      + '<div style="height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;">'
      + '<div id="cxai-batch-progress" style="height:100%;background:linear-gradient(90deg,#4f8ff7,#6c63ff);border-radius:3px;transition:width .4s;width:0%;"></div>'
      + '</div>';
    var pauseBtn = bar.querySelector('#cxai-batch-pause');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', function () {
        isPaused = true;
        pauseBtn.disabled = true;
        pauseBtn.textContent = '⏸ 将在当前任务结束后暂停';
        toast('暂停中...当前任务结束后生效', 'info');
        log('BATCH: 用户请求暂停', 'info');
      });
    }
  }

  function checkBatchAutoStart() {
    storageGet([K.BATCH_AUTO, K.BATCH_QUEUE, K.BATCH_TOTAL, K.BATCH_AUTO_AI], function (r) {
      if (!r[K.BATCH_AUTO]) return;

      if (panelEl && panelEl.classList.contains('cxai-hidden')) {
        panelEl.classList.remove('cxai-hidden');
        var tBtn = document.getElementById('cxai-toggle-btn');
        if (tBtn) tBtn.style.display = 'none';
      }

      var queue = r[K.BATCH_QUEUE] || [];
      var total = r[K.BATCH_TOTAL] || (queue.length + 1);
      var current = total - queue.length;
      var autoAi = r[K.BATCH_AUTO_AI] !== false;

      var bar = panelEl.querySelector('#cxai-batch-bar');
      if (!bar) return;

      // 讨论页自动继续
      if (isDiscussPage) {
        renderBatchRunningBar(bar);
        showBatchProgress(current, total, queue.length);
        log('BATCH: 讨论页自动继续 (第 ' + current + '/' + total + ')...', 'info');
        advanceBatch(queue, total, current, bar);
        return;
      }

      // AI 实践页：开启了"自动开始"则直接自动接力执行（仍支持随时点暂停/停止）
      if (autoAi) {
        renderBatchRunningBar(bar);
        showBatchProgress(current, total, queue.length);
        log('BATCH: AI实践自动接力执行中 (第 ' + current + '/' + total + ')...', 'info');
        advanceBatch(queue, total, current, bar);
        return;
      }

      // AI 实践页（手动确认模式）：显示确认提示
      bar.style.display = 'block';
      bar.innerHTML =
        '<div style="margin-bottom:8px;">'
        + '<span style="font-size:12px;font-weight:600;color:#2b7de9;">📋 检测到未完成的批量任务</span>'
        + '</div>'
        + '<div style="font-size:12px;color:#555;margin-bottom:10px;">第 ' + current + ' / ' + total + ' 个 · 剩余 ' + queue.length + ' 个任务</div>'
        + '<div style="display:flex;gap:8px;">'
        + '<button id="cxai-batch-resume" style="flex:1;padding:7px 0;background:#4f8ff7;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">▶ 继续批量</button>'
        + '<button id="cxai-batch-dismiss" style="flex:1;padding:7px 0;background:#f0f0f0;color:#555;border:1px solid #ddd;border-radius:6px;font-size:12px;cursor:pointer;">✕ 放弃</button>'
        + '</div>';

      log('BATCH: 检测到未完成批量 (第 ' + current + '/' + total + ')，等待确认...', 'info');

      bar.querySelector('#cxai-batch-resume').addEventListener('click', function () {
        renderBatchRunningBar(bar);
        showBatchProgress(current, total, queue.length);
        log('BATCH: 用户确认继续，开始执行...', 'info');
        advanceBatch(queue, total, current, bar);
      });

      bar.querySelector('#cxai-batch-dismiss').addEventListener('click', function () {
        (function () { var o = {}; o[K.BATCH_AUTO] = false; o[K.BATCH_QUEUE] = []; o[K.BATCH_TOTAL] = 0; storageSet(o); })();
        bar.style.display = 'none';
        log('BATCH: 已放弃未完成的批量任务', 'warn');
      });
    });
  }

  // ==================== 配置存取 ====================

  function migrateConfigFields(cfg) {
    var out = { ...DEFAULT_CONFIG, ...cfg };
    if (out.model) out.model = normalizeModelId(out.model);
    if (!out.thinkingMode) out.thinkingMode = 'none';
    return out;
  }

  function loadConfig(cb) {
    storageGet([K.PROFILES, K.ACTIVE_PROFILE, K.CONFIG], (r) => {
      profiles = r[K.PROFILES] || {};
      activeProfile = r[K.ACTIVE_PROFILE] || 'default';

      // 旧版迁移：存在 CONFIG 但没 PROFILES
      if (r[K.CONFIG] && Object.keys(profiles).length === 0) {
        profiles['default'] = migrateConfigFields(r[K.CONFIG]);
        persistProfiles();
      }
      if (!profiles[activeProfile]) {
        // 找不到当前 profile 就用第一个或 default
        var names = Object.keys(profiles);
        activeProfile = names[0] || 'default';
        if (!profiles[activeProfile]) profiles[activeProfile] = { ...DEFAULT_CONFIG };
      }
      var migrated = migrateConfigFields(profiles[activeProfile]);
      if (migrated.model !== profiles[activeProfile].model || !profiles[activeProfile].thinkingMode) {
        profiles[activeProfile] = migrated;
        persistProfiles();
      }
      config = migrated;
      if (cb) cb();
    });
  }

  function persistProfiles() {
    var o = {};
    o[K.PROFILES] = profiles;
    o[K.ACTIVE_PROFILE] = activeProfile;
    return storageSet(o);
  }

  function switchProfile(name) {
    if (!profiles[name]) return;
    activeProfile = name;
    config = { ...DEFAULT_CONFIG, ...profiles[name] };
    persistProfiles();
    fillConfigUI();
    renderProfileList();
    toast('已切换到: ' + name, 'info');
  }

  function createProfile(name) {
    name = (name || '').trim();
    if (!name) return;
    if (profiles[name]) { toast('名称已存在', 'warn'); return; }
    profiles[name] = { ...DEFAULT_CONFIG };
    activeProfile = name;
    config = { ...profiles[name] };
    persistProfiles();
    fillConfigUI();
    renderProfileList();
    toast('已创建: ' + name, 'success');
  }

  function deleteProfile(name) {
    if (!profiles[name]) return;
    if (Object.keys(profiles).length <= 1) {
      toast('至少需保留一个配置', 'warn');
      return;
    }
    delete profiles[name];
    if (activeProfile === name) {
      activeProfile = Object.keys(profiles)[0];
      config = { ...DEFAULT_CONFIG, ...profiles[activeProfile] };
      fillConfigUI();
    }
    persistProfiles();
    renderProfileList();
    toast('已删除: ' + name, 'info');
  }

  function renderProfileList() {
    if (!panelEl) return;
    var sel = panelEl.querySelector('#cxai-profile-select');
    if (!sel) return;
    var names = Object.keys(profiles);
    sel.innerHTML = names.map(function (n) {
      return '<option value="' + escHtml(n) + '"' + (n === activeProfile ? ' selected' : '') + '>' + escHtml(n) + '</option>';
    }).join('');
  }

  var _autoSaveTimer = null;
  function flashSavedBadge(text) {
    if (!panelEl) return;
    var badge = panelEl.querySelector('#cxai-save-indicator');
    if (!badge) return;
    badge.textContent = text || '✓ 已保存';
    badge.classList.add('cxai-show');
    clearTimeout(badge._t);
    badge._t = setTimeout(function () { badge.classList.remove('cxai-show'); }, 1800);
  }

  function saveConfig(silent) {
    config.apiKey = panelEl.querySelector('#cxai-apikey').value.trim();
    config.baseUrl = panelEl.querySelector('#cxai-baseurl').value.trim() || DEFAULT_CONFIG.baseUrl;
    config.model = normalizeModelId(panelEl.querySelector('#cxai-model').value.trim() || DEFAULT_CONFIG.model);
    var tmEl = panelEl.querySelector('#cxai-thinking-mode');
    config.thinkingMode = tmEl ? tmEl.value : 'none';
    config.rounds = parseInt(panelEl.querySelector('#cxai-rounds').value) || DEFAULT_CONFIG.rounds;
    config.delay = parseInt(panelEl.querySelector('#cxai-delay').value) || DEFAULT_CONFIG.delay;
    config.customPrompt = panelEl.querySelector('#cxai-custom-prompt').value.trim();
    config.promptStyle = panelEl.querySelector('#cxai-prompt-style').value;
    var dlEl = panelEl.querySelector('#cxai-discuss-length');
    if (dlEl) config.discussLength = dlEl.value;
    var tsEl = panelEl.querySelector('#cxai-target-score');
    if (tsEl) config.targetScore = parseInt(tsEl.value) || 0;
    // 存入当前 profile
    profiles[activeProfile] = { ...config };
    if (!persistProfiles()) {
      var staleMsg = normalizeRuntimeError('Extension context invalidated');
      if (!silent) {
        log('⚠ ' + staleMsg, 'warn');
        toast(staleMsg, 'warn');
      }
      return;
    }
    var tipEl = panelEl.querySelector('#cxai-setup-tip');
    if (tipEl) tipEl.style.display = config.apiKey ? 'none' : 'flex';
    flashSavedBadge(silent ? '✓ 已自动保存' : '✓ 已保存');
    if (!silent) {
      log('✓ 设置已保存 [' + activeProfile + ']', 'success');
      toast('设置已保存', 'success');
    }
  }

  function scheduleAutoSave() {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(function () {
      saveConfig(true);
    }, 350);
  }

  function fillConfigUI() {
    const q = (s) => panelEl.querySelector(s);
    q('#cxai-apikey').value = config.apiKey;
    q('#cxai-baseurl').value = config.baseUrl;
    q('#cxai-model').value = normalizeModelId(config.model);
    var tmEl = q('#cxai-thinking-mode');
    if (tmEl) tmEl.value = config.thinkingMode || 'none';
    q('#cxai-rounds').value = config.rounds;
    q('#cxai-delay').value = config.delay;
    q('#cxai-custom-prompt').value = config.customPrompt || '';
    q('#cxai-prompt-style').value = config.promptStyle || 'balanced';
    var dlVal = config.discussLength || 'medium';
    var dlEl = q('#cxai-discuss-length');
    if (dlEl) dlEl.value = dlVal;
    panelEl.querySelectorAll('.cxai-seg-btn[data-val]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.val === dlVal);
    });
    var tsEl = q('#cxai-target-score');
    if (tsEl) tsEl.value = config.targetScore || 0;
    var tipEl = q('#cxai-setup-tip');
    if (tipEl) tipEl.style.display = (config.apiKey && config.apiKey.trim()) ? 'none' : 'flex';
  }

  function normalizeScanCacheKey(rawUrl) {
    try {
      var u = new URL(rawUrl || location.href);
      var sp = new URLSearchParams(String(u.search || '').replace(/^\?+/, ''));
      var cid = sp.get('courseId') || sp.get('courseid') || '';
      var clz = sp.get('clazzId') || sp.get('clazzid') || sp.get('classId') || '';
      if (cid) return u.pathname + '|' + cid + '|' + clz;
      sp.delete('t');
      return u.pathname + '?' + sp.toString();
    } catch (e) {
      return rawUrl || location.href;
    }
  }

  function getCurrentUserHint() {
    var hint = { puid: '', userName: '' };
    var docs = [document];
    try {
      if (window.top && window.top !== window && window.top.document) {
        docs.unshift(window.top.document);
      }
    } catch (e) {}
    for (var i = 0; i < docs.length; i++) {
      try {
        var doc = docs[i];
        var img = doc.querySelector('.user-info .user img, .user-info img');
        if (img && img.getAttribute('src') && !hint.puid) {
          var m = img.getAttribute('src').match(/\/p\/(\d+)/);
          if (m) hint.puid = m[1];
        }
        var nameEl = doc.querySelector('.user-info .user p, .user-info p');
        if (nameEl && nameEl.textContent && !hint.userName) {
          hint.userName = nameEl.textContent.trim();
        }
      } catch (e) {}
    }
    return hint;
  }

  // ==================== 批量模式（任务列表页） ====================

  async function startCollect() {
    if (isCollecting) return;
    isCollecting = true;
    var scanBtn = panelEl.querySelector('#cxai-btn-scan');
    var batchStatus = panelEl.querySelector('#cxai-batch-status');
    var batchList = panelEl.querySelector('#cxai-batch-list');

    scanBtn.textContent = '⏳ 扫描中...';
    scanBtn.disabled = true;
    batchStatus.style.display = 'block';
    batchStatus.textContent = '正在读取课程参数...';
    batchList.innerHTML = '';
    log('SCAN: 开始扫描任务（AI实践 + 主题讨论）...', 'info');

    try {
      var pageInfo = await pageCall('getPageInfo');
      if (!pageInfo || !pageInfo.courseId) throw new Error('无法获取课程参数');

      var allTasks = [];

      if (pageInfo.isFanya || isFanyaTaskListPage) {
        // 新版课程任务中心 (fanyav3/studentCourse): 直接读取 activityList 接口
        batchStatus.textContent = '读取新版课程活动列表...';
        try {
          var fanyaResp = await pageCall('getFanyaTasks', {
            courseId: pageInfo.courseId,
            classId: pageInfo.classId,
            cpi: pageInfo.cpi || ''
          });
          if (fanyaResp && fanyaResp.status && fanyaResp.data && fanyaResp.data.length > 0) {
            fanyaResp.data.forEach(function (t) {
              if (t.url) allTasks.push(t);
            });
            log('SCAN: fanya3 activityList → ' + fanyaResp.data.length + ' 个任务', 'info');
          }
        } catch (e) {
          log('SCAN: fanya3 activityList 读取失败 - ' + e.message, 'warn');
        }
      } else {
        // 数据源0: 当前任务列表页已渲染的 AI 任务（兼容普通任务流中的 AI 实践）
        batchStatus.textContent = '读取页面中的任务项...';
        try {
          var renderedResp = await pageCall('getRenderedAiTaskList');
          if (renderedResp && renderedResp.status && renderedResp.data && renderedResp.data.length > 0) {
            renderedResp.data.forEach(function (t) {
              if (t.url) allTasks.push({ name: t.name || '未命名', url: t.url, source: t.source || 'rendered', taskMode: t.taskMode || 'chat', isFinish: t.isFinish });
            });
            log('SCAN: 页面任务列表 → ' + renderedResp.data.length + ' 个候选任务', 'info');
          }
        } catch (e) { log('SCAN: 页面任务列表读取失败', 'warn'); }

        // 数据源A: activities API (activeList4)
        batchStatus.textContent = '查找AI实践活动...';
        try {
          var resp = await pageCall('getAiPracticeList', { courseId: pageInfo.courseId, classId: pageInfo.classId });
          if (resp && resp.status && resp.data && resp.data.length > 0) {
            resp.data.forEach(function (t) {
              if (t.url) allTasks.push({ name: t.title || t.name || '未命名', url: t.url, source: 'direct', taskMode: 'chat' });
            });
            log('SCAN: activities API → ' + resp.data.length + ' 个直接任务', 'info');
          }
        } catch (e) { log('SCAN: activities API 无数据', 'warn'); }

        // 数据源B: 任务引擎 (activeList3)
        batchStatus.textContent = '查找任务引擎任务...';
        try {
          var teResp = await pageCall('getTaskEngineList', { courseId: pageInfo.courseId, classId: pageInfo.classId });
          if (teResp && teResp.result === 1 && teResp.data && teResp.data.length > 0) {
            var eTasks = teResp.data;
            log('SCAN: 任务引擎 → 发现 ' + eTasks.length + ' 个任务', 'info');
            for (var i = 0; i < eTasks.length; i++) {
              var et = eTasks[i];
              batchStatus.textContent = '解析: ' + (et.name || '任务') + ' (' + (i + 1) + '/' + eTasks.length + ')';
              log('SCAN: 解析 → ' + et.name, 'info');
              try {
                var aiUrls = await bgMessage({ type: 'RESOLVE_TASK_AI_URLS', taskId: et.id, classId: pageInfo.classId });
                if (aiUrls && aiUrls.length > 0) {
                  aiUrls.forEach(function (ai) {
                    allTasks.push({ name: ai.name, url: ai.url, isFinish: ai.isFinish, parentTask: et.name, source: 'engine', taskMode: ai.taskMode || 'chat' });
                  });
                }
              } catch (e) { log('SCAN: ' + et.name + ' → ' + e.message, 'warn'); }
            }
          }
        } catch (e) { log('SCAN: 任务引擎无数据', 'warn'); }
      }

      var seenTaskUrls = {};
      collectedTasks = allTasks.filter(function (t) {
        if (!t || !t.url) return false;
        if (seenTaskUrls[t.url]) return false;
        seenTaskUrls[t.url] = true;
        return true;
      });
      // 解析讨论任务的真实 URL（placeholder → groupweb）
      var discussTasks = collectedTasks.filter(function (t) { return t.url && t.url.indexOf('cxai-discuss://') === 0; });
      if (discussTasks.length > 0) {
        batchStatus.textContent = '解析讨论任务 URL (' + discussTasks.length + '个)...';
        log('SCAN: 解析 ' + discussTasks.length + ' 个讨论任务的真实 URL...', 'info');
        for (var di = 0; di < discussTasks.length; di++) {
          var dt = discussTasks[di];
          try {
            var placeholder = dt.url.replace('cxai-discuss://', '');
            var activeId = placeholder.split('?')[0];
            var params = {};
            (placeholder.split('?')[1] || '').split('&').forEach(function (p) { var kv = p.split('='); if (kv[0]) params[kv[0]] = kv[1] || ''; });
            var resolved = await pageCall('resolveDiscussInfo', {
              activeId: activeId,
              courseId: params.courseId || pageInfo.courseId,
              classId: params.classId || pageInfo.classId,
              cpi: params.cpi || pageInfo.cpi || ''
            });
            if (resolved && resolved.url) {
              dt.url = resolved.url;
              log('SCAN: ✓ ' + dt.name + ' → URL已解析', 'info');
            } else {
              log('SCAN: ⚠ ' + dt.name + ' → URL解析失败', 'warn');
            }
          } catch (e) {
            log('SCAN: ⚠ ' + dt.name + ' → ' + e.message, 'warn');
          }
        }
        // 移除解析失败的
        collectedTasks = collectedTasks.filter(function (t) { return t.url.indexOf('cxai-discuss://') !== 0; });
      }

      // 核查进行中的主题讨论：fanya activityList 的 userStatus 不会因学生回复而变，需核查 getReplyList
      var openDiscuss = collectedTasks.filter(function (t) {
        return t && t.taskMode === 'discuss' && t.url && !t.isEnded;
      });
      if (openDiscuss.length > 0) {
        batchStatus.textContent = '核查主题讨论回复状态 (' + openDiscuss.length + '个)...';
        log('SCAN: 核查 ' + openDiscuss.length + ' 个进行中主题讨论的个人回复记录...', 'info');
        try {
          var userHint = getCurrentUserHint();
          var discussRes = await bgMessage({
            type: 'CHECK_DISCUSS_STATUS',
            items: openDiscuss.map(function (t) { return { url: t.url }; }),
            puid: userHint.puid,
            userName: userHint.userName
          });
          if (discussRes) {
            var repliedCount = 0;
            openDiscuss.forEach(function (t) {
              var info = discussRes[t.url];
              if (info && info.replied) {
                t.isFinish = true;
                t.replied = true;
                repliedCount++;
              } else if (info && info.replied === false && info.exhaustive) {
                t.isFinish = false;
              }
            });
            if (repliedCount > 0) {
              log('SCAN: ✓ 发现 ' + repliedCount + ' 个进行中讨论已回复，已标为已完成', 'success');
            }
          }
        } catch (e) {
          log('SCAN: 讨论状态核查跳过 - ' + normalizeRuntimeError(e), 'warn');
        }
      }

      // 兜底核查非 fanya3 来源、尚无 load-data 分数信息的 AI 实践任务
      var aiNeedCheck = collectedTasks.filter(function (t) {
        return t && t.taskMode !== 'discuss' && t.url
          && t.answerScore === undefined && t.belowStandard === undefined
          && /publishRelationUuid=/i.test(t.url);
      });
      if (aiNeedCheck.length > 0) {
        batchStatus.textContent = '核查 AI 实践作答记录 (' + aiNeedCheck.length + '个)...';
        try {
          var aiStatusRes = await bgMessage({
            type: 'CHECK_AI_PRACTICE_STATUS',
            items: aiNeedCheck.map(function (t) {
              return {
                url: t.url,
                taskMode: t.taskMode,
                courseId: pageInfo.courseId,
                classId: pageInfo.classId,
                cpi: pageInfo.cpi || ''
              };
            })
          });
          if (aiStatusRes) {
            aiNeedCheck.forEach(function (t) {
              var patch = aiStatusRes[t.url];
              if (!patch) return;
              if (patch.taskMode) t.taskMode = patch.taskMode;
              if (patch.remainAnswerCount !== undefined) t.remainAnswerCount = patch.remainAnswerCount;
              if (patch.answerScore !== undefined) t.answerScore = patch.answerScore;
              if (patch.reachStandard !== undefined) t.reachStandard = patch.reachStandard;
              if (patch.isFinish !== undefined) {
                if (t.isEnded && !patch.isFinish) {
                  t.isFinish = true;
                  t.belowStandard = false;
                } else {
                  t.isFinish = patch.isFinish;
                  t.belowStandard = !!patch.belowStandard;
                }
              }
            });
          }
        } catch (e) {}
      }

      batchTaskSelection = {};
      collectedTasks.forEach(function (t) {
        if (t && t.url) {
          // 默认只勾选未完成且可自动执行的任务（跳过已完成与需手传图片题）
          batchTaskSelection[t.url] = (t.isFinish !== true && t.taskMode !== 'image');
        }
      });

      // 存入扫描缓存（按课程标识匹配 + 时间戳，1小时内恢复）
      var cache = {};
      cache[K.SCAN_CACHE] = {
        url: location.href,
        courseKey: normalizeScanCacheKey(location.href),
        tasks: collectedTasks,
        time: Date.now(),
      };
      cache[K.BATCH_TASKS] = collectedTasks;
      storageSet(cache);

      if (collectedTasks.length === 0) {
        batchStatus.className = 'cxai-batch-status is-warn';
        batchStatus.innerHTML = '<span>未找到可执行的 AI 实践或主题讨论任务</span>';
        batchList.innerHTML = '<div style="color:#94a3b8;font-size:12px;text-align:center;padding:16px 0;">当前课程暂无可批量任务</div>';
        log('SCAN: 未找到任务', 'warn');
      } else {
        var pendingAutoCount = collectedTasks.filter(function (t) { return t.isFinish !== true && t.taskMode !== 'image'; }).length;
        var doneOrEndedCount = collectedTasks.filter(function (t) { return t.isFinish === true; }).length;
        batchStatus.className = 'cxai-batch-status is-ok';
        batchStatus.innerHTML = cxIcon('check', 12) + '<span>已扫描 ' + collectedTasks.length + ' 个 · 待执行 ' + pendingAutoCount + ' 个 · 已完成/结束 ' + doneOrEndedCount + ' 个</span>';
        renderBatchList(collectedTasks);
        log('SCAN: 完成，共 ' + collectedTasks.length + ' 个任务 (待执行 ' + pendingAutoCount + ', 已完成/结束 ' + doneOrEndedCount + ')', 'success');
      }
    } catch (err) {
      var friendlyErr = normalizeRuntimeError(err);
      batchStatus.className = 'cxai-batch-status is-err';
      batchStatus.textContent = friendlyErr;
      log('SCAN: ' + friendlyErr, 'error');
    } finally {
      isCollecting = false;
      scanBtn.innerHTML = cxIcon('scan', 13) + '<span>重新扫描</span>';
      scanBtn.disabled = false;
    }
  }

  // 尝试恢复上次扫描结果（同一课程 + 1小时内，不受时间戳变化影响；不覆盖已触发的手动扫描）
  function restoreScanCache() {
    if (!isTaskListPage || !panelEl || isCollecting || collectedTasks.length > 0) return;
    storageGet([K.SCAN_CACHE], function (r) {
      if (isCollecting || collectedTasks.length > 0) return;
      var cache = r[K.SCAN_CACHE];
      if (!cache || !cache.tasks || cache.tasks.length === 0) return;
      if (Date.now() - (cache.time || 0) > L.SCAN_CACHE_TTL) return;
      var curKey = normalizeScanCacheKey(location.href);
      if (cache.courseKey ? (cache.courseKey !== curKey) : (cache.url !== location.href)) return;

      collectedTasks = cache.tasks;
      batchTaskSelection = {};
      collectedTasks.forEach(function (t) {
        if (t && t.url) batchTaskSelection[t.url] = (t.isFinish !== true && t.taskMode !== 'image'); // 默认勾选未完成且可自动执行
      });
      var batchStatus = panelEl.querySelector('#cxai-batch-status');
      if (batchStatus) {
        batchStatus.style.display = 'flex';
        batchStatus.className = 'cxai-batch-status is-cache';
        var ageMin = Math.round((Date.now() - cache.time) / 60000);
        var ageText = ageMin < 1 ? '刚刚' : (ageMin + '分钟前');
        batchStatus.innerHTML = cxIcon('history', 12) + '<span>已恢复上次扫描结果 (' + ageText + ' · ' + collectedTasks.length + '个)</span>';
      }
      renderBatchList(collectedTasks);
      log('SCAN: 恢复缓存 → ' + collectedTasks.length + ' 个任务', 'info');
    });
  }

  function renderBatchList(tasks) {
    var listEl = panelEl.querySelector('#cxai-batch-list');
    var html = '';
    tasks.forEach(function (t, idx) {
      var subInfo = t.parentTask ? '<div class="cxai-batch-item-sub">' + escHtml(t.parentTask) + '</div>' : '';
      var isDone = t.isFinish === true;
      var isEndedOnly = isDone && t.isEnded === true && t.answerScore === undefined && !t.replied;
      var dotCls = isEndedOnly ? 'ended' : (isDone ? 'done' : (t.isFinish === false ? 'pending' : ''));
      var badgeStyle = 'background:#eef2ff;color:#4f46e5;';
      var badgeText = 'AI对话';
      if (t.taskMode === 'discuss') { badgeStyle = 'background:#eff6ff;color:#2563eb;'; badgeText = '主题讨论'; }
      else if (t.taskMode === 'code') { badgeStyle = 'background:#ecfdf5;color:#047857;'; badgeText = '代码'; }
      else if (t.taskMode === 'ladder') { badgeStyle = 'background:#fef3c7;color:#92400e;'; badgeText = '阶梯'; }
      else if (t.taskMode === 'image') { badgeStyle = 'background:#fdf2f8;color:#be185d;'; badgeText = '需传图'; }
      else if (t.taskMode === 'file') { badgeStyle = 'background:#fffbeb;color:#b45309;'; badgeText = '文件'; }
      if (isEndedOnly) {
        badgeStyle = 'background:#f1f5f9;color:#64748b;';
        badgeText = '已结束';
      } else if (isDone) {
        badgeStyle = 'background:#ecfdf5;color:#059669;';
        var scoreSuffix = (t.answerScore !== undefined && t.answerScore !== null && !isNaN(Number(t.answerScore)))
          ? (' · ' + (Math.round(Number(t.answerScore) * 10) / 10) + '分')
          : '';
        badgeText = '已完成' + scoreSuffix;
      } else if (t.belowStandard) {
        badgeStyle = 'background:#fffbeb;color:#d97706;';
        var lowScoreSuffix = (t.answerScore !== undefined && t.answerScore !== null && !isNaN(Number(t.answerScore)))
          ? (' · ' + (Math.round(Number(t.answerScore) * 10) / 10) + '分')
          : '';
        badgeText = '未达标' + lowScoreSuffix;
      }
      var dotTitle = isEndedOnly ? '已结束' : (isDone ? '已完成' : (t.belowStandard ? '已作答但未达标' : '未完成'));
      var tag = '<div class="cxai-batch-tags"><span class="cxai-batch-item-tag" style="' + badgeStyle + '">' + badgeText + '</span></div>';
      var checked = !t || !t.url ? false : batchTaskSelection[t.url] !== false;
      html += '<label class="cxai-batch-item ' + (checked ? 'is-checked ' : '') + (isDone ? 'is-done' : '') + '">'
        + '<input type="checkbox" class="cxai-bp-check" data-idx="' + idx + '" ' + (checked ? 'checked' : '') + ' />'
        + '<span class="cxai-batch-checkmark">' + cxIcon('check', 10) + '</span>'
        + '<span class="cxai-batch-dot ' + dotCls + '" title="' + dotTitle + '"></span>'
        + '<div style="flex:1;min-width:0;">'
        + '<div class="cxai-batch-item-name" title="' + escHtml(t.name) + '">' + escHtml(t.name) + '</div>'
        + subInfo + '</div>' + tag + '</label>';
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.cxai-bp-check').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var idx = parseInt(cb.dataset.idx, 10);
        var task = collectedTasks[idx];
        if (task && task.url) batchTaskSelection[task.url] = cb.checked;
        var item = cb.closest('.cxai-batch-item');
        if (item) item.classList.toggle('is-checked', cb.checked);
        updateBatchExecBtn();
      });
    });
    updateBatchExecBtn();
  }

  function updateBatchExecBtn() {
    var btn = panelEl.querySelector('#cxai-btn-batch-exec');
    var selAllBtn = panelEl.querySelector('#cxai-btn-selall');
    if (!btn) return;
    var checks = Array.from(panelEl.querySelectorAll('.cxai-bp-check'));
    var n = checks.filter(function (c) { return c.checked; }).length;
    var allChecked = checks.length > 0 && checks.every(function (c) { return c.checked; });
    btn.disabled = n === 0;
    btn.innerHTML = cxIcon('rocket', 14) + '<span>' + (n > 0 ? ('批量执行 (' + n + ')') : '批量执行') + '</span>';
    if (selAllBtn) selAllBtn.innerHTML = cxIcon('checkAll', 12) + '<span>' + (allChecked ? '取消' : '全选') + '</span>';
  }

  function toggleSelectAll() {
    var checks = panelEl.querySelectorAll('.cxai-bp-check');
    var allChecked = Array.from(checks).every(function (c) { return c.checked; });
    checks.forEach(function (c) {
      c.checked = !allChecked;
      var idx = parseInt(c.dataset.idx, 10);
      var task = collectedTasks[idx];
      if (task && task.url) batchTaskSelection[task.url] = c.checked;
      var item = c.closest('.cxai-batch-item');
      if (item) item.classList.toggle('is-checked', c.checked);
    });
    updateBatchExecBtn();
  }

  function selectUndoneOnly() {
    var checks = panelEl.querySelectorAll('.cxai-bp-check');
    var undoneCount = 0;
    checks.forEach(function (c) {
      var idx = parseInt(c.dataset.idx, 10);
      var task = collectedTasks[idx];
      // 跳过已完成以及需手传图片的纯图片作品题
      var shouldCheck = !(task && (task.isFinish === true || task.taskMode === 'image'));
      c.checked = shouldCheck;
      if (shouldCheck) undoneCount++;
      if (task && task.url) batchTaskSelection[task.url] = shouldCheck;
      var item = c.closest('.cxai-batch-item');
      if (item) item.classList.toggle('is-checked', shouldCheck);
    });
    updateBatchExecBtn();
    toast('已选中 ' + undoneCount + ' 个可自动执行的未完成任务', 'info');
  }

  function startBatchExecute() {
    var checks = panelEl.querySelectorAll('.cxai-bp-check:checked');
    var urls = [];
    checks.forEach(function (cb) {
      var idx = parseInt(cb.dataset.idx);
      var task = collectedTasks[idx];
      if (task && task.url) urls.push(task.url);
    });
    if (urls.length === 0) return;

    var btn = panelEl.querySelector('#cxai-btn-batch-exec');
    btn.disabled = true;
    btn.textContent = '⏳ 启动中...';
    setStatus('BATCH_START', 'running');
    log('BATCH: 启动批量执行 (' + urls.length + ' 个任务)', 'info');

    var total = urls.length;
    var firstUrl = urls.shift();
    var autoAiCb = panelEl.querySelector('#cxai-batch-auto-ai');
    var autoAiVal = autoAiCb ? !!autoAiCb.checked : true;
    var batchObj = {};
    batchObj[K.BATCH_QUEUE] = urls;
    batchObj[K.BATCH_AUTO] = true;
    batchObj[K.BATCH_TOTAL] = total;
    batchObj[K.BATCH_FAILED] = []; // 重置失败列表
    batchObj[K.BATCH_AUTO_AI] = autoAiVal;
    if (!storageSet(batchObj, function () {
      runtimeSend({ type: 'NAVIGATE_TASK', url: firstUrl, queue: urls });
    })) {
      var staleMsg = normalizeRuntimeError('Extension context invalidated');
      log('❌ ' + staleMsg, 'error');
      toast(staleMsg, 'warn');
      btn.disabled = false;
      btn.innerHTML = cxIcon('rocket', 14) + '<span>批量执行</span>';
    }
  }

  // ==================== UI ====================

  function updateButtons() {
    if (startBtn) startBtn.disabled = isRunning;
    if (stopBtn) stopBtn.disabled = !isRunning;

    var userRounds = 0;
    if (lastTaskData && Array.isArray(lastTaskData.messages)) {
      userRounds = lastTaskData.messages.filter(function (m) { return m && m.role === 'user'; }).length;
    }
    var evalDone = !!(lastTaskData && (lastTaskData.recordStatus === 1 || lastTaskData.recordStatus === 2));
    var canResumeOrEval = !isRunning && !isTaskListPage && !isDiscussPage
      && lastTaskData && lastTaskData.type !== 1 && lastTaskData.type !== 2 && lastTaskData.type !== 4
      && !evalDone && (aborted || userRounds > 0);

    var showContinue = !!(continueBtn && canResumeOrEval);
    var showEvalNow = !!(evalNowBtn && !isRunning && !evalDone && userRounds > 0);
    if (continueBtn) {
      continueBtn.style.display = showContinue ? '' : 'none';
      if (showContinue) {
        continueBtn.innerHTML = cxIcon('play', 13) + '<span>' + (userRounds > 0 ? ('第' + (userRounds + 1) + '轮继续') : '继续') + '</span>';
      }
    }
    if (evalNowBtn) {
      evalNowBtn.style.display = showEvalNow ? '' : 'none';
    }
    var resumeRow = panelEl ? panelEl.querySelector('#cxai-resume-row') : null;
    if (resumeRow) {
      resumeRow.style.display = (showContinue || showEvalNow) ? 'flex' : 'none';
    }
  }

  function renderTaskInfo(td) {
    lastTaskData = td || null;
    if (!taskInfoEl) { console.log('[ChaoxingAI] renderTaskInfo: taskInfoEl 为 null，跳过'); return; }
    console.log('[ChaoxingAI] renderTaskInfo: 收到数据', { title: td.title, requirement: (td.requirement||'').slice(0,40), remain: td.remainAnswerCount, score: td.answerScore, type: td.type });
    var isImgOnly = isImageOnlyTask(td);
    var typePill = panelEl ? panelEl.querySelector('#cxai-task-type-pill') : null;
    if (typePill) {
      var pillText = isImgOnly ? '图片作品'
        : (td.type === 1 ? '文件上传'
        : (td.type === 4 ? '代码编辑'
        : (td.type === 2 ? '思维阶梯' : '情景对话')));
      var pillCls = isImgOnly ? 'is-image'
        : (td.type === 1 ? 'is-file'
        : (td.type === 4 ? 'is-code'
        : (td.type === 2 ? 'is-ladder' : '')));
      typePill.className = 'cxai-type-pill' + (pillCls ? (' ' + pillCls) : '');
      typePill.textContent = pillText;
    }
    taskInfoEl.innerHTML =
      '<div class="cxai-task-item"><span class="cxai-task-label">任务标题</span><span class="cxai-task-value">' + escHtml(td.title || '-') + '</span></div>'
      + '<div class="cxai-task-item"><span class="cxai-task-label">作答要求</span><span class="cxai-task-value cxai-dim">' + escHtml(truncate(td.requirement, 80) || '-') + '</span></div>'
      + '<div class="cxai-task-stats">'
      + '<div class="cxai-task-stat"><span>剩余次数</span><span class="cxai-stat-val">' + escHtml(td.remainAnswerCount != null ? td.remainAnswerCount : '-') + '</span></div>'
      + '<div class="cxai-task-stat"><span>历史最高</span><span class="cxai-stat-val">' + escHtml(td.answerScore != null ? td.answerScore : '-') + '</span></div>'
      + '</div>';

    // 图片作品题：渲染绘图提示词助手
    var imgBox = panelEl ? panelEl.querySelector('#cxai-image-helper') : null;
    if (imgBox) {
      if (isImgOnly) {
        imgBox.style.display = 'flex';
        var draft = buildImagePromptDraft(td);
        imgBox.innerHTML =
          '<div class="cxai-image-helper-title">' + cxIcon('image', 14) + '<span>图片作品创作助手（当前任务仅支持图片上传）</span></div>'
          + '<textarea id="cxai-img-prompt" rows="4">' + escHtml(draft) + '</textarea>'
          + '<div class="cxai-btn-group">'
          + '<button type="button" class="cxai-btn-sm cxai-btn-test" id="cxai-btn-img-ai">' + cxIcon('sparkles', 13) + '<span>AI 润色提示词</span></button>'
          + '<button type="button" class="cxai-btn-sm cxai-btn-save" id="cxai-btn-img-copy">' + cxIcon('copy', 13) + '<span>复制提示词</span></button>'
          + '</div>'
          + '<div class="cxai-image-helper-hint">生成图片后，点击页面左侧「选择本地文件」上传（支持 jpg/jpeg/png，≤10MB）。</div>';

        var copyBtn = imgBox.querySelector('#cxai-btn-img-copy');
        var ta = imgBox.querySelector('#cxai-img-prompt');
        copyBtn.addEventListener('click', function () {
          var txt = ta ? ta.value.trim() : '';
          if (!txt) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(function () {
              toast('绘图提示词已复制到剪贴板', 'success');
            }).catch(function () {
              ta.select(); document.execCommand('copy'); toast('已复制提示词', 'success');
            });
          } else {
            ta.select(); document.execCommand('copy'); toast('已复制提示词', 'success');
          }
        });
        var aiImgBtn = imgBox.querySelector('#cxai-btn-img-ai');
        aiImgBtn.addEventListener('click', async function () {
          if (!config.apiKey) { toast('请先在系统配置填写 API Key', 'warn'); return; }
          aiImgBtn.disabled = true;
          aiImgBtn.innerHTML = '<span class="cxai-spinner"></span><span>润色中...</span>';
          try {
            var polished = await bgChat({
              apiKey: config.apiKey,
              baseUrl: config.baseUrl,
              model: config.model,
              thinkingMode: 'none',
              messages: [
                { role: 'system', content: '你是一名专业 AI 绘图提示词工程师。请根据用户的课程绘画题目与要求，生成一段直接可用于主流生图模型（Midjourney / 即梦 / 通义万相）的详细画面描述词（含主体构图、场景元素、光影色彩与画风，强调无文字水印）。只输出提示词正文，不超过180字。' },
                { role: 'user', content: '题目：' + (td.title || '') + '\n要求：' + (td.requirement || '') }
              ],
              maxTokens: 400
            });
            if (polished && ta) {
              ta.value = polished.trim();
              toast('绘图提示词已由 DeepSeek 润色更新', 'success');
            }
          } catch (e) {
            toast('生成失败: ' + normalizeRuntimeError(e), 'error');
          } finally {
            aiImgBtn.disabled = false;
            aiImgBtn.innerHTML = cxIcon('sparkles', 13) + '<span>AI 润色提示词</span>';
          }
        });
      } else {
        imgBox.style.display = 'none';
      }
    }

    var targetRow = panelEl ? panelEl.querySelector('.cxai-target-row') : null;
    var primaryRow = panelEl ? panelEl.querySelector('#cxai-primary-actions') : null;
    var imgNoteEl = panelEl ? panelEl.querySelector('#cxai-img-note') : null;
    if (targetRow) targetRow.style.display = isImgOnly ? 'none' : '';
    if (primaryRow) primaryRow.style.display = isImgOnly ? 'none' : '';
    if (imgNoteEl) imgNoteEl.style.display = isImgOnly ? 'flex' : 'none';
    if (isImgOnly && !isRunning && td.recordStatus !== 1 && td.recordStatus !== 2) {
      setStatus('待手动上传图片', 'idle');
    }

    updateButtons();
  }

  function createPanel() {
    var toggleBtn = document.createElement('button');
    toggleBtn.id = 'cxai-toggle-btn';
    toggleBtn.title = '打开超星 AI 任务助手';
    toggleBtn.innerHTML = cxIcon('brand', 21) + '<span class="cxai-toggle-live"></span>';
    document.body.appendChild(toggleBtn);

    panelEl = document.createElement('div');
    panelEl.id = 'cxai-panel';
    if (!isDiscussPage) {
      panelEl.classList.add('cxai-hidden');
    } else {
      toggleBtn.style.display = 'none';
    }

    // 根据页面类型构建不同中间区域
    var taskSection, controlSection;

    if (isTaskListPage) {
      // 任务列表页 → 批量任务卡片
      taskSection =
        '<div class="cxai-task-card">'
        + '<div class="cxai-card-head">'
        + '<div class="cxai-card-title"><span class="cxai-pulse"></span>课程任务批量调度</div>'
        + '<span class="cxai-type-pill">批量队列</span>'
        + '</div>'
        + '<div class="cxai-btn-group" style="margin-bottom:8px;">'
        + '<button class="cxai-btn-sm cxai-btn-save" id="cxai-btn-scan" style="flex:1.4;">' + cxIcon('scan', 13) + '<span>扫描任务</span></button>'
        + '<button class="cxai-btn-sm cxai-btn-test" id="cxai-btn-selundone" style="flex:none;" title="只选未完成的可自动任务">' + cxIcon('filter', 12) + '<span>仅未完成</span></button>'
        + '<button class="cxai-btn-sm cxai-btn-test" id="cxai-btn-selall" style="flex:none;">' + cxIcon('checkAll', 12) + '<span>全选</span></button>'
        + '</div>'
        + '<label class="cxai-batch-auto-opt"><input type="checkbox" id="cxai-batch-auto-ai" checked />批量时自动开始 AI 实践（免逐题确认）</label>'
        + '<div id="cxai-batch-status" class="cxai-batch-status"></div>'
        + '<div id="cxai-batch-list" style="max-height:220px;overflow-y:auto;">'
        + '<div style="color:#94a3b8;font-size:12px;text-align:center;padding:16px 0;">点击上方「扫描任务」加载当前课程活动</div>'
        + '</div>'
        + '</div>';
      controlSection =
        '<div id="cxai-status" class="cxai-status-bar cxai-st-idle">'
        + '<div class="cxai-status-left"><span class="cxai-status-icon">●</span><span class="cxai-status-text">待命中</span></div>'
        + '</div>'
        + '<div class="cxai-btn-group">'
        + '<button class="cxai-btn-exec" id="cxai-btn-batch-exec" disabled>' + cxIcon('rocket', 14) + '<span>批量执行</span></button>'
        + '</div>';
    } else if (isDiscussPage) {
      // 讨论页 → 简化任务卡片和自动回复按钮
      taskSection =
        '<div class="cxai-task-card">'
        + '<div class="cxai-card-head">'
        + '<div class="cxai-card-title"><span class="cxai-pulse"></span>目标讨论</div>'
        + '<span class="cxai-type-pill is-discuss" id="cxai-task-type-pill">主题讨论</span>'
        + '</div>'
        + '<div id="cxai-task-info"><div class="cxai-task-item"><span class="cxai-task-label">状态</span><span class="cxai-task-value cxai-dim">读取话题中...</span></div></div>'
        + '</div>';
      controlSection =
        '<div id="cxai-batch-bar" style="display:none;background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:9px 12px;">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
        + '<span id="cxai-batch-bar-title" style="font-size:12px;font-weight:600;color:#2563eb;">批量执行中</span>'
        + '<span id="cxai-batch-count" style="font-size:12px;color:#475569;"></span>'
        + '</div>'
        + '<div style="height:5px;background:#e2e8f0;border-radius:999px;overflow:hidden;">'
        + '<div id="cxai-batch-progress" style="height:100%;background:linear-gradient(90deg,#4f8ff7,#6366f1);border-radius:999px;transition:width .4s;width:0%;"></div>'
        + '</div>'
        + '</div>'
        + '<div id="cxai-status" class="cxai-status-bar cxai-st-idle">'
        + '<div class="cxai-status-left"><span class="cxai-status-icon">●</span><span class="cxai-status-text">待命中</span></div>'
        + '</div>'
        + '<div class="cxai-progress"><div class="cxai-progress-bar" id="cxai-progress-bar"></div></div>'
        + '<div class="cxai-btn-group">'
        + '<button class="cxai-btn-exec" id="cxai-btn-start">' + cxIcon('sparkles', 14) + '<span>自动生成并回复</span></button>'
        + '<button class="cxai-btn-abort" id="cxai-btn-stop" disabled>' + cxIcon('stop', 13) + '<span>中止</span></button>'
        + '</div>';
    } else {
      // AI实践页 → 单任务信息卡片 + 图片作品辅助卡
      taskSection =
        '<div class="cxai-task-card">'
        + '<div class="cxai-card-head">'
        + '<div class="cxai-card-title"><span class="cxai-pulse"></span>目标任务</div>'
        + '<span class="cxai-type-pill" id="cxai-task-type-pill">读取中</span>'
        + '</div>'
        + '<div id="cxai-task-info"><div class="cxai-task-item"><span class="cxai-task-label">状态</span><span class="cxai-task-value cxai-dim">读取任务中...</span></div></div>'
        + '</div>'
        + '<div id="cxai-image-helper" class="cxai-image-helper" style="display:none;"></div>';
      controlSection =
        '<div id="cxai-batch-bar" style="display:none;background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:9px 12px;">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
        + '<span id="cxai-batch-bar-title" style="font-size:12px;font-weight:600;color:#2563eb;">批量执行中</span>'
        + '<span id="cxai-batch-count" style="font-size:12px;color:#475569;"></span>'
        + '</div>'
        + '<div style="height:5px;background:#e2e8f0;border-radius:999px;overflow:hidden;">'
        + '<div id="cxai-batch-progress" style="height:100%;background:linear-gradient(90deg,#4f8ff7,#6366f1);border-radius:999px;transition:width .4s;width:0%;"></div>'
        + '</div>'
        + '</div>'
        + '<div id="cxai-status" class="cxai-status-bar cxai-st-idle">'
        + '<div class="cxai-status-left"><span class="cxai-status-icon">●</span><span class="cxai-status-text">待命中</span></div>'
        + '<div class="cxai-status-right">得分 <span class="cxai-score" id="cxai-score">--</span></div>'
        + '</div>'
        + '<div class="cxai-progress"><div class="cxai-progress-bar" id="cxai-progress-bar"></div></div>'
        + '<div class="cxai-target-row">'
        + '<label class="cxai-target-label" for="cxai-target-score">' + cxIcon('target', 13) + '<span>目标分数</span></label>'
        + '<input type="number" id="cxai-target-score" class="cxai-target-input" min="0" max="100" value="0" />'
        + '<span class="cxai-target-hint">0 不循环，低于目标自动重练</span>'
        + '</div>'
        + '<div class="cxai-btn-group" id="cxai-primary-actions">'
        + '<button class="cxai-btn-exec" id="cxai-btn-start">' + cxIcon('play', 13) + '<span>开始任务</span></button>'
        + '<button class="cxai-btn-abort" id="cxai-btn-stop" disabled>' + cxIcon('stop', 12) + '<span>中止</span></button>'
        + '</div>'
        + '<div class="cxai-img-note" id="cxai-img-note" style="display:none;">'
        + cxIcon('bulb', 14)
        + '<span>此题仅支持本地上传图片作品，已隐藏自动作答按钮；请使用上方提示词生图后点击页面左侧「选择本地文件」。</span>'
        + '</div>'
        + '<div class="cxai-btn-group" id="cxai-resume-row" style="display:none;">'
        + '<button class="cxai-btn-exec is-emerald" id="cxai-btn-continue" style="display:none;">' + cxIcon('play', 13) + '<span>继续</span></button>'
        + '<button class="cxai-btn-sm cxai-btn-test" id="cxai-btn-eval-now" style="display:none;flex:1;">' + cxIcon('bolt', 13) + '<span>立即评估</span></button>'
        + '</div>';
    }

    panelEl.innerHTML =
      // Header
      '<div class="cxai-header">'
      + '<div class="cxai-header-title">' + cxIcon('brand', 16) + '<span>超星 AI 助手</span></div>'
      + '<div class="cxai-header-actions">'
      + '<button type="button" class="cxai-hdr-btn" id="cxai-btn-dock" title="停靠页面左侧">' + cxIcon('dockLeft', 14) + '</button>'
      + '<button type="button" class="cxai-hdr-btn" id="cxai-btn-min" title="收起面板">' + cxIcon('minimize', 14) + '</button>'
      + '</div>'
      + '</div>'

      + '<div class="cxai-body">'

      // 首次配置引导横幅
      + '<div id="cxai-setup-tip" class="cxai-setup-tip" style="display:none;">'
      + cxIcon('bulb', 15)
      + '<span>首次使用请填写 DeepSeek <b>API Key</b>（自动保存）</span>'
      + '</div>'

      // 系统配置折叠区（精简必填项 + 二级折叠高级参数）
      + '<div class="cxai-section">'
      + '<button type="button" class="cxai-collapsible-header" id="cxai-settings-toggle">'
      + '<span class="cxai-ch-left">' + cxIcon('settings', 14) + '<span>系统配置</span></span>'
      + '<span class="cxai-save-badge" id="cxai-save-indicator">✓ 已自动保存</span>'
      + '<span class="cxai-chevron">▼</span></button>'
      + '<div class="cxai-collapsible-content" id="cxai-settings-body">'
      + '<div class="cxai-field"><label>配置方案</label><div class="cxai-profile-row">'
      + '<select id="cxai-profile-select"></select>'
      + '<button type="button" class="cxai-icon-btn" id="cxai-btn-profile-new" title="新建配置">' + cxIcon('plus', 13) + '</button>'
      + '<button type="button" class="cxai-icon-btn is-danger" id="cxai-btn-profile-del" title="删除当前配置">' + cxIcon('minus', 13) + '</button>'
      + '</div><div id="cxai-profile-inline" class="cxai-profile-inline"></div></div>'
      + '<div class="cxai-field"><label>API Key</label><div class="cxai-input-with-eye"><input type="password" id="cxai-apikey" placeholder="sk-..." /><button type="button" class="cxai-eye-btn" id="cxai-eye-btn" title="显示/隐藏">' + cxIcon('eye', 14) + '</button></div></div>'
      + '<div class="cxai-row cxai-row-3">'
      + '<div class="cxai-field"><label>模型</label><select id="cxai-model"><option value="deepseek-flash">deepseek-flash (V4.1)</option><option value="deepseek-v4-pro">deepseek-v4-pro (V4 Pro)</option></select></div>'
      + '<div class="cxai-field"><label>轮数</label><input type="number" id="cxai-rounds" min="1" max="20" value="5" /></div>'
      + '<div class="cxai-field"><label>间隔(s)</label><input type="number" id="cxai-delay" min="0" max="30" value="3" /></div>'
      + '</div>'
      + '<div class="cxai-adv-wrap">'
      + '<button type="button" class="cxai-adv-toggle" id="cxai-adv-toggle"><span>高级参数（接口 / 思考 / 风格 / 字数）</span><span class="cxai-chevron">▼</span></button>'
      + '<div class="cxai-adv-body" id="cxai-adv-body">'
      + '<div class="cxai-field"><label>接口地址</label><input type="text" id="cxai-baseurl" placeholder="https://api.deepseek.com" /></div>'
      + '<div class="cxai-field"><label>思考模式 (DeepSeek V4)</label><select id="cxai-thinking-mode"><option value="none">关闭（快速直出 · 推荐）</option><option value="low">低强度思考 (low)</option><option value="high">高强度思考 (high)</option></select></div>'
      + '<div class="cxai-field"><label>对话风格</label><select id="cxai-prompt-style"><option value="balanced">专业均衡（默认）</option><option value="curious">探究追问</option><option value="deep">落地实战</option><option value="concise">精准高效</option></select></div>'
      + '<div class="cxai-field"><label>补充要求（可选）</label><textarea id="cxai-custom-prompt" rows="2" placeholder="例如：表达更自然口语化；每轮先回应再追问。不会覆盖角色设定。"></textarea></div>'
      + '<div class="cxai-field"><label>讨论回复字数</label>'
      + '<input type="hidden" id="cxai-discuss-length" value="medium" />'
      + '<div class="cxai-seg-group" id="cxai-discuss-seg">'
      + '<button type="button" class="cxai-seg-btn" data-val="short">短 · 150字</button>'
      + '<button type="button" class="cxai-seg-btn is-active" data-val="medium">中 · 300字</button>'
      + '<button type="button" class="cxai-seg-btn" data-val="long">长 · 500字</button>'
      + '</div></div>'
      + '</div>'
      + '</div>'
      + '<div class="cxai-btn-group" style="margin-top:9px;">'
      + '<button type="button" class="cxai-btn-sm cxai-btn-save" id="cxai-btn-save">' + cxIcon('save', 13) + '<span>保存</span></button>'
      + '<button type="button" class="cxai-btn-sm cxai-btn-test" id="cxai-btn-test">' + cxIcon('plug', 13) + '<span>测试连接</span></button>'
      + '</div>'
      + '<div id="cxai-usage-info" class="cxai-usage-box">暂无调用记录</div>'
      + '</div></div>'

      // 任务区
      + taskSection

      // 控制区
      + controlSection

      // 评估摘要卡片
      + '<div id="cxai-eval-card" class="cxai-eval-card"></div>'

      // 轻量可折叠运行日志抽屉（闭合时单行摘要预览 + 脉冲状态点）
      + '<div class="cxai-section cxai-log-card">'
      + '<button type="button" class="cxai-collapsible-header" id="cxai-log-toggle">'
      + '<span class="cxai-ch-left">' + cxIcon('terminal', 14) + '<span>运行日志</span><span class="cxai-live-dot" id="cxai-live-dot"></span><span class="cxai-log-preview" id="cxai-log-preview">等待启动</span></span>'
      + '<span class="cxai-chevron">▼</span></button>'
      + '<div class="cxai-collapsible-content cxai-log-body" id="cxai-log-body">'
      + '<div class="cxai-log" id="cxai-log"></div>'
      + '</div></div>'

      // 执行历史折叠区
      + '<div class="cxai-section">'
      + '<button type="button" class="cxai-collapsible-header" id="cxai-history-toggle">'
      + '<span class="cxai-ch-left">' + cxIcon('history', 14) + '<span>执行历史</span></span>'
      + '<span class="cxai-chevron">▼</span></button>'
      + '<div class="cxai-collapsible-content" id="cxai-history-body">'
      + '<div id="cxai-history-list" style="max-height:200px;overflow-y:auto;"></div>'
      + '<div style="text-align:right;margin-top:6px;">'
      + '<button type="button" class="cxai-btn-sm cxai-btn-test" id="cxai-btn-clear-history" style="flex:none;font-size:11px;padding:3px 9px;">清空</button>'
      + '</div>'
      + '</div></div>'

      + '</div>';
    document.body.appendChild(panelEl);

    // 获取 DOM 引用
    logEl = panelEl.querySelector('#cxai-log');
    logPreviewEl = panelEl.querySelector('#cxai-log-preview');
    statusEl = panelEl.querySelector('#cxai-status');
    liveDotEl = panelEl.querySelector('#cxai-live-dot');
    progressBarEl = panelEl.querySelector('#cxai-progress-bar');
    startBtn = panelEl.querySelector('#cxai-btn-start');
    stopBtn = panelEl.querySelector('#cxai-btn-stop');
    taskInfoEl = panelEl.querySelector('#cxai-task-info');
    scoreEl = panelEl.querySelector('#cxai-score');
    evalCardEl = panelEl.querySelector('#cxai-eval-card');

    function applyDockSide(side) {
      dockSide = side === 'left' ? 'left' : 'right';
      if (dockSide === 'left') {
        panelEl.style.left = '12px';
        panelEl.style.right = 'auto';
        panelEl.style.top = '12px';
        toggleBtn.classList.add('cxai-dock-left');
      } else {
        panelEl.style.left = '';
        panelEl.style.top = '';
        panelEl.style.right = '12px';
        toggleBtn.classList.remove('cxai-dock-left');
      }
      var dBtn = panelEl.querySelector('#cxai-btn-dock');
      if (dBtn) {
        dBtn.innerHTML = cxIcon(dockSide === 'left' ? 'dockRight' : 'dockLeft', 14);
        dBtn.title = dockSide === 'left' ? '停靠页面右侧' : '停靠页面左侧';
      }
    }

    function saveUiState() {
      var o = {};
      o[K.UI_STATE] = {
        panelOpen: !panelEl.classList.contains('cxai-hidden'),
        left: panelEl.style.left || '',
        top: panelEl.style.top || '',
        dockSide: dockSide
      };
      storageSet(o);
    }

    // Toggle 按钮
    toggleBtn.addEventListener('click', function () {
      var hidden = panelEl.classList.toggle('cxai-hidden');
      toggleBtn.style.display = hidden ? '' : 'none';
      saveUiState();
    });

    // 左右停靠切换按钮
    var dockBtn = panelEl.querySelector('#cxai-btn-dock');
    if (dockBtn) {
      dockBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var nextSide = dockSide === 'left' ? 'right' : 'left';
        applyDockSide(nextSide);
        saveUiState();
        toast(nextSide === 'left' ? '面板已停靠到左侧' : '面板已停靠到右侧', 'info');
      });
    }

    // 最小化
    panelEl.querySelector('#cxai-btn-min').addEventListener('click', function (e) {
      e.stopPropagation();
      panelEl.classList.add('cxai-hidden');
      toggleBtn.style.display = '';
      saveUiState();
    });

    // 设置按钮与自动保存
    panelEl.querySelector('#cxai-btn-save').addEventListener('click', function () { saveConfig(false); });
    panelEl.querySelector('#cxai-btn-test').addEventListener('click', testConnection);
    ['#cxai-apikey', '#cxai-baseurl', '#cxai-rounds', '#cxai-delay', '#cxai-custom-prompt', '#cxai-target-score'].forEach(function (sel) {
      var el = panelEl.querySelector(sel);
      if (el) el.addEventListener('input', scheduleAutoSave);
    });
    ['#cxai-model', '#cxai-thinking-mode', '#cxai-prompt-style', '#cxai-discuss-length'].forEach(function (sel) {
      var el = panelEl.querySelector(sel);
      if (el) el.addEventListener('change', scheduleAutoSave);
    });

    // 讨论字数分段胶囊按钮
    panelEl.querySelectorAll('.cxai-seg-btn[data-val]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = btn.dataset.val;
        var dlInput = panelEl.querySelector('#cxai-discuss-length');
        if (dlInput) dlInput.value = val;
        panelEl.querySelectorAll('.cxai-seg-btn[data-val]').forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        scheduleAutoSave();
      });
    });

    // 二级高级参数折叠
    var advToggle = panelEl.querySelector('#cxai-adv-toggle');
    var advBody = panelEl.querySelector('#cxai-adv-body');
    if (advToggle && advBody) {
      advToggle.addEventListener('click', function () {
        var isOpen = advBody.classList.toggle('cxai-open');
        advToggle.classList.toggle('cxai-open', isOpen);
      });
    }

    // API Key 显示/隐藏
    var eyeBtn = panelEl.querySelector('#cxai-eye-btn');
    if (eyeBtn) {
      eyeBtn.addEventListener('click', function () {
        var input = panelEl.querySelector('#cxai-apikey');
        if (input.type === 'password') {
          input.type = 'text';
          eyeBtn.innerHTML = cxIcon('eyeOff', 14);
        } else {
          input.type = 'password';
          eyeBtn.innerHTML = cxIcon('eye', 14);
        }
      });
    }

    // Profile 切换/行内新建/行内删除（避免 iframe 中浏览器阻断 prompt/confirm）
    var profileSel = panelEl.querySelector('#cxai-profile-select');
    var profileInline = panelEl.querySelector('#cxai-profile-inline');
    if (profileSel) {
      renderProfileList();
      profileSel.addEventListener('change', function () {
        if (profileInline) profileInline.classList.remove('cxai-open');
        switchProfile(this.value);
      });
      panelEl.querySelector('#cxai-btn-profile-new').addEventListener('click', function () {
        if (!profileInline) return;
        var defName = '课程' + (Object.keys(profiles).length + 1);
        profileInline.innerHTML =
          '<input type="text" id="cxai-profile-new-input" value="' + escHtml(defName) + '" placeholder="输入配置名称" />'
          + '<button type="button" class="cxai-mini-btn is-primary" id="cxai-profile-ok">创建</button>'
          + '<button type="button" class="cxai-mini-btn" id="cxai-profile-cancel">取消</button>';
        profileInline.classList.add('cxai-open');
        var inp = profileInline.querySelector('#cxai-profile-new-input');
        var confirmCreate = function () {
          var v = inp ? inp.value.trim() : '';
          profileInline.classList.remove('cxai-open');
          if (v) createProfile(v);
        };
        profileInline.querySelector('#cxai-profile-ok').addEventListener('click', confirmCreate);
        profileInline.querySelector('#cxai-profile-cancel').addEventListener('click', function () {
          profileInline.classList.remove('cxai-open');
        });
        if (inp) {
          inp.focus();
          inp.select();
          inp.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') confirmCreate();
            else if (ev.key === 'Escape') profileInline.classList.remove('cxai-open');
          });
        }
      });
      panelEl.querySelector('#cxai-btn-profile-del').addEventListener('click', function () {
        if (Object.keys(profiles).length <= 1) {
          toast('至少需保留一个配置', 'warn');
          return;
        }
        if (!profileInline) return;
        profileInline.innerHTML =
          '<span class="cxai-inline-confirm-text">删除「' + escHtml(activeProfile) + '」？</span>'
          + '<button type="button" class="cxai-mini-btn is-danger" id="cxai-profile-del-ok">确认删除</button>'
          + '<button type="button" class="cxai-mini-btn" id="cxai-profile-cancel">取消</button>';
        profileInline.classList.add('cxai-open');
        profileInline.querySelector('#cxai-profile-del-ok').addEventListener('click', function () {
          profileInline.classList.remove('cxai-open');
          deleteProfile(activeProfile);
        });
        profileInline.querySelector('#cxai-profile-cancel').addEventListener('click', function () {
          profileInline.classList.remove('cxai-open');
        });
      });
    }

    // 初始化 usage UI
    updateUsageUI();

    // 页面特定事件
    if (isTaskListPage) {
      panelEl.querySelector('#cxai-btn-scan').addEventListener('click', startCollect);
      panelEl.querySelector('#cxai-btn-selall').addEventListener('click', toggleSelectAll);
      var selUndoneBtn = panelEl.querySelector('#cxai-btn-selundone');
      if (selUndoneBtn) selUndoneBtn.addEventListener('click', selectUndoneOnly);
      panelEl.querySelector('#cxai-btn-batch-exec').addEventListener('click', startBatchExecute);
      var autoAiEl = panelEl.querySelector('#cxai-batch-auto-ai');
      if (autoAiEl) {
        autoAiEl.addEventListener('change', function () {
          batchAutoRunAi = !!autoAiEl.checked;
          var o = {}; o[K.BATCH_AUTO_AI] = batchAutoRunAi;
          storageSet(o);
        });
      }
    } else if (isDiscussPage) {
      startBtn.addEventListener('click', function () { runDiscussTask(); });
      stopBtn.addEventListener('click', stopTask);
    } else {
      startBtn.addEventListener('click', function () { runTaskWithRetry(); });
      stopBtn.addEventListener('click', stopTask);
      continueBtn = panelEl.querySelector('#cxai-btn-continue');
      continueBtn.addEventListener('click', function () { continueAutoTask(); });
      evalNowBtn = panelEl.querySelector('#cxai-btn-eval-now');
      if (evalNowBtn) evalNowBtn.addEventListener('click', function () { evaluateCurrentTaskNow(); });
    }

    // 设置折叠
    var settingsToggle = panelEl.querySelector('#cxai-settings-toggle');
    var settingsBody = panelEl.querySelector('#cxai-settings-body');
    settingsToggle.addEventListener('click', function () {
      var isOpen = settingsBody.classList.toggle('cxai-open');
      settingsToggle.classList.toggle('cxai-open', isOpen);
    });

    // 日志折叠
    var logToggle = panelEl.querySelector('#cxai-log-toggle');
    var logBody = panelEl.querySelector('#cxai-log-body');
    if (logToggle && logBody) {
      logToggle.addEventListener('click', function () {
        var isOpen = logBody.classList.toggle('cxai-open');
        logToggle.classList.toggle('cxai-open', isOpen);
        if (isOpen && logEl) logEl.scrollTop = logEl.scrollHeight;
      });
    }

    // 历史折叠
    var historyToggle = panelEl.querySelector('#cxai-history-toggle');
    var historyBody = panelEl.querySelector('#cxai-history-body');
    if (historyToggle && historyBody) {
      historyToggle.addEventListener('click', function () {
        var isOpen = historyBody.classList.toggle('cxai-open');
        historyToggle.classList.toggle('cxai-open', isOpen);
      });
      panelEl.querySelector('#cxai-btn-clear-history').addEventListener('click', function () {
        var clearH = {}; clearH[K.HISTORY] = [];
        storageSet(clearH);
        renderHistory([]);
      });
      // 初始加载历史
      storageGet([K.HISTORY], function (r) {
        renderHistory(r[K.HISTORY] || []);
      });
    }

    // 拖拽功能
    (function () {
      var header = panelEl.querySelector('.cxai-header');
      var isDragging = false, startX, startY, startLeft, startTop;

      header.addEventListener('mousedown', function (e) {
        if (e.target.closest('.cxai-header-actions')) return;
        isDragging = true;
        var rect = panelEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        panelEl.classList.add('cxai-dragging');
        panelEl.style.right = 'auto';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        var newLeft = Math.round(Math.max(0, Math.min(window.innerWidth - panelEl.offsetWidth, startLeft + dx)));
        var newTop = Math.round(Math.max(0, Math.min(window.innerHeight - 50, startTop + dy)));
        panelEl.style.left = newLeft + 'px';
        panelEl.style.top = newTop + 'px';
      });

      document.addEventListener('mouseup', function () {
        if (isDragging) {
          isDragging = false;
          panelEl.classList.remove('cxai-dragging');
          saveUiState();
        }
      });

      // 双击 header 复位到默认位置（右上角）
      header.addEventListener('dblclick', function (e) {
        if (e.target.closest('.cxai-header-actions')) return;
        applyDockSide('right');
        saveUiState();
        toast('面板位置已复位', 'info');
      });
    })();

    // 键盘快捷键: ESC 停止任务
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isRunning && typeof stopTask === 'function') {
        stopTask();
      }
    });

    fillConfigUI();
    loadTotalStats();

    // 恢复面板位置/停靠侧/展开状态、批量选项，并在未配置 API Key 时自动引导
    storageGet([K.UI_STATE, K.BATCH_AUTO_AI], function (r) {
      var ui = r[K.UI_STATE] || {};
      var hasApiKey = !!(config.apiKey && config.apiKey.trim());
      if (ui.dockSide === 'left') {
        applyDockSide('left');
      }
      if (ui.left && ui.top && !(ui.dockSide === 'left' && ui.left === '12px')) {
        var maxL = Math.max(0, window.innerWidth - 360);
        var maxT = Math.max(0, window.innerHeight - 60);
        var lNum = Math.max(0, Math.min(maxL, parseInt(ui.left, 10) || 0));
        var tNum = Math.max(0, Math.min(maxT, parseInt(ui.top, 10) || 12));
        panelEl.style.right = 'auto';
        panelEl.style.left = lNum + 'px';
        panelEl.style.top = tNum + 'px';
      }
      if (!hasApiKey) {
        panelEl.classList.remove('cxai-hidden');
        toggleBtn.style.display = 'none';
        if (settingsBody && settingsToggle) {
          settingsBody.classList.add('cxai-open');
          settingsToggle.classList.add('cxai-open');
        }
        var setupTipEl = panelEl.querySelector('#cxai-setup-tip');
        if (setupTipEl) setupTipEl.style.display = 'flex';
      } else if (!isDiscussPage && ui.panelOpen === true) {
        panelEl.classList.remove('cxai-hidden');
        toggleBtn.style.display = 'none';
      }
      var autoAiCb = panelEl.querySelector('#cxai-batch-auto-ai');
      if (autoAiCb) {
        var val = r[K.BATCH_AUTO_AI];
        batchAutoRunAi = (val === undefined) ? true : !!val;
        autoAiCb.checked = batchAutoRunAi;
      }
    });
  }

  // ==================== 入口 ====================

  var _taskInfoRetries = 0;
  function loadTaskInfo() {
    pageCall('getState').then(function (st) {
      renderTaskInfo(st);
      // 若数据为空（title 是兜底值或 requirement 为空），说明页面还没渲染完，最多重试 5 次
      if ((!st.title || st.title === 'AI实践' || st.title === 'AI实践-作答') && !st.requirement && _taskInfoRetries < 5) {
        _taskInfoRetries++;
        setTimeout(loadTaskInfo, 3000);
      }
    }).catch(function () {
      if (_taskInfoRetries < 5) {
        _taskInfoRetries++;
        setTimeout(loadTaskInfo, 3000);
      }
    });
  }

  function loadDiscussInfo() {
    pageCall('getDiscussState').then(function (st) {
      if (!taskInfoEl) return;
      var typePill = panelEl ? panelEl.querySelector('#cxai-task-type-pill') : null;
      if (typePill) {
        typePill.className = 'cxai-type-pill is-discuss';
        typePill.textContent = '主题讨论';
      }
      taskInfoEl.innerHTML =
        '<div class="cxai-task-item"><span class="cxai-task-label">讨论话题</span><span class="cxai-task-value">' + escHtml(truncate(st.topicTitle || st.topicContent || '-', 60)) + '</span></div>'
        + '<div class="cxai-task-stats">'
        + '<div class="cxai-task-stat"><span>回复状态</span><span class="cxai-stat-val">' + (st.canReply ? '可回复' : '已锁定') + '</span></div>'
        + '</div>';
    }).catch(function () {
      setTimeout(function () {
        loadDiscussInfo();
      }, 5000);
    });
  }

  function init() {
    if (!isSupportedPage) return;
    loadConfig(function () {
      createPanel();
      if (isTaskListPage) {
        log('READY: 任务列表页已就绪，点击扫描按钮加载任务', 'info');
        setTimeout(restoreScanCache, 800);
      } else if (isDiscussPage) {
        log('READY: 主题讨论页已就绪，点击"自动回复"开始', 'info');
        setTimeout(loadDiscussInfo, 2000);
        setTimeout(checkBatchAutoStart, T.RUN_RETRY_AUTO_DELAY);
      } else {
        setTimeout(loadTaskInfo, 2000);
        // 检查是否有待恢复的重试、批量或思维阶梯任务
        setTimeout(function () {
          storageGet([K.RETRY_STATE, LADDER_STATE_KEY], function (r) {
            if (r[LADDER_STATE_KEY] && r[LADDER_STATE_KEY].count) {
              checkThinkLadderAutoStart();
            } else if (r[K.RETRY_STATE] && r[K.RETRY_STATE].targetScore) {
              checkRetryAutoStart();
            } else {
              checkBatchAutoStart();
            }
          });
        }, T.RUN_RETRY_AUTO_DELAY);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
