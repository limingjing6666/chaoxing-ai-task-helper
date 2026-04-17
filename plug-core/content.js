(function () {
  'use strict';

  // ==================== 共享常量（有 fallback 保底） ====================
  var _CONST = window.CXAI_CONST || {};
  var K = _CONST.STORAGE_KEYS || {
    CONFIG: 'cxai_config', PROFILES: 'cxai_profiles', ACTIVE_PROFILE: 'cxai_active_profile',
    HISTORY: 'cxai_history', RETRY_STATE: 'cxai_retry_state',
    BATCH_QUEUE: 'cxai_batch_queue', BATCH_AUTO: 'cxai_batch_auto',
    BATCH_TOTAL: 'cxai_batch_total', BATCH_TASKS: 'cxai_batch_tasks',
    BATCH_FAILED: 'cxai_batch_failed', SCAN_CACHE: 'cxai_scan_cache', STATS: 'cxai_stats'
  };
  var T = _CONST.TIMEOUTS || {
    PAGE_CALL: 120000, DEEPSEEK_DEFAULT_MAX_TOKENS: 1200, DEEPSEEK_DOC_MAX_TOKENS: 4000,
    RETRY_DELAY: 3000, EMPTY_REPLY_RETRY: 3000, SUBMIT_WAIT: 3000, RUN_RETRY_AUTO_DELAY: 4000,
    FILE_PARSE: 60000
  };
  var L = _CONST.LIMITS || { MAX_HISTORY: 50, MAX_RETRY_ATTEMPTS: 10, SCAN_CACHE_TTL: 3600000 };
  var PRICING = _CONST.PRICING || {
    'deepseek-chat':     { input: 2.0, output: 8.0 },
    'deepseek-reasoner': { input: 4.0, output: 16.0 }
  };

  // ==================== 配置 ====================
  const DEFAULT_CONFIG = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
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
  let activeProfile = 'default';   // 当前 profile 名
  let profiles = {};                // { name: config }
  let sessionUsage = { input: 0, output: 0, cost: 0, calls: 0 }; // 本次会话累计

  // DOM 引用
  let panelEl, logEl, statusEl, progressBarEl, startBtn, stopBtn, continueBtn, taskInfoEl;

  // 页面检测
  var isTaskListPage = location.hostname === 'mobilelearn.chaoxing.com' && location.pathname.indexOf('/page/active/stuActiveList') !== -1;
  var isAiPracticePage = /\/ai-evaluate\//.test(location.pathname) || /\/mooc2-ans\/ai-evaluate\//.test(location.pathname);
  var isDiscussPage = (
    location.pathname.indexOf('/page/active/stuTopicDetail') !== -1
    || location.pathname.indexOf('/page/active/') !== -1 && /topic|discuss|reply/i.test(location.href)
    || location.pathname.indexOf('/bbs/') !== -1
    || location.hostname === 'groupweb.chaoxing.com' && (
      location.pathname.indexOf('/course/topicDiscuss') !== -1
      || location.pathname.indexOf('/pc/topic/jumpToTopicDetail') !== -1
    )
    || /回复话题|话题详情|主题讨论/.test(document.title)
    || !!document.querySelector('textarea[placeholder*="回复话题"], textarea[placeholder*="回复"], .reply-box textarea, .reply-topic textarea, .editContainer .replyEdit textarea')
  );
  var isSupportedPage = isTaskListPage || isAiPracticePage || isDiscussPage;

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
    // 平滑滚动到底
    logEl.scrollTo({ top: logEl.scrollHeight, behavior: 'smooth' });
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

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.className = 'cxai-status-bar cxai-st-' + cls;
    statusEl.querySelector('.cxai-status-text').textContent = text;
    if (liveDotEl) {
      if (cls === 'running') liveDotEl.classList.add('cxai-active');
      else liveDotEl.classList.remove('cxai-active');
    }
    if (scoreEl && cls === 'done') {
      var m = text.match(/(\d+)/);
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
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) return reject(new Error(normalizeRuntimeError(chrome.runtime.lastError)));
        if (!resp) return reject(new Error('无响应'));
        if (resp.success) resolve(resp.data);
        else reject(new Error(resp.error || '未知错误'));
      });
    });
  }

  // bgChat: 发送 DeepSeek 请求，自动累计 token/费用
  function bgChat(payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(Object.assign({ type: 'DEEPSEEK_CHAT' }, payload), function (resp) {
        if (chrome.runtime.lastError) return reject(new Error(normalizeRuntimeError(chrome.runtime.lastError)));
        if (!resp) return reject(new Error('无响应'));
        if (!resp.success) return reject(new Error(resp.error || '未知错误'));
        if (resp.usage) recordUsage(payload.model || config.model, resp.usage);
        resolve(resp.data);
      });
    });
  }

  // ==================== Token 统计 ====================
  function recordUsage(model, usage) {
    var inputT = usage.prompt_tokens || 0;
    var outputT = usage.completion_tokens || 0;
    var p = PRICING[model] || PRICING['deepseek-chat'];
    var cost = (inputT / 1e6) * p.input + (outputT / 1e6) * p.output;

    sessionUsage.input += inputT;
    sessionUsage.output += outputT;
    sessionUsage.cost += cost;
    sessionUsage.calls += 1;
    updateUsageUI();

    // 累计到 storage
    chrome.storage.local.get([K.STATS], function (r) {
      var s = r[K.STATS] || { input: 0, output: 0, cost: 0, calls: 0 };
      s.input += inputT;
      s.output += outputT;
      s.cost += cost;
      s.calls += 1;
      var o = {}; o[K.STATS] = s;
      chrome.storage.local.set(o);
    });
  }

  function updateUsageUI() {
    if (!panelEl) return;
    var el = panelEl.querySelector('#cxai-usage-info');
    if (!el) return;
    el.innerHTML = '<span>📊 本次: ' + sessionUsage.calls + ' 次调用</span>'
      + ' · <span>' + formatTokens(sessionUsage.input + sessionUsage.output) + ' tokens</span>'
      + ' · <span style="color:#4f8ff7;font-weight:600;">¥' + sessionUsage.cost.toFixed(4) + '</span>';
  }

  function formatTokens(n) {
    if (n < 1000) return n + '';
    if (n < 1e6) return (n / 1000).toFixed(1) + 'K';
    return (n / 1e6).toFixed(2) + 'M';
  }

  // ==================== 执行历史 ====================

  function saveHistory(record) {
    record.time = new Date().toLocaleString('zh-CN', { hour12: false });
    chrome.storage.local.get([K.HISTORY], function (r) {
      var list = r[K.HISTORY] || [];
      list.unshift(record);
      if (list.length > L.MAX_HISTORY) list = list.slice(0, L.MAX_HISTORY);
      var setObj = {}; setObj[K.HISTORY] = list;
      chrome.storage.local.set(setObj);
      renderHistory(list);
    });
  }

  function renderHistory(list) {
    var el = panelEl ? panelEl.querySelector('#cxai-history-list') : null;
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = '<div style="color:#999;font-size:11px;padding:16px 8px;text-align:center;">📋 还没有执行记录<br/><span style="color:#bbb;font-size:10px;">完成任务后会出现在这里</span></div>';
      return;
    }
    var typeIcons = { tech: '💻', business: '📊', writing: '✍', design: '🎨' };
    var modeIcons = { file: '📄', chat: '💬', discuss: '💭' };
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
      var icon = modeIcons[h.taskMode] || typeIcons[h.type] || '📋';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 2px;border-bottom:1px solid #f0f0f0;font-size:11px;">'
        + '<div style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;">'
        + '<span style="font-size:13px;">' + icon + '</span>'
        + '<span style="color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(h.title || '') + '">' + escHtml(truncate(h.title || '未知', 18)) + '</span>'
        + '</div>'
        + '<div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">'
        + '<span class="cxai-score-badge ' + scoreCls(h.score) + '">' + escHtml(String(h.score)) + '</span>'
        + '<span style="color:#aaa;font-size:10px;">' + escHtml((h.time || '').replace(/^\d{4}\//, '')) + '</span>'
        + '</div></div>';
    }
    el.innerHTML = html;
  }

  // ==================== DeepSeek ====================

  function getRoundStrategy(current, total) {
    if (total <= 2) return '';
    const ratio = current / total;
    if (ratio < 0.34) {
      return '\n\n【当前阶段：切入(第' + (current + 1) + '/' + total + '轮)】\n'
        + '- 先确认核心概念，用专业术语精准描述你的理解\n'
        + '- 主动关联相关技术栈，展示知识面\n'
        + '- 提出一个有技术深度的问题，引导对话进入核心区域';
    } else if (ratio < 0.67) {
      return '\n\n【当前阶段：深入(第' + (current + 1) + '/' + total + '轮)】\n'
        + '- 围绕任务要求中的具体技术点展开讨论\n'
        + '- 用实际操作命令或代码片段验证理解\n'
        + '- 对比不同方案的优劣，体现工程思维\n'
        + '- 提出实际开发中可能遇到的问题和解决思路';
    } else {
      return '\n\n【当前阶段：收尾(第' + (current + 1) + '/' + total + '轮)】\n'
        + '- 系统性总结所讨论的技术要点，形成完整知识框架\n'
        + '- 说明你将如何在实际项目中应用这些知识\n'
        + '- 提出进一步学习的方向和延伸思考';
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

  // 角色推断辅助
  function inferRoles(scene, requirement, title) {
    var combined = String(title || '') + '\n' + String(requirement || '') + '\n' + String(scene || '');
    
    // 默认角色
    var myRole = '任务执行者/参与者';
    var aiRole = '任务考官/对话对象';
    
    // 尝试匹配 "扮演..." 或 "你是..."
    var myRoleMatch = combined.match(/(?:你(?:将)?扮演|你是|作为|你是一名?)([^，。！\n]{2,15})/);
    if (myRoleMatch && !myRoleMatch[1].includes('回答') && !myRoleMatch[1].includes('准备')) {
      myRole = myRoleMatch[1];
    }
    
    // 尝试匹配 "AI扮演..." 或 "对方是..." 或 "面对的..."
    var aiRoleMatch = combined.match(/(?:AI(?:将)?扮演|对方是|面对(?:的)?是一名?)([^，。！\n]{2,15})/);
    if (aiRoleMatch) {
      aiRole = aiRoleMatch[1];
    } else {
      // 检查是否包含"老师"、"客服"、"客户"等明显身份线索
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
    
    return { myRole: myRole, aiRole: aiRole };
  }

  function buildDeepSeekMessages(conversationHistory, taskInfo) {
    var profile = taskInfo.taskProfile || detectTaskTypeProfile(taskInfo.title, taskInfo.requirement, taskInfo.scene);
    var taskType = profile.type;
    var tp = TASK_TYPES[taskType] || TASK_TYPES.tech;
    var effectivePromptStyle = profile.lowConfidence ? 'balanced' : (taskInfo.promptStyle || 'balanced');
    
    // 动态提取角色关系
    var roles = inferRoles(taskInfo.scene, taskInfo.requirement, taskInfo.title);

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
      + '【核心纪律】绝对服从你的角色设定（' + roles.myRole + '），并以恰当的称谓与对方（' + roles.aiRole + '）交流。禁止破离角色。禁止说自己是AI或语言模型。\n\n'
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
    var roles = inferRoles(taskInfo.scene, taskInfo.requirement, taskInfo.title);
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

    chrome.runtime.sendMessage({
      type: 'DEEPSEEK_TEST',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    }, (resp) => {
      testBtn.disabled = false;
      testBtn.textContent = '测试连接';
      if (chrome.runtime.lastError) {
        var msg = normalizeRuntimeError(chrome.runtime.lastError);
        log('❌ 通信失败: ' + msg, 'error');
        toast('连接失败: ' + msg, 'error');
        return;
      }
      if (resp && resp.success) {
        log('✓ ' + resp.data, 'success');
        toast('连接成功', 'success');
      } else {
        var err = resp ? resp.error : '未知错误';
        log('❌ ' + err, 'error');
        toast('连接失败: ' + err, 'error');
      }
    });
  }

  // ==================== 对话型任务 ====================

  async function runChatTask(st, detectedType, taskProfile, startFromRound) {
    var roles = inferRoles(st.scene, st.requirement, st.title);
    log('ROLE: 你的身份 → ' + roles.myRole, 'info');
    log('ROLE: 对方身份 → ' + roles.aiRole, 'info');
    log('STYLE: 当前风格 → ' + (PROMPT_STYLE_LABELS[config.promptStyle || 'balanced'] || (config.promptStyle || 'balanced')), 'info');

    let messages = st.messages || [];
    if (messages.length > 0 && !startFromRound) {
      log('✓ AI老师开场白: ' + truncate(messages[0].content, 60), 'chat-teacher');
    }

    const rounds = config.rounds;
    var resumeFrom = startFromRound || 0;
    const baseCtx = { title: st.title, requirement: st.requirement, scene: st.scene, customPrompt: config.customPrompt, promptStyle: config.promptStyle, retryFeedback: config.retryFeedback || '', taskProfile: taskProfile || null };
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
      log('AI: DeepSeek 生成回复中...', 'info');
      const studentReply = await callDeepSeekSafe(messages, taskCtx);
      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      log('READY: 回复已生成', 'success');

      if (i > 0 && config.delay > 0) {
        log('WAIT: ' + config.delay + 's...', 'info');
        await sleep(config.delay * 1000);
        if (!isRunning) { log('⚠ 已停止', 'warn'); return; }
      }

      if (!studentReply || !studentReply.trim()) {
        log('⚠ 学生回复为空，跳过本轮', 'warn');
        continue;
      }

      log('SEND: 学生 → ' + truncate(studentReply, 80), 'chat-student');
      log('EXEC: 发送消息给AI老师...', 'action');
      let result = await pageCall('sendMessage', { text: studentReply });
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
      + '内容：' + topicContent + '\n\n'
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
    logEl.innerHTML = '';
    updateButtons();

    try {
      if (!config.apiKey) throw new Error('请先设置 DeepSeek API Key');
      setStatus('RUNNING', 'running');
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

  // ==================== 主流程 ====================

  async function continueAutoTask() {
    if (isRunning) return;
    isRunning = true;
    aborted = false;
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
      if (isFileTask) {
        throw new Error('文件型任务不支持继续，请重新开始');
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
        if (evalResult.feedback) {
          lastFeedback = evalResult.feedback;
          if (evalResult.feedback.shortcoming) log('📝 不足: ' + truncate(evalResult.feedback.shortcoming, 100), 'warn');
          if (evalResult.feedback.suggestions && evalResult.feedback.suggestions.length > 0) log('💡 建议: ' + truncate(evalResult.feedback.suggestions.join('; '), 100), 'info');
        }
        saveHistory({ title: st.title, score: evalResult.score, type: detectedType, rounds: config.rounds, taskMode: 'chat' });
      } else {
        log('⚠ 评估结果: ' + JSON.stringify(evalResult), 'warn');
        setStatus('EVAL_ERR', 'error');
        toast('评估失败', 'error');
        saveHistory({ title: st.title, score: 'ERR', type: detectedType, rounds: config.rounds, taskMode: 'chat' });
      }
    } catch (err) {
      log('\n❌ ' + err.message, 'error');
      setStatus('ERROR', 'error');
      toast(err.message || '任务出错', 'error');
      console.error('[ChaoxingAI]', err);
    } finally {
      isRunning = false;
      updateButtons();
    }
  }

  async function startAutoTask() {
    if (isRunning) return;
    isRunning = true;
    aborted = false;
    logEl.innerHTML = '';
    updateButtons();

    try {
      if (!config.apiKey) throw new Error('请先设置 DeepSeek API Key');
      setStatus('RUNNING', 'running');
      setProgress(0);

      // 1. 从 Vue 应用获取当前任务状态
      log('INIT: 读取任务状态...', 'info');
      const st = await pageCall('getState');
      log('LOAD: 任务 → ' + st.title, 'success');
      log('LOAD: 要求 → ' + truncate(st.requirement, 60), 'info');
      renderTaskInfo(st);

      if (st.remainAnswerCount !== undefined && st.remainAnswerCount !== null && st.remainAnswerCount <= 0) {
        throw new Error('作答次数已用尽');
      }
      if (st.recordStatus === 1 || st.recordStatus === 2) {
        throw new Error('当前任务已提交/已评估，请点击"再练一次"新建作答');
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
      if (isFileTask) {
        log('TYPE: 📄 文件上传型任务', 'info');
      } else {
        log('TYPE: 💬 对话型任务', 'info');
      }
      setProgress(5);

      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      if (isFileTask) {
        // ===== 文件上传型任务流程 =====
        await runFileTask(st, detectedType);
      } else {
        // ===== 对话型任务流程 =====
        await runChatTask(st, detectedType, taskProfile);
      }

      if (!isRunning) { log('⚠ 已停止', 'warn'); return; }

      // 提交 + 评估
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
        // 保存评估反馈供重试优化使用
        if (evalResult.feedback) {
          lastFeedback = evalResult.feedback;
          if (evalResult.feedback.shortcoming) {
            log('📝 不足: ' + truncate(evalResult.feedback.shortcoming, 100), 'warn');
          }
          if (evalResult.feedback.suggestions && evalResult.feedback.suggestions.length > 0) {
            log('💡 建议: ' + truncate(evalResult.feedback.suggestions.join('; '), 100), 'info');
          }
        }
        // 记录执行历史
        saveHistory({ title: st.title, score: evalResult.score, type: detectedType, rounds: isFileTask ? 0 : config.rounds, taskMode: isFileTask ? 'file' : 'chat' });
      } else {
        log('⚠ 评估结果: ' + JSON.stringify(evalResult), 'warn');
        setStatus('EVAL_ERR', 'error');
        toast('评估失败', 'error');
        saveHistory({ title: st.title, score: 'ERR', type: detectedType, rounds: isFileTask ? 0 : config.rounds, taskMode: isFileTask ? 'file' : 'chat' });
      }

    } catch (err) {
      log('\n❌ ' + err.message, 'error');
      setStatus('ERROR', 'error');
      toast(err.message || '任务出错', 'error');
      console.error('[ChaoxingAI]', err);
    } finally {
      isRunning = false;
      updateButtons();
    }
  }

  async function runTaskWithRetry() {
    saveConfig();
    aborted = false;
    // 首次手动点击时没有 retryFeedback，只有 checkRetryAutoStart 设置过才有
    if (!config.retryFeedback) config.retryFeedback = '';

    await startAutoTask();

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
      chrome.storage.local.set(clearObj);
      return;
    }

    // 读取重试次数
    var retryState = await new Promise(function (resolve) {
      chrome.storage.local.get([K.RETRY_STATE], function (r) { resolve(r[K.RETRY_STATE] || null); });
    });
    var attempt = retryState ? (retryState.attempt || 1) : 1;

    if (attempt >= L.MAX_RETRY_ATTEMPTS) {
      log('⚠ 已达最大重试次数 (' + L.MAX_RETRY_ATTEMPTS + ')，当前: ' + score, 'warn');
      var clearObj2 = {}; clearObj2[K.RETRY_STATE] = null;
      chrome.storage.local.set(clearObj2);
      return;
    }

    log('RETRY: 分数 ' + score + ' < 目标 ' + config.targetScore + ' (第' + attempt + '次)，准备重新练习...', 'warn');
    await sleep(T.RETRY_DELAY);

    // 保存重试状态 + 评估反馈（页面跳转后恢复）
    var feedbackSummary = '';
    if (lastFeedback) {
      var parts = [];
      if (lastFeedback.shortcoming) parts.push('不足: ' + lastFeedback.shortcoming);
      if (lastFeedback.suggestions && lastFeedback.suggestions.length > 0) parts.push('建议: ' + lastFeedback.suggestions.join('; '));
      if (lastFeedback.points && lastFeedback.points.length > 0) {
        var lowPoints = lastFeedback.points.filter(function (p) { return p.score && parseInt(p.score) < 20; });
        if (lowPoints.length > 0) parts.push('低分项: ' + lowPoints.map(function (p) { return p.name + '(' + p.score + ')'; }).join(', '));
      }
      feedbackSummary = parts.join('\n');
    }
    var setObj = {};
    setObj[K.RETRY_STATE] = { targetScore: config.targetScore, attempt: attempt + 1, feedback: feedbackSummary };
    chrome.storage.local.set(setObj);

    log('RETRY: 点击"重新练习"，页面将跳转...', 'info');
    try {
      await pageCall('retryTask');
      // retryTask 会点击按钮触发页面跳转，新页面加载后 checkRetryAutoStart 接管
    } catch (e) {
      log('RETRY: 重新练习失败 - ' + e.message, 'error');
      var clearObj3 = {}; clearObj3[K.RETRY_STATE] = null;
      chrome.storage.local.set(clearObj3);
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
    chrome.storage.local.set(stopClear);
  }

  function checkRetryAutoStart() {
    chrome.storage.local.get([K.RETRY_STATE], function (r) {
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
      chrome.storage.local.get([K.BATCH_FAILED], function (r) {
        var list = r[K.BATCH_FAILED] || [];
        if (list.indexOf(currentUrl) === -1) list.push(currentUrl);
        var o = {}; o[K.BATCH_FAILED] = list;
        chrome.storage.local.set(o);
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
        chrome.runtime.sendMessage({ type: 'NAVIGATE_TASK', url: nextUrl, queue: queue });
      } else {
        (function () { var o = {}; o[K.BATCH_AUTO] = false; o[K.BATCH_QUEUE] = []; o[K.BATCH_TOTAL] = 0; chrome.storage.local.set(o); })();
        showBatchComplete(total, bar);
      }
    }, 3000);
  }

  function showBatchComplete(total, bar) {
    chrome.storage.local.get([K.BATCH_FAILED], function (r) {
      var failed = r[K.BATCH_FAILED] || [];
      bar.querySelector('#cxai-batch-count').textContent = failed.length > 0
        ? ('完成 · 失败 ' + failed.length + ' 个')
        : '全部完成!';
      bar.querySelector('#cxai-batch-progress').style.width = '100%';
      log('BATCH: 全部 ' + total + ' 个任务执行完成' + (failed.length ? ' · ' + failed.length + ' 个失败' : '!'), 'success');
      if (failed.length > 0) {
        toast('批量完成 · 失败 ' + failed.length + ' 个，可重新扫描后手动重试', 'warn');
      } else {
        toast('批量执行完成 · 共 ' + total + ' 个', 'success');
      }
      // 清除失败记录
      var o = {}; o[K.BATCH_FAILED] = [];
      chrome.storage.local.set(o);
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
      chrome.runtime.sendMessage({ type: 'NAVIGATE_TASK', url: nextUrl, queue: queue });
    });
    bar.querySelector('#cxai-batch-stop-pause').addEventListener('click', function () {
      isPaused = false;
      (function () { var o = {}; o[K.BATCH_AUTO] = false; o[K.BATCH_QUEUE] = []; o[K.BATCH_TOTAL] = 0; chrome.storage.local.set(o); })();
      bar.style.display = 'none';
      log('BATCH: 用户停止批量', 'warn');
    });
  }

  // 渲染批量运行中 UI（带暂停按钮）
  function renderBatchRunningBar(bar) {
    bar.style.display = 'block';
    bar.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
      + '<span style="font-size:12px;font-weight:600;color:#2b7de9;">📋 批量执行中</span>'
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
    chrome.storage.local.get([K.BATCH_AUTO, K.BATCH_QUEUE, K.BATCH_TOTAL], function (r) {
      if (!r[K.BATCH_AUTO]) return;

      var queue = r[K.BATCH_QUEUE] || [];
      var total = r[K.BATCH_TOTAL] || (queue.length + 1);
      var current = total - queue.length;

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

      // AI 实践页：显示确认提示
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
        (function () { var o = {}; o[K.BATCH_AUTO] = false; o[K.BATCH_QUEUE] = []; o[K.BATCH_TOTAL] = 0; chrome.storage.local.set(o); })();
        bar.style.display = 'none';
        log('BATCH: 已放弃未完成的批量任务', 'warn');
      });
    });
  }

  // ==================== 配置存取 ====================

  function loadConfig(cb) {
    chrome.storage.local.get([K.PROFILES, K.ACTIVE_PROFILE, K.CONFIG], (r) => {
      profiles = r[K.PROFILES] || {};
      activeProfile = r[K.ACTIVE_PROFILE] || 'default';

      // 旧版迁移：存在 CONFIG 但没 PROFILES
      if (r[K.CONFIG] && Object.keys(profiles).length === 0) {
        profiles['default'] = { ...DEFAULT_CONFIG, ...r[K.CONFIG] };
        persistProfiles();
      }
      if (!profiles[activeProfile]) {
        // 找不到当前 profile 就用第一个或 default
        var names = Object.keys(profiles);
        activeProfile = names[0] || 'default';
        if (!profiles[activeProfile]) profiles[activeProfile] = { ...DEFAULT_CONFIG };
      }
      config = { ...DEFAULT_CONFIG, ...profiles[activeProfile] };
      if (cb) cb();
    });
  }

  function persistProfiles() {
    var o = {};
    o[K.PROFILES] = profiles;
    o[K.ACTIVE_PROFILE] = activeProfile;
    chrome.storage.local.set(o);
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

  function saveConfig() {
    config.apiKey = panelEl.querySelector('#cxai-apikey').value.trim();
    config.baseUrl = panelEl.querySelector('#cxai-baseurl').value.trim() || DEFAULT_CONFIG.baseUrl;
    config.model = panelEl.querySelector('#cxai-model').value.trim() || DEFAULT_CONFIG.model;
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
    persistProfiles();
    log('✓ 设置已保存 [' + activeProfile + ']', 'success');
    toast('设置已保存', 'success');
  }

  function fillConfigUI() {
    const q = (s) => panelEl.querySelector(s);
    q('#cxai-apikey').value = config.apiKey;
    q('#cxai-baseurl').value = config.baseUrl;
    q('#cxai-model').value = config.model;
    q('#cxai-rounds').value = config.rounds;
    q('#cxai-delay').value = config.delay;
    q('#cxai-custom-prompt').value = config.customPrompt || '';
    q('#cxai-prompt-style').value = config.promptStyle || 'balanced';
    var dlEl = q('#cxai-discuss-length');
    if (dlEl) dlEl.value = config.discussLength || 'medium';
    var tsEl = q('#cxai-target-score');
    if (tsEl) tsEl.value = config.targetScore || 0;
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

      // 数据源0: 当前任务列表页已渲染的 AI 任务（兼容普通任务流中的 AI 实践）
      batchStatus.textContent = '读取页面中的任务项...';
      try {
        var renderedResp = await pageCall('getRenderedAiTaskList');
        if (renderedResp && renderedResp.status && renderedResp.data && renderedResp.data.length > 0) {
          renderedResp.data.forEach(function (t) {
            if (t.url) allTasks.push({ name: t.name || '未命名', url: t.url, source: t.source || 'rendered', taskMode: t.taskMode || 'chat' });
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

      batchTaskSelection = {};
      collectedTasks.forEach(function (t) {
        if (t && t.url) batchTaskSelection[t.url] = true;
      });

      // 存入扫描缓存（带 URL + 时间戳，1小时内恢复）
      var cache = {};
      cache[K.SCAN_CACHE] = {
        url: location.href,
        tasks: collectedTasks,
        time: Date.now(),
      };
      cache[K.BATCH_TASKS] = collectedTasks;
      chrome.storage.local.set(cache);

      if (collectedTasks.length === 0) {
        batchStatus.innerHTML = '<span style="color:#e67e22;">⚠ 未找到可执行任务</span>';
        batchList.innerHTML = '<div style="color:#999;font-size:12px;text-align:center;padding:16px 0;">当前课程没有可执行的 AI 实践或主题讨论任务</div>';
        log('SCAN: 未找到任务', 'warn');
      } else {
        batchStatus.innerHTML = '<span style="color:#1a8a46;">✓ 共 ' + collectedTasks.length + ' 个可执行任务</span>';
        renderBatchList(collectedTasks);
        log('SCAN: 完成，共 ' + collectedTasks.length + ' 个任务', 'success');
      }
    } catch (err) {
      var friendlyErr = normalizeRuntimeError(err);
      batchStatus.innerHTML = '<span style="color:#dc2626;">❌ ' + escHtml(friendlyErr) + '</span>';
      log('SCAN: ' + friendlyErr, 'error');
    } finally {
      isCollecting = false;
      scanBtn.textContent = '📡 重新扫描';
      scanBtn.disabled = false;
    }
  }

  // 尝试恢复上次扫描结果（同一URL + 1小时内）
  function restoreScanCache() {
    if (!isTaskListPage || !panelEl) return;
    chrome.storage.local.get([K.SCAN_CACHE], function (r) {
      var cache = r[K.SCAN_CACHE];
      if (!cache || !cache.tasks || cache.tasks.length === 0) return;
      if (Date.now() - (cache.time || 0) > L.SCAN_CACHE_TTL) return;
      if (cache.url !== location.href) return;

      collectedTasks = cache.tasks;
      batchTaskSelection = {};
      collectedTasks.forEach(function (t) {
        if (t && t.url) batchTaskSelection[t.url] = t.isFinish !== true; // 默认勾选未完成
      });
      var batchStatus = panelEl.querySelector('#cxai-batch-status');
      if (batchStatus) {
        batchStatus.style.display = 'block';
        var ageMin = Math.round((Date.now() - cache.time) / 60000);
        batchStatus.innerHTML = '<span style="color:#2b7de9;">♻ 已恢复上次扫描结果 (' + ageMin + '分钟前 · ' + collectedTasks.length + '个)</span>';
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
      var tag = '';
      if (t.taskMode === 'discuss') tag += '<span class="cxai-batch-item-tag" style="margin-right:6px;background:#eef6ff;color:#2b7de9;">💬 讨论</span>';
      else tag += '<span class="cxai-batch-item-tag" style="margin-right:6px;background:#f3f0ff;color:#6c63ff;">🤖 AI</span>';
      if (t.isFinish === true) tag = '<span class="cxai-batch-item-tag done">✓ 已完成</span>';
      else if (t.isFinish === false) tag = '<span class="cxai-batch-item-tag pending">○ 未完成</span>';
      var checked = !t || !t.url ? false : batchTaskSelection[t.url] !== false;
      html += '<label class="cxai-batch-item ' + (checked ? 'is-checked' : '') + '">'
        + '<input type="checkbox" class="cxai-bp-check" data-idx="' + idx + '" ' + (checked ? 'checked' : '') + ' />'
        + '<span class="cxai-batch-checkmark">✓</span>'
        + '<div style="flex:1;min-width:0;">'
        + '<div class="cxai-batch-item-name">' + escHtml(t.name) + '</div>'
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
    btn.textContent = n > 0 ? '🚀 批量执行 (' + n + ')' : '🚀 批量执行';
    if (selAllBtn) selAllBtn.textContent = allChecked ? '取消全选' : '全选';
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
      // isFinish === true 时不选，其他（false 或 undefined）都选
      var shouldCheck = !(task && task.isFinish === true);
      c.checked = shouldCheck;
      if (shouldCheck) undoneCount++;
      if (task && task.url) batchTaskSelection[task.url] = shouldCheck;
      var item = c.closest('.cxai-batch-item');
      if (item) item.classList.toggle('is-checked', shouldCheck);
    });
    updateBatchExecBtn();
    toast('已选中 ' + undoneCount + ' 个未完成任务', 'info');
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
    var batchObj = {};
    batchObj[K.BATCH_QUEUE] = urls;
    batchObj[K.BATCH_AUTO] = true;
    batchObj[K.BATCH_TOTAL] = total;
    batchObj[K.BATCH_FAILED] = []; // 重置失败列表
    chrome.storage.local.set(batchObj, function () {
      chrome.runtime.sendMessage({ type: 'NAVIGATE_TASK', url: firstUrl, queue: urls });
    });
  }

  // ==================== UI ====================

  function updateButtons() {
    if (startBtn) startBtn.disabled = isRunning;
    if (stopBtn) stopBtn.disabled = !isRunning;
    if (continueBtn) {
      // 中止后且非运行中时显示继续按钮
      continueBtn.style.display = (aborted && !isRunning) ? '' : 'none';
    }
  }

  function renderTaskInfo(td) {
    if (!taskInfoEl) return;
    var taskTypeLabel = td.type === 1 ? '📄 文件上传' : '💬 对话';
    taskInfoEl.innerHTML =
      '<div class="cxai-task-item"><span class="cxai-task-label">任务标题 TITLE</span><span class="cxai-task-value">' + escHtml(td.title || '-') + '</span></div>'
      + '<div class="cxai-task-item"><span class="cxai-task-label">任务要求 REQ</span><span class="cxai-task-value cxai-dim">' + escHtml(truncate(td.requirement, 80) || '-') + '</span></div>'
      + '<div class="cxai-task-stats">'
      + '<div class="cxai-task-stat">类型: <span class="cxai-stat-val">' + taskTypeLabel + '</span></div>'
      + '<div class="cxai-task-stat">剩余: <span class="cxai-stat-val">' + escHtml(td.remainAnswerCount != null ? td.remainAnswerCount : '-') + '</span></div>'
      + '<div class="cxai-task-stat">最高: <span class="cxai-stat-val">' + escHtml(td.answerScore != null ? td.answerScore : '-') + '</span></div>'
      + '</div>';
  }

  function createPanel() {
    var toggleBtn = document.createElement('button');
    toggleBtn.id = 'cxai-toggle-btn';
    toggleBtn.title = '超星AI任务终端';
    toggleBtn.innerHTML = '<svg viewBox="0 0 128 128" width="24" height="24"><rect width="128" height="128" fill="none"/><rect x="16" y="16" width="96" height="96" fill="none" stroke="currentColor" stroke-width="5"/><path d="M16 16v24m0 48v24m96-96v24m0 48v24M16 16h24m-24 96h24m48-96h24m-24 96h24" stroke="currentColor" stroke-width="14" fill="none"/><path d="M44 48l22 16-22 16" stroke="currentColor" stroke-width="12" fill="none" stroke-linecap="square"/><path d="M72 80h20" stroke="currentColor" stroke-width="12" fill="none"/></svg>';
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
        + '<div class="cxai-corner-bl"></div><div class="cxai-corner-br"></div>'
        + '<div class="cxai-card-title"><span class="cxai-pulse"></span>批量任务_BATCH</div>'
        + '<div style="display:flex;gap:8px;margin-bottom:8px;">'
        + '<button class="cxai-btn-exec" id="cxai-btn-scan" style="flex:1;font-size:12px;">📡 扫描任务</button>'
        + '<button class="cxai-btn-sm cxai-btn-test" id="cxai-btn-selundone" style="padding:6px 10px;flex:none;" title="只选未完成">⏳ 仅未完成</button>'
        + '<button class="cxai-btn-sm cxai-btn-test" id="cxai-btn-selall" style="padding:6px 10px;flex:none;">全选</button>'
        + '</div>'
        + '<div id="cxai-batch-status" style="font-size:11px;color:#888;margin-bottom:6px;display:none;"></div>'
        + '<div id="cxai-batch-list" style="max-height:220px;overflow-y:auto;">'
        + '<div style="color:#999;font-size:12px;text-align:center;padding:16px 0;">点击上方按钮扫描当前课程的 AI 实践和主题讨论任务</div>'
        + '</div>'
        + '</div>';
      controlSection =
        '<div id="cxai-status" class="cxai-status-bar cxai-st-idle">'
        + '<div class="cxai-status-left"><span class="cxai-status-icon">◉</span><span class="cxai-status-text">IDLE</span></div>'
        + '</div>'
        + '<div class="cxai-btn-group">'
        + '<button class="cxai-btn-exec" id="cxai-btn-batch-exec" disabled>🚀 批量执行</button>'
        + '</div>';
    } else if (isDiscussPage) {
      // 讨论页 → 简化任务卡片和自动回复按钮
      taskSection =
        '<div class="cxai-task-card">'
        + '<div class="cxai-corner-bl"></div><div class="cxai-corner-br"></div>'
        + '<div class="cxai-card-title"><span class="cxai-pulse"></span>主题讨论_DISCUSS</div>'
        + '<div id="cxai-task-info"><div class="cxai-task-item"><span class="cxai-task-label">STATUS</span><span class="cxai-task-value cxai-dim">加载中...</span></div></div>'
        + '</div>';
      controlSection =
        '<div id="cxai-batch-bar" style="display:none;background:#f0f4ff;border:1px solid #c5dfff;border-radius:8px;padding:10px 14px;">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
        + '<span style="font-size:12px;font-weight:600;color:#2b7de9;">📋 批量执行中</span>'
        + '<span id="cxai-batch-count" style="font-size:12px;color:#555;"></span>'
        + '</div>'
        + '<div style="height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;">'
        + '<div id="cxai-batch-progress" style="height:100%;background:linear-gradient(90deg,#4f8ff7,#6c63ff);border-radius:3px;transition:width .4s;width:0%;"></div>'
        + '</div>'
        + '</div>'
        + '<div id="cxai-status" class="cxai-status-bar cxai-st-idle">'
        + '<div class="cxai-status-left"><span class="cxai-status-icon">◉</span><span class="cxai-status-text">IDLE</span></div>'
        + '</div>'
        + '<div class="cxai-progress"><div class="cxai-progress-bar" id="cxai-progress-bar"></div></div>'
        + '<div class="cxai-btn-group">'
        + '<button class="cxai-btn-exec" id="cxai-btn-start">\u270e \u81ea\u52a8\u56de\u590d</button>'
        + '<button class="cxai-btn-abort" id="cxai-btn-stop" disabled>■ 中止</button>'
        + '</div>';
    } else {
      // AI实践页 → 单任务信息卡片
      taskSection =
        '<div class="cxai-task-card">'
        + '<div class="cxai-corner-bl"></div><div class="cxai-corner-br"></div>'
        + '<div class="cxai-card-title"><span class="cxai-pulse"></span>目标任务信息</div>'
        + '<div id="cxai-task-info"><div class="cxai-task-item"><span class="cxai-task-label">STATUS</span><span class="cxai-task-value cxai-dim">加载中...</span></div></div>'
        + '</div>';
      controlSection =
        // 批量进度条（仅批量模式时显示）
        '<div id="cxai-batch-bar" style="display:none;background:#f0f4ff;border:1px solid #c5dfff;border-radius:8px;padding:10px 14px;">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
        + '<span style="font-size:12px;font-weight:600;color:#2b7de9;">📋 批量执行中</span>'
        + '<span id="cxai-batch-count" style="font-size:12px;color:#555;"></span>'
        + '</div>'
        + '<div style="height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;">'
        + '<div id="cxai-batch-progress" style="height:100%;background:linear-gradient(90deg,#4f8ff7,#6c63ff);border-radius:3px;transition:width .4s;width:0%;"></div>'
        + '</div>'
        + '</div>'
        // 状态 + 进度 + 按钮
        + '<div id="cxai-status" class="cxai-status-bar cxai-st-idle">'
        + '<div class="cxai-status-left"><span class="cxai-status-icon">◉</span><span class="cxai-status-text">IDLE</span></div>'
        + '<div class="cxai-status-right">得分 <span class="cxai-score" id="cxai-score">--</span></div>'
        + '</div>'
        + '<div class="cxai-progress"><div class="cxai-progress-bar" id="cxai-progress-bar"></div></div>'
        + '<div style="display:flex;align-items:center;gap:8px;margin:8px 0;">'
        + '<label style="font-size:11px;color:#666;white-space:nowrap;">🎯 目标分数</label>'
        + '<input type="number" id="cxai-target-score" min="0" max="100" value="0" style="width:56px;padding:6px 8px;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;color:#1a1a1a;font-family:inherit;font-size:12px;outline:none;text-align:center;" />'
        + '<span style="font-size:10px;color:#999;">0 = 不循环，达不到目标自动重试</span>'
        + '</div>'
        + '<div class="cxai-btn-group">'
        + '<button class="cxai-btn-exec" id="cxai-btn-start">▶ 开始任务</button>'
        + '<button class="cxai-btn-abort" id="cxai-btn-stop" disabled>■ 中止</button>'
        + '<button class="cxai-btn-exec" id="cxai-btn-continue" style="display:none;background:#2ecc71;">▶ 继续</button>'
        + '</div>';
    }

    panelEl.innerHTML =
      // Header
      '<div class="cxai-header">'
      + '<div class="cxai-header-title"><svg viewBox="0 0 128 128" width="18" height="18" style="flex-shrink:0"><rect x="16" y="16" width="96" height="96" fill="none" stroke="currentColor" stroke-width="5"/><path d="M16 16v24m0 48v24m96-96v24m0 48v24M16 16h24m-24 96h24m48-96h24m-24 96h24" stroke="currentColor" stroke-width="14" fill="none"/><path d="M44 48l22 16-22 16" stroke="currentColor" stroke-width="12" fill="none" stroke-linecap="square"/><path d="M72 80h20" stroke="currentColor" stroke-width="12" fill="none"/></svg>\u8d85\u661f\u4efb\u52a1\u7ec8\u7aef</div>'
      + '<div class="cxai-header-dots"><span id="cxai-btn-min" title="最小化" style="width:auto;height:auto;background:none;color:#999;font-size:18px;cursor:pointer;line-height:1;">−</span></div>'
      + '</div>'

      + '<div class="cxai-body">'

      // 设置折叠区（两个页面共用）
      + '<div class="cxai-section">'
      + '<button class="cxai-collapsible-header" id="cxai-settings-toggle">'
      + '<span>⚙ 系统配置_SYS</span><span class="cxai-chevron">▼</span></button>'
      + '<div class="cxai-collapsible-content" id="cxai-settings-body">'
      + '<div class="cxai-field"><label>配置方案</label><div style="display:flex;gap:6px;align-items:stretch;">'
      + '<select id="cxai-profile-select" style="flex:1;padding:8px 10px;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;color:#1a1a1a;font-family:inherit;font-size:12px;outline:none;cursor:pointer;"></select>'
      + '<button type="button" id="cxai-btn-profile-new" title="新建配置" style="padding:0 10px;background:#fff;border:1px solid #ddd;border-radius:6px;cursor:pointer;color:#4f8ff7;font-weight:700;">+</button>'
      + '<button type="button" id="cxai-btn-profile-del" title="删除当前" style="padding:0 10px;background:#fff;border:1px solid #fca5a5;border-radius:6px;cursor:pointer;color:#dc2626;font-weight:700;">−</button>'
      + '</div></div>'
      + '<div class="cxai-field"><label>API Key</label><div class="cxai-input-with-eye"><input type="password" id="cxai-apikey" placeholder="sk-..." /><button type="button" class="cxai-eye-btn" id="cxai-eye-btn" title="显示/隐藏">👁</button></div></div>'
      + '<div class="cxai-field"><label>接口地址</label><input type="text" id="cxai-baseurl" placeholder="https://api.deepseek.com" /></div>'
      + '<div class="cxai-row cxai-row-3">'
      + '<div class="cxai-field"><label>模型</label><select id="cxai-model" style="width:100%;padding:8px 10px;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;color:#1a1a1a;font-family:inherit;font-size:12px;outline:none;box-sizing:border-box;cursor:pointer;"><option value="deepseek-chat">deepseek-chat</option><option value="deepseek-reasoner">deepseek-reasoner</option></select></div>'
      + '<div class="cxai-field"><label>轮数</label><input type="number" id="cxai-rounds" min="1" max="20" value="5" /></div>'
      + '<div class="cxai-field"><label>间隔(s)</label><input type="number" id="cxai-delay" min="0" max="30" value="3" /></div>'
      + '</div>'
      + '<div class="cxai-field"><label>对话风格</label><select id="cxai-prompt-style" style="width:100%;padding:8px 10px;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;color:#1a1a1a;font-family:inherit;font-size:12px;outline:none;box-sizing:border-box;cursor:pointer;transition:border-color .15s,box-shadow .15s;"><option value="balanced">🎯 专业均衡 (默认)</option><option value="curious">🧭 探究追问</option><option value="deep">🛠 落地实战</option><option value="concise">⚡ 精准高效</option></select></div>'
      + '<div class="cxai-field"><label>补充要求 (可选)</label><textarea id="cxai-custom-prompt" rows="3" placeholder="例如：表达更自然口语化；每轮先回应再追问；优先讨论落地风险。不会覆盖角色设定，只做额外微调。" style="width:100%;padding:8px 10px;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;color:#1a1a1a;font-family:inherit;font-size:12px;outline:none;box-sizing:border-box;resize:vertical;transition:border-color .15s,box-shadow .15s;"></textarea></div>'
      + '<div class="cxai-field"><label>💭 讨论字数</label><select id="cxai-discuss-length" style="width:100%;padding:8px 10px;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;color:#1a1a1a;font-family:inherit;font-size:12px;outline:none;box-sizing:border-box;cursor:pointer;"><option value="short">短 (120-200字)</option><option value="medium">中 (200-400字)</option><option value="long">长 (400-600字)</option></select></div>'
      + '<div class="cxai-btn-group" style="margin-top:8px;">'
      + '<button class="cxai-btn-sm cxai-btn-save" id="cxai-btn-save">保存</button>'
      + '<button class="cxai-btn-sm cxai-btn-test" id="cxai-btn-test">测试连接</button>'
      + '</div>'
      + '<div id="cxai-usage-info" style="margin-top:10px;padding:8px 10px;background:#f9fafb;border:1px dashed #e0e4ec;border-radius:6px;font-size:11px;color:#666;text-align:center;">📊 尚未调用</div>'
      + '</div></div>'

      // 任务区（根据页面类型不同）
      + taskSection

      // 控制区（根据页面类型不同）
      + controlSection

      // 日志终端（共用）
      + '<div class="cxai-terminal">'
      + '<div class="cxai-terminal-badge">tty1</div>'
      + '<div class=\"cxai-terminal-header\"><svg viewBox=\"0 0 128 128\" width=\"12\" height=\"12\" style=\"flex-shrink:0\"><rect x=\"16\" y=\"16\" width=\"96\" height=\"96\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"6\"/><path d=\"M44 48l22 16-22 16\" stroke=\"currentColor\" stroke-width=\"14\" fill=\"none\" stroke-linecap=\"square\"/><path d=\"M72 80h20\" stroke=\"currentColor\" stroke-width=\"14\" fill=\"none\"/></svg> /var/log/sys.log<div class=\"cxai-live-dot\" id=\"cxai-live-dot\"></div></div>'
      + '<div class="cxai-log" id="cxai-log"></div>'
      + '</div>'

      // 执行历史（折叠区）
      + '<div class="cxai-section">'
      + '<button class="cxai-collapsible-header" id="cxai-history-toggle">'
      + '<span>📋 执行历史_LOG</span><span class="cxai-chevron">▼</span></button>'
      + '<div class="cxai-collapsible-content" id="cxai-history-body">'
      + '<div id="cxai-history-list" style="max-height:200px;overflow-y:auto;"></div>'
      + '<div style="text-align:right;margin-top:6px;">'
      + '<button class="cxai-btn-sm" id="cxai-btn-clear-history" style="font-size:10px;padding:2px 8px;color:#999;border-color:#ddd;">清空</button>'
      + '</div>'
      + '</div></div>'

      + '</div>';
    document.body.appendChild(panelEl);

    // 获取 DOM 引用
    logEl = panelEl.querySelector('#cxai-log');
    statusEl = panelEl.querySelector('#cxai-status');
    liveDotEl = panelEl.querySelector('#cxai-live-dot');
    progressBarEl = panelEl.querySelector('#cxai-progress-bar');
    startBtn = panelEl.querySelector('#cxai-btn-start');
    stopBtn = panelEl.querySelector('#cxai-btn-stop');
    taskInfoEl = panelEl.querySelector('#cxai-task-info');
    scoreEl = panelEl.querySelector('#cxai-score');

    // Toggle 按钮
    toggleBtn.addEventListener('click', function () {
      var hidden = panelEl.classList.toggle('cxai-hidden');
      toggleBtn.style.display = hidden ? '' : 'none';
    });

    // 最小化
    panelEl.querySelector('#cxai-btn-min').addEventListener('click', function (e) {
      e.stopPropagation();
      panelEl.classList.add('cxai-hidden');
      toggleBtn.style.display = '';
    });

    // 设置按钮
    panelEl.querySelector('#cxai-btn-save').addEventListener('click', saveConfig);
    panelEl.querySelector('#cxai-btn-test').addEventListener('click', testConnection);

    // API Key 显示/隐藏
    var eyeBtn = panelEl.querySelector('#cxai-eye-btn');
    if (eyeBtn) {
      eyeBtn.addEventListener('click', function () {
        var input = panelEl.querySelector('#cxai-apikey');
        if (input.type === 'password') {
          input.type = 'text';
          eyeBtn.textContent = '🙈';
        } else {
          input.type = 'password';
          eyeBtn.textContent = '👁';
        }
      });
    }

    // Profile 切换/新建/删除
    var profileSel = panelEl.querySelector('#cxai-profile-select');
    if (profileSel) {
      renderProfileList();
      profileSel.addEventListener('change', function () { switchProfile(this.value); });
      panelEl.querySelector('#cxai-btn-profile-new').addEventListener('click', function () {
        var name = prompt('新配置名称:', '课程' + (Object.keys(profiles).length + 1));
        if (name) createProfile(name);
      });
      panelEl.querySelector('#cxai-btn-profile-del').addEventListener('click', function () {
        if (confirm('删除配置「' + activeProfile + '」？')) deleteProfile(activeProfile);
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
    } else if (isDiscussPage) {
      startBtn.addEventListener('click', function () { runDiscussTask(); });
      stopBtn.addEventListener('click', stopTask);
    } else {
      startBtn.addEventListener('click', function () { runTaskWithRetry(); });
      stopBtn.addEventListener('click', stopTask);
      continueBtn = panelEl.querySelector('#cxai-btn-continue');
      continueBtn.addEventListener('click', function () { continueAutoTask(); });
    }

    // 设置折叠
    var settingsToggle = panelEl.querySelector('#cxai-settings-toggle');
    var settingsBody = panelEl.querySelector('#cxai-settings-body');
    settingsToggle.addEventListener('click', function () {
      var isOpen = settingsBody.classList.toggle('cxai-open');
      settingsToggle.classList.toggle('cxai-open', isOpen);
    });

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
        chrome.storage.local.set(clearH);
        renderHistory([]);
      });
      // 初始加载历史
      chrome.storage.local.get([K.HISTORY], function (r) {
        renderHistory(r[K.HISTORY] || []);
      });
    }

    // 拖拽功能
    (function () {
      var header = panelEl.querySelector('.cxai-header');
      var isDragging = false, startX, startY, startLeft, startTop;

      header.addEventListener('mousedown', function (e) {
        if (e.target.closest('.cxai-header-dots')) return;
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
        var newLeft = Math.max(0, Math.min(window.innerWidth - panelEl.offsetWidth, startLeft + dx));
        var newTop = Math.max(0, Math.min(window.innerHeight - 50, startTop + dy));
        panelEl.style.left = newLeft + 'px';
        panelEl.style.top = newTop + 'px';
      });

      document.addEventListener('mouseup', function () {
        if (isDragging) {
          isDragging = false;
          panelEl.classList.remove('cxai-dragging');
        }
      });

      // 双击 header 复位到默认位置（右上角）
      header.addEventListener('dblclick', function (e) {
        if (e.target.closest('.cxai-header-dots')) return;
        panelEl.style.left = '';
        panelEl.style.top = '';
        panelEl.style.right = '12px';
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
  }

  // ==================== 入口 ====================

  function loadTaskInfo() {
    pageCall('getState').then(function (st) {
      renderTaskInfo(st);
    }).catch(function () {
      // 页面还没准备好，5秒后重试一次
      setTimeout(function () {
        pageCall('getState').then(function (st) {
          renderTaskInfo(st);
        }).catch(function () {});
      }, 5000);
    });
  }

  function loadDiscussInfo() {
    pageCall('getDiscussState').then(function (st) {
      if (!taskInfoEl) return;
      taskInfoEl.innerHTML =
        '<div class="cxai-task-item"><span class="cxai-task-label">话题 TOPIC</span><span class="cxai-task-value">' + escHtml(truncate(st.topicTitle || st.topicContent || '-', 60)) + '</span></div>'
        + '<div class="cxai-task-stats">'
        + '<div class="cxai-task-stat">类型: <span class="cxai-stat-val">💬 主题讨论</span></div>'
        + '<div class="cxai-task-stat">可回复: <span class="cxai-stat-val">' + (st.canReply ? '✓' : '✗') + '</span></div>'
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
        // 检查是否有待恢复的重试或批量任务
        setTimeout(function () {
          chrome.storage.local.get([K.RETRY_STATE], function (r) {
            if (r[K.RETRY_STATE] && r[K.RETRY_STATE].targetScore) {
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
