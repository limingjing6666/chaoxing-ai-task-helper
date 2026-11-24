// 运行在页面主世界 (MAIN world)
// 旧架构(/ai-evaluate/*)：直接访问 Vue2 实例 #app.__vue__
// 新架构(/mooc2-ans-vue/situationalDialogue)：Vue3 SPA，纯 DOM 操作 + 流式文本稳定轮询
// 注意：不能访问 content script 隔离 world 的 window.CXAI_CONST，超时常量本地定义
(function () {
  'use strict';

  var T = {
    CHAT_RESPONSE: 120000,  // 等待 AI 老师回复（流式，加缓冲）
    CHAT_POLL: 500,         // 回复轮询间隔
    CHAT_FIRST_LOAD: 10000, // 首次进入对话页 / 流式开始的最大等待
    STREAM_STABLE_CONFIRM: 2, // 文本连续不变次数判定流式完成（配合 loading 点与清除按钮双重保障）
    EVALUATE: 180000,       // 评估总超时
    EVAL_POLL: 2000,        // 评估轮询间隔
    UPLOAD: 120000,         // 文件上传超时
    UPLOAD_POLL: 2000,      // 上传轮询间隔
  };

  var _cachedLoadData = null;

  function getApp() {
    var el = document.getElementById('app');
    if (el && el.__vue__) return el.__vue__;
    var el2 = document.getElementById('mainApp');
    return el2 && el2.__vue__;
  }

  function isNewArch() {
    return /\/mooc2-ans-vue\/situationalDialogue/.test(location.pathname);
  }

  function isChatRoute() {
    return /\/situationalDialogue\/chat/.test(location.pathname);
  }

  function getCleanSearchParams() {
    return new URLSearchParams(String(location.search || '').replace(/^\?+/, ''));
  }

  // ==================== 新架构 DOM & 接口工具函数 ====================

  function fetchLoadData(force) {
    if (_cachedLoadData && !force) return Promise.resolve(_cachedLoadData);
    var p = getCleanSearchParams();
    var courseid = p.get('courseid') || p.get('courseId') || '';
    var clazzid = p.get('clazzid') || p.get('clazzId') || '';
    var cpi = p.get('cpi') || '';
    var uuid = p.get('publishRelationUuid') || '';
    if (!uuid) return Promise.resolve(null);
    var url = '/mooc2-ans/ai-evaluate/v2/answer/load-data?courseid=' + encodeURIComponent(courseid)
      + '&clazzid=' + encodeURIComponent(clazzid)
      + '&cpi=' + encodeURIComponent(cpi)
      + '&publishRelationUuid=' + encodeURIComponent(uuid);
    var recordUuid = p.get('recordUuid');
    if (recordUuid) url += '&recordUuid=' + encodeURIComponent(recordUuid);
    return fetch(url, { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json && json.status && json.data) {
          _cachedLoadData = json.data;
          return json.data;
        }
        return null;
      })
      .catch(function () { return null; });
  }

  function extractDomRoles() {
    var roles = { myRole: '', aiRole: '' };
    var cards = document.querySelectorAll('.task-detail__role');
    for (var i = 0; i < cards.length; i++) {
      var nameEl = cards[i].querySelector('.task-detail__role-name');
      var name = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!name) continue;
      if (cards[i].querySelector('.task-detail__role-tag--self')) roles.myRole = name;
      else if (cards[i].querySelector('.task-detail__role-tag--agent')) roles.aiRole = name;
    }
    return roles;
  }

  // 读取作答页/对话页任务信息（兼容入口页与对话页，注意：侧栏折叠时 .task-detail 会被 v-if 卸载）
  function getTopPageInfo() {
    var info = { passScore: '', practiced: '', remain: '', historyScore: '', title: '', requirement: '', scene: '', myRole: '', aiRole: '' };

    // 标题：入口页 h1.practice-title，对话页 h3.task-detail__title
    var titleEl = document.querySelector('h1.practice-title') || document.querySelector('h3.task-detail__title');
    if (titleEl) info.title = (titleEl.textContent || '').trim();

    // 要求：入口页 p.requirement-text / .requirement-text-wrap，对话页 p.task-detail__description / .task-detail__content-block
    var descEl = document.querySelector('p.requirement-text')
      || document.querySelector('.requirement-text-wrap')
      || document.querySelector('p.task-detail__description');
    if (descEl) {
      info.requirement = (descEl.textContent || '').trim();
    } else {
      var reqEl = document.querySelector('div.task-detail__content-block');
      if (reqEl) {
        var fullText = (reqEl.textContent || '').trim();
        var lines = fullText.split('\n').filter(function (l) { return l.trim(); });
        if (lines.length > 1 && lines[0].trim() === info.title) {
          lines = lines.slice(1);
        }
        if (lines.length > 0 && /^(展开|收起)$/.test(lines[lines.length - 1].trim())) {
          lines = lines.slice(0, -1);
        }
        info.requirement = lines.join('\n').trim();
      }
    }

    // 情景描述：对话页 .task-detail__scenario-text，入口页 .scenario-box__text
    var sceneEl = document.querySelector('.task-detail__scenario-text')
      || document.querySelector('.scenario-box__text')
      || document.querySelector('.task-detail__scenario .task-detail__text-wrap p');
    if (sceneEl) {
      info.scene = (sceneEl.textContent || '').trim();
    }

    // 角色信息
    var domRoles = extractDomRoles();
    info.myRole = domRoles.myRole;
    info.aiRole = domRoles.aiRole;

    // 元信息：入口页 .practice-meta 结构，对话页 .task-detail__meta-item
    var practiceMeta = document.querySelector('.practice-meta');
    if (practiceMeta) {
      var passLine = practiceMeta.querySelector('.meta-line--with-icon');
      if (passLine) info.passScore = (passLine.textContent || '').replace(/^达标标准[：:]/, '').trim();
      var scoreLine = practiceMeta.querySelector('.meta-line--score');
      if (scoreLine) {
        var scoreText = scoreLine.textContent || '';
        var pracMatch = scoreText.match(/已练习\s*(\d+)/);
        if (pracMatch) info.practiced = pracMatch[1];
        var remainMatch = scoreText.match(/剩余[^0-9]*(\d+)/);
        if (remainMatch) info.remain = remainMatch[1];
      }
      var rightMeta = practiceMeta.querySelector('.practice-meta__right');
      if (rightMeta) {
        var rightText = rightMeta.textContent || '';
        var histMatch = rightText.match(/(\d+)\s*分/);
        if (histMatch) info.historyScore = histMatch[1];
      }
    } else {
      var metaItems = document.querySelectorAll('.task-detail__meta-item');
      for (var i = 0; i < metaItems.length; i++) {
        var labelEl = metaItems[i].querySelector('.task-detail__meta-label');
        var valueEl = metaItems[i].querySelector('.task-detail__meta-value');
        if (!labelEl || !valueEl) continue;
        var label = (labelEl.textContent || '').trim();
        var value = (valueEl.textContent || '').trim();
        if (/达标/.test(label)) {
          info.passScore = value;
        } else if (/可作答次数|剩余|练习次数/.test(label)) {
          var rm = value.match(/\d+/);
          if (rm) info.remain = rm[0];
        } else if (/历史|得分|成绩|最高分/.test(label)) {
          var hm = value.match(/\d+/);
          if (hm) info.historyScore = hm[0];
        }
      }
    }

    return info;
  }

  // 定位对话区容器（.message-row 的父级，或 .chat-footer 之前的主体区）
  function getChatContainer() {
    // 优先：包含 .message-row 的最近祖先
    var row = document.querySelector('.message-row');
    if (row) {
      var p = row.parentElement;
      while (p && p !== document.body) {
        if (p.querySelectorAll('.message-row').length > 0) return p;
        p = p.parentElement;
      }
      return row.parentElement || null;
    }
    // 兜底候选
    var candidates = ['.chat-content', '.message-list', '.dialogue-content', '.chat-messages', '.chat-body'];
    var best = null, bestLen = 0;
    for (var i = 0; i < candidates.length; i++) {
      var els = document.querySelectorAll(candidates[i]);
      for (var j = 0; j < els.length; j++) {
        var len = (els[j].innerText || '').length;
        if (len > bestLen) { bestLen = len; best = els[j]; }
      }
      if (best) break;
    }
    return best;
  }

  function getChatPageText() {
    var c = getChatContainer();
    return c ? (c.innerText || '') : '';
  }

  // 解析对话消息列表（基于实测 .message-row + .message-bubble__markdown）
  function parseMessagesFromDom() {
    var msgs = [];
    var rows = document.querySelectorAll('.message-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cls = (row.className && typeof row.className === 'string') ? row.className.toLowerCase() : '';
      var role = '';
      if (/message-row--ai|message-row--assistant|message-row--teacher/.test(cls)) role = 'assistant';
      else if (/message-row--user|message-row--student|message-row--me/.test(cls)) role = 'user';
      if (!role) continue;
      var bubble = row.querySelector('.message-bubble__markdown') || row.querySelector('.message-bubble');
      var content = bubble ? (bubble.innerText || '').trim() : (row.innerText || '').trim();
      if (!content) continue;
      // 跳过完全重复（父子节点）
      var last = msgs[msgs.length - 1];
      if (last && last.role === role && last.content === content) continue;
      msgs.push({ role: role, content: content });
    }
    // 兜底：若 .message-row 未匹配，尝试旧选择器
    if (msgs.length === 0) {
      var c = getChatContainer();
      if (!c) return msgs;
      var nodes = c.querySelectorAll('[class*="message-item"], [class*="msg-item"], [class*="message"]');
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        var txt = (n.innerText || '').trim();
        if (!txt || txt.length > 2000) continue;
        var ncls = (n.className && typeof n.className === 'string') ? n.className.toLowerCase() : '';
        var nrole = '';
        if (/assistant|teacher|ai|robot|other|left/.test(ncls)) nrole = 'assistant';
        else if (/user|student|me|right|self|mine/.test(ncls)) nrole = 'user';
        if (!nrole) continue;
        var dup = false;
        for (var m = msgs.length - 1; m >= 0 && m >= msgs.length - 4; m--) {
          if (msgs[m].content === txt) { dup = true; break; }
        }
        if (dup) continue;
        msgs.push({ role: nrole, content: txt });
      }
    }
    return msgs;
  }

  function getLastAssistantText() {
    var msgs = parseMessagesFromDom();
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') return msgs[i].content;
    }
    return '';
  }

  // 查找"清除上下文"按钮（每次重新查找，避免 Vue 重渲染导致引用失效）
  function findClearContextButton() {
    // 1. 新版精确选择器：.input-toolbar__text-button 且包含"清除上下文"
    var textBtns = document.querySelectorAll('button.input-toolbar__text-button, .input-toolbar__actions button');
    for (var ti = 0; ti < textBtns.length; ti++) {
      var tt = (textBtns[ti].textContent || '').replace(/\s+/g, ' ').trim();
      if (tt.indexOf('清除上下文') !== -1 || tt === '清除') return textBtns[ti];
    }
    // 2. 兼容旧版 class 选择器
    var btn = document.querySelector('button.clear-button')
      || document.querySelector('.clear-button')
      || document.querySelector('button[class*="clear"]')
      || document.querySelector('[class*="clear-context"]')
      || document.querySelector('[class*="reset-button"]');
    if (btn) return btn;
    // 3. 全局 button 文本查找
    return findButtonByText(['清除上下文', '清除']);
  }

  // 检测按钮是否可点击（disabled 属性或 disabled 类名）
  function isBtnEnabled(btn) {
    if (!btn) return false;
    return !(btn.disabled === true || btn.hasAttribute('disabled') || /disabled|is-disabled/.test(btn.className || ''));
  }

  // 流式回复完成监听
  // 综合判据：
  //   1. .message-bubble__loading 消失（AI 不再处于占位/加载中）
  //   2. 新 AI 回复出现：AI 消息行数 > 发送前，或最后一条 AI 文本与发送前(prevLastAssistant)不同且非空
  //   3. 文本连续稳定 N 次（或清除上下文按钮已恢复可用且文本稳定）
  function waitForStreamStable(timeout, pollMs, prevLastAssistant, prevAiCount) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      var newTextAppeared = false;
      var lastText = '';
      var stableCount = 0;
      var need = T.STREAM_STABLE_CONFIRM;
      function tick() {
        var loadingDots = document.querySelector('.message-bubble__loading');
        var aiRows = document.querySelectorAll('.message-row--ai');
        var curText = getLastAssistantText();

        if (!loadingDots && curText && (aiRows.length > prevAiCount || curText !== prevLastAssistant)) {
          if (!newTextAppeared) {
            newTextAppeared = true;
            lastText = curText;
            stableCount = 0;
          }
        }

        if (newTextAppeared && !loadingDots) {
          if (curText !== lastText) {
            lastText = curText;
            stableCount = 0;
          } else {
            stableCount++;
            var clearBtn = findClearContextButton();
            var clearReady = clearBtn ? isBtnEnabled(clearBtn) : false;
            if (stableCount >= need || (clearReady && stableCount >= 1)) {
              return resolve(true);
            }
          }
        }

        waited += pollMs;
        if (waited >= timeout) return reject(new Error('等待AI老师回复超时(' + Math.round(timeout / 1000) + 's)'));
        setTimeout(tick, pollMs);
      }
      setTimeout(tick, pollMs);
    });
  }

  // 按文本匹配按钮（标准化空白，兼容内部带 icon/span 的按钮）
  function findButtonByText(textList) {
    var btns = document.querySelectorAll('button, .btn, a[role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || btns[i].innerText || '').replace(/\s+/g, ' ').trim();
      if (textList.indexOf(t) !== -1) return btns[i];
    }
    return null;
  }

  function findRetryButton() {
    return document.querySelector('button.retry-button')
      || document.querySelector('.retry-button')
      || findButtonByText(['重新练习']);
  }

  function extractEvaluationFromDom() {
    var retryBtn = findRetryButton();
    var evalBody = document.querySelector('.evaluate-result__body--done') || document.querySelector('.evaluate-result__body');
    var evalDone = !!(retryBtn || document.querySelector('.evaluate-result__body--done'));

    var score = null;
    // 1. 新版评估面板大字分值
    var scoreValEl = document.querySelector('.evaluate-result__score-value');
    if (scoreValEl) {
      var sv = (scoreValEl.textContent || '').trim();
      if (/^\d+$/.test(sv)) score = parseInt(sv, 10);
    }
    // 2. 顶部工具栏"作答记录 | 本次成绩 NN 分"
    if (score === null) {
      var toolbarStrong = document.querySelector('.message-toolbar__button--score .message-toolbar__score strong');
      if (toolbarStrong) {
        var ts = (toolbarStrong.textContent || '').trim();
        if (/^\d+$/.test(ts)) score = parseInt(ts, 10);
      }
    }
    if (score === null) {
      var scoreBtn = document.querySelector('.message-toolbar__button--score');
      if (scoreBtn) {
        var btnMatch = (scoreBtn.textContent || '').replace(/\s+/g, ' ').match(/本次成绩\s*(\d+)\s*分/);
        if (btnMatch) score = parseInt(btnMatch[1], 10);
      }
    }
    // 3. 评估区正文正则兜底（不读整个 document.body，避免被插件面板干扰）
    if (score === null && evalBody) {
      var bodyMatch = (evalBody.textContent || '').replace(/\s+/g, ' ').match(/本次成绩\s*(\d+)\s*分/);
      if (bodyMatch) score = parseInt(bodyMatch[1], 10);
    }

    var dimensions = [];
    var advantage = '';
    var shortcoming = '';
    var suggestions = [];
    var rawText = '';

    if (evalBody) {
      rawText = (evalBody.innerText || evalBody.textContent || '').trim();
      var summaryItems = evalBody.querySelectorAll('.evaluate-result__summary-item');
      for (var si = 0; si < summaryItems.length; si++) {
        var stEl = summaryItems[si].querySelector('.evaluate-result__summary-title');
        var stTxt = stEl ? (stEl.textContent || '').trim() : '';
        var dm = stTxt.match(/^(.+?)\s*[：:]\s*(\d+)\s*分/);
        if (dm) {
          dimensions.push({ name: dm[1].trim(), score: parseInt(dm[2], 10) });
        }
      }

      var blocks = evalBody.querySelectorAll('.evaluate-result__analysis-block');
      for (var bi = 0; bi < blocks.length; bi++) {
        var titleNode = blocks[bi].querySelector('.evaluate-result__analysis-title');
        var paraNode = blocks[bi].querySelector('.evaluate-result__paragraph');
        var bTitle = titleNode ? (titleNode.textContent || '').trim() : '';
        var bText = paraNode ? (paraNode.textContent || '').trim() : '';
        if (!bText) continue;
        if (/优点/.test(bTitle)) advantage = bText;
        else if (/不足|缺点/.test(bTitle)) shortcoming = bText;
      }

      var sugNodes = evalBody.querySelectorAll('.evaluate-result__suggestions .evaluate-result__paragraph');
      for (var gi = 0; gi < sugNodes.length; gi++) {
        var sTxt = (sugNodes[gi].textContent || '').trim();
        if (sTxt) suggestions.push(sTxt);
      }
    }

    return {
      evalDone: evalDone,
      score: score,
      dimensions: dimensions,
      advantage: advantage,
      shortcoming: shortcoming,
      suggestions: suggestions,
      rawText: rawText,
    };
  }

  // Vue3 受控 textarea 设值：多策略保证响应式触发
  // 策略1（优先）：execCommand('insertText') 触发可信 InputEvent（isTrusted=true）
  // 策略2（兜底）：原生 setter + InputEvent（isTrusted=false，部分 Vue3 v-model 可能忽略）
  // 策略3（最终兜底）：直接设 value + input 事件，配合 Vue3 patch 时机重试
  function setNativeTextarea(el, value) {
    el.focus();
    // 清空：用 setRangeText 替代 select()+delete()，更可靠
    // select() 在 Vue3 受控组件上可能因重渲染失效，setRangeText 直接操作底层选区
    try {
      el.setSelectionRange(0, el.value.length);
      document.execCommand('delete');
    } catch (e) {}
    // 插入：execCommand 优先（可信事件）
    if (value) {
      try {
        document.execCommand('insertText', false, value);
      } catch (e) {}
    }
    // 兜底1：若 execCommand 未生效（el.value !== value），用原生 setter + InputEvent
    if (el.value !== value) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // 强制触发 Vue3 响应式更新：多种事件组合，确保 v-model 监听到变化
  function triggerVueReactive(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    el.dispatchEvent(new KeyboardEvent('input', { bubbles: true }));
  }

  function htmlToPlainText(html) {
    if (!html) return '';
    try {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      return (doc && doc.body ? doc.body.textContent : '') || '';
    } catch (e) {
      return String(html).replace(/<[^>]*>/g, '');
    }
  }

  // ==================== 消息处理 ====================

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'cxai-content') return;
    var action = e.data.action;
    var id = e.data.id;

    function reply(data) {
      window.postMessage({ source: 'cxai-page', id: id, data: data }, '*');
    }
    function fail(msg) {
      window.postMessage({ source: 'cxai-page', id: id, error: msg }, '*');
    }

    var app = getApp();
    if (!app && !isNewArch() && action !== 'getState' && action !== 'getPageInfo') {
      return fail('找不到Vue应用实例(#app.__vue__)，请确认页面已完全加载');
    }

    // ========== getState ==========
    if (action === 'getState') {
      // ----- 新架构：DOM + load-data 融合（解决侧栏折叠时 .task-detail 被卸载的问题） -----
      if (isNewArch()) {
        try {
          var topInfo = getTopPageInfo();
          var msgs = parseMessagesFromDom();
          var evalInfo = extractEvaluationFromDom();
          var needApi = !topInfo.title || !topInfo.requirement || !topInfo.scene || !topInfo.remain;
          var loadPromise = needApi ? fetchLoadData(false) : Promise.resolve(_cachedLoadData);

          loadPromise.then(function (ld) {
            ld = ld || {};
            var title = topInfo.title || ld.title || (document.title || '').replace(/\s*[-–—|].*/g, '').trim() || 'AI实践';
            var requirementText = topInfo.requirement || ld.requirement || '';
            if (topInfo.passScore) requirementText += (requirementText ? '\n' : '') + '达标标准: ' + topInfo.passScore;
            var sceneText = topInfo.scene || ld.scene || '';
            var remainVal = topInfo.remain !== '' ? parseInt(topInfo.remain, 10) : ld.remainAnswerCount;
            var scoreVal = topInfo.historyScore !== '' ? parseFloat(topInfo.historyScore) : ld.answerScore;
            var finalMsgs = (msgs && msgs.length > 0)
              ? msgs
              : (Array.isArray(ld.messages) ? ld.messages.map(function (m) { return { role: m.role, content: m.content || '' }; }) : []);

            reply({
              title: title,
              requirement: requirementText,
              scene: sceneText,
              myRole: topInfo.myRole || '',
              aiRole: topInfo.aiRole || '',
              messages: finalMsgs,
              recordUuid: ld.recordUuid || '',
              answerUuid: ld.answerUuid || '',
              recordStatus: evalInfo.evalDone ? 2 : 0,
              evaluateStatus: evalInfo.evalDone ? 2 : 0,
              isLoadingChat: false,
              remainAnswerCount: remainVal,
              answerScore: scoreVal,
              type: ld.type,
              fileObjectId: '',
              fileType: '',
              fileName: '',
              fileParseStatus: '',
              canStartEvaluate: isChatRoute() && finalMsgs.length > 0 && !evalInfo.evalDone,
              chatStarted: isChatRoute()
            });
          }).catch(function (err) {
            fail('getState(新架构) 错误: ' + err.message);
          });
        } catch (err) {
          fail('getState(新架构) 错误: ' + err.message);
        }
        return;
      }

      // ----- 旧架构 / v2/answer：Vue 实例 + load-data 兜底 -----
      if (!app) {
        fetchLoadData(false).then(function (ld) {
          if (!ld) return fail('找不到Vue应用实例(#app.__vue__)，请确认页面已完全加载');
          var domTit = document.querySelector('h3.main-cenTop-info-tit');
          var domReq = document.querySelector('.main-cenTop-info-word > p');
          reply({
            title: ld.title || (domTit ? domTit.textContent.trim() : '') || '',
            requirement: ld.requirement || (domReq ? domReq.textContent.trim() : '') || '',
            scene: ld.scene || '',
            messages: Array.isArray(ld.messages) ? ld.messages : [],
            recordUuid: ld.recordUuid || '',
            answerUuid: ld.answerUuid || '',
            recordStatus: ld.recordStatus || 0,
            evaluateStatus: ld.evaluateStatus || 0,
            isLoadingChat: false,
            remainAnswerCount: ld.remainAnswerCount,
            answerScore: ld.answerScore,
            type: ld.type,
            rules: ld.rules || [],
            fileObjectId: '',
            fileType: '',
            fileName: '',
            fileParseStatus: '',
            canStartEvaluate: false,
          });
        }).catch(function () {
          fail('找不到Vue应用实例(#app.__vue__)，请确认页面已完全加载');
        });
        return;
      }

      var c = app.current || {};
      try {
        var stateData = {
          title: c.title || '',
          requirement: c.requirement || '',
          scene: c.scene || '',
          messages: JSON.parse(JSON.stringify(c.messages || [])),
          recordUuid: c.recordUuid || '',
          answerUuid: c.answerUuid || '',
          recordStatus: c.recordStatus || 0,
          evaluateStatus: c.evaluateStatus || 0,
          isLoadingChat: c.isLoadingChat || false,
          remainAnswerCount: c.remainAnswerCount,
          answerScore: c.answerScore,
          type: c.type,
          rules: c.rules || app.rules || [],
          fileObjectId: c.fileObjectId || '',
          fileType: c.fileType || '',
          fileName: c.fileName || '',
          fileParseStatus: c.fileParseStatus || '',
          canStartEvaluate: app.canStartEvaluate,
        };

        // Add code-specific fields for type 4
        if (c.type === 4) {
          var contentText = htmlToPlainText(c.content || c.requirementContent || '').trim();
          stateData.requirement = contentText || c.requirement || '';
          stateData.codeUuid = c.codeUuid || '';
          stateData.langList = app.langList || {};
          stateData.publishSetting = c.publishSetting || {};
          stateData.answerResult = c.answerResult || null;
          stateData.evaluateResult = c.evaluateResult || null;
          stateData.recordScore = c.recordScore;
        }

        if (c.type === 1 && (!stateData.rules || stateData.rules.length === 0)) {
          fetchLoadData(false).then(function (ld) {
            if (ld && Array.isArray(ld.rules)) stateData.rules = ld.rules;
            reply(stateData);
          }).catch(function () { reply(stateData); });
          return;
        }

        reply(stateData);
      } catch (err) {
        fail('getState 错误: ' + err.message);
      }
    }

    // ========== startChat (新架构专用) ==========
    else if (action === 'startChat') {
      if (!isNewArch()) return fail('startChat 仅支持新架构页面');
      try {
        if (isChatRoute()) return reply({ status: 'success', already: true });
        var startBtn = document.querySelector('button.start-button') || findButtonByText(['开始对话']);
        if (!startBtn) return fail('找不到开始对话按钮 button.start-button');
        startBtn.click();
        var waited = 0;
        function waitChatRoute() {
          waited += T.CHAT_POLL;
          if (isChatRoute()) return reply({ status: 'success' });
          if (waited >= T.CHAT_FIRST_LOAD) return fail('等待进入对话页超时');
          setTimeout(waitChatRoute, T.CHAT_POLL);
        }
        setTimeout(waitChatRoute, T.CHAT_POLL);
      } catch (err) {
        fail('startChat 错误: ' + err.message);
      }
    }

    // ========== sendMessage ==========
    else if (action === 'sendMessage') {
      // ----- 新架构：DOM fill + click + 流式等待 -----
      if (isNewArch()) {
        var textNew = e.data.text;
        if (!textNew) return fail('缺少 text 参数');
        try {
          var textarea = document.querySelector('textarea.input-textarea') || document.querySelector('textarea');
          if (!textarea) return fail('找不到输入框 textarea.input-textarea');
          // 发送按钮可能是 button 或其他元素，用多选择器
          var sendBtn = document.querySelector('button.send-button')
            || document.querySelector('.send-button')
            || findButtonByText(['发送', '发送消息']);
          if (!sendBtn) return fail('找不到发送按钮 .send-button');

          // 记录发送前最后一条 assistant 文本与 AI 消息行数，作为流式回复开始的判据
          var prevLastAssistant = getLastAssistantText();
          var prevAiCount = document.querySelectorAll('.message-row--ai').length;

          // Vue3 受控组件：focus + 多策略设值 + 事件链触发响应式
          textarea.focus();
          setNativeTextarea(textarea, textNew);
          triggerVueReactive(textarea);

          // 轮询等待发送按钮 enabled（Vue computed 在下一 tick 更新 disabled）
          // 关键：区分两种 disabled 场景
          //   A. 流式中：清除上下文按钮也 disabled → Vue 强制禁用，重试设值无效，必须等待流式完成
          //   B. 响应式未触发：清除上下文按钮 enabled → 设值问题，重试设值可解决
          var btnWaited = 0;
          var btnPoll = 150;
          var btnMax = 5000;
          var retryCount = 0;
          var maxRetries = 3;
          var streamingWaitCount = 0;
          var maxStreamingWait = 240; // 流式等待上限：240 * 150ms = 36s（超过则报错）
          function waitBtnEnabled() {
            // 每次重新查找按钮，避免 Vue 重渲染导致引用失效
            var btn = document.querySelector('button.send-button') || document.querySelector('.send-button') || findButtonByText(['发送', '发送消息']);
            if (!btn) {
              btnWaited += btnPoll;
              if (btnWaited >= btnMax + 2000) return fail('找不到发送按钮');
              return setTimeout(waitBtnEnabled, btnPoll);
            }
            // 检查 disabled 属性（button）或 pointer-events/类名（其他元素）
            var isDisabled = btn.disabled === true || /disabled|is-disabled/.test(btn.className || '');
            if (!isDisabled) {
              btn.click();
              waitForStreamStable(T.CHAT_RESPONSE, T.CHAT_POLL, prevLastAssistant, prevAiCount).then(function () {
                var msgsAfter = parseMessagesFromDom();
                var lastAssistant = getLastAssistantText();
                reply({ response: lastAssistant, messages: msgsAfter });
              }).catch(function (err) {
                fail(err.message);
              });
              return;
            }
            // 发送按钮 disabled：检测是否处于流式中（清除上下文按钮也 disabled）
            var clearBtn = findClearContextButton();
            var clearDisabled = clearBtn ? !isBtnEnabled(clearBtn) : false;
            if (clearDisabled) {
              // 场景A：流式中，不重试设值，继续等待流式完成
              streamingWaitCount++;
              if (streamingWaitCount >= maxStreamingWait) {
                return fail('AI老师回复超时，发送按钮持续 disabled（等待' + Math.round(streamingWaitCount * btnPoll / 1000) + 's）');
              }
              return setTimeout(waitBtnEnabled, btnPoll);
            }
            // 场景B：响应式未触发，重试设值
            btnWaited += btnPoll;
            if (btnWaited >= btnMax && retryCount < maxRetries) {
              retryCount++;
              textarea = document.querySelector('textarea.input-textarea') || document.querySelector('textarea');
              if (textarea) {
                textarea.focus();
                // 重试策略：原生 setter + InputEvent（绕过 execCommand，直接触发 v-model）
                var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(textarea, '');
                textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
                setter.call(textarea, textNew);
                textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: textNew, inputType: 'insertText' }));
                triggerVueReactive(textarea);
              }
            }
            if (btnWaited >= btnMax + maxRetries * 2000) {
              return fail('发送按钮持续不可用（输入未触发响应式更新，重试' + retryCount + '次均失败）');
            }
            setTimeout(waitBtnEnabled, btnPoll);
          }
          setTimeout(waitBtnEnabled, btnPoll);
        } catch (err) {
          fail('sendMessage(新架构) 错误: ' + err.message);
        }
        return;
      }

      // ----- 旧架构：Vue 实例 -----
      if (app.current.isLoadingChat) return fail('AI老师正在回复中');
      if (app.current.recordStatus === 1 || app.current.recordStatus === 2) return fail('作答已提交');

      app.textareaText = e.data.text;
      app.sendMessage();

      var waited = 0;
      var maxWait = T.CHAT_RESPONSE;
      var poll = T.CHAT_POLL;

      function waitSend() {
        if (waited < T.CHAT_FIRST_LOAD && !app.current.isLoadingChat) {
          waited += poll;
          return setTimeout(waitSend, poll);
        }
        waitResponse();
      }

      function waitResponse() {
        if (waited >= maxWait) return fail('等待AI老师回复超时(' + Math.round(maxWait / 1000) + 's)');
        if (app.current.isLoadingChat) {
          waited += poll;
          return setTimeout(waitResponse, poll);
        }
        var msgs = app.current.messages || [];
        var last = msgs[msgs.length - 1];
        reply({
          response: (last && last.role === 'assistant') ? last.content : '',
          messages: JSON.parse(JSON.stringify(msgs)),
        });
      }

      waitSend();
    }

    // ========== submitEvaluate ==========
    else if (action === 'submitEvaluate') {
      // ----- 新架构：点结束按钮 + 轮询"重新练习"按钮及 .evaluate-result + 分数/反馈解析 -----
      if (isNewArch()) {
        try {
          var finishBtn = document.querySelector('button.finish-button') || findButtonByText(['结束练习并评估', '结束练习', '结束并评估']);
          if (!finishBtn) return fail('找不到结束练习按钮 button.finish-button');
          finishBtn.click();

          var evalWaited = 0;
          var zeroScoreConfirms = 0; // 分数为0时的额外确认轮次（防占位0分）
          var ZERO_SCORE_MAX_CONFIRMS = 4; // 最多再确认 4 轮(8s)，期间若出现非0分数立即采用
          function checkEvalNew() {
            evalWaited += T.EVAL_POLL;
            if (evalWaited > T.EVALUATE) return fail('评估超时(' + Math.round(T.EVALUATE / 1000) + 's)');

            var evalInfo = extractEvaluationFromDom();
            var evalDone = evalInfo.evalDone;
            var score = evalInfo.score;
            var hasPendingEvalBody = !!document.querySelector('.evaluate-result__body') && !document.querySelector('.evaluate-result__body--done');

            // 若评估面板已挂载但仍在流式渲染总结/建议，再多等 1~2 轮确保反馈完整
            if (evalDone && hasPendingEvalBody && evalWaited < 12000) {
              setTimeout(checkEvalNew, T.EVAL_POLL);
              return;
            }

            // 评估完成但分数为 0 时：可能是占位 0 分（页面先渲染按钮、分数稍后异步更新）
            if (evalDone && score === 0) {
              zeroScoreConfirms++;
              if (zeroScoreConfirms < ZERO_SCORE_MAX_CONFIRMS) {
                setTimeout(checkEvalNew, T.EVAL_POLL);
                return;
              }
            }

            if (evalDone && score !== null) {
              _cachedLoadData = null; // 评估完成后使 load-data 缓存失效（剩余次数已变化）
              return reply({
                status: 'success',
                score: score,
                feedback: {
                  score: score,
                  dimensions: evalInfo.dimensions,
                  advantage: evalInfo.advantage,
                  shortcoming: evalInfo.shortcoming,
                  suggestions: evalInfo.suggestions,
                  rawText: evalInfo.rawText,
                }
              });
            }
            setTimeout(checkEvalNew, T.EVAL_POLL);
          }
          setTimeout(checkEvalNew, T.EVAL_POLL);
        } catch (err) {
          fail('submitEvaluate(新架构) 错误: ' + err.message);
        }
        return;
      }

      // ----- 旧架构：Vue 实例 -----
      if (!app.canStartEvaluate) return fail('当前不满足提交条件(无对话/未上传文件/已提交)');

      app.startEvaluate();

      var evalWaited = 0;
      var evalMax = T.EVALUATE;
      var evalPoll = T.EVAL_POLL;

      function checkEval() {
        evalWaited += evalPoll;
        if (evalWaited > evalMax) return fail('评估超时(' + Math.round(evalMax / 1000) + 's)');
        var s = app.current.evaluateStatus;
        console.log('[ChaoxingAI] evaluateStatus:', s, '(' + typeof s + ') waited:', evalWaited + 'ms');
        if (s == 2) {
          var result = app.current.evaluateResult;
          var ev = app.currentEvaluate || {};
          var score = '未知';
          try {
            score = (result.score && result.score.score) || result.totalScore || '未知';
          } catch (ex) {}

          // 收集AI评估反馈
          var feedback = {};
          try {
            feedback.score = score;
            feedback.scoreDesc = ev.typedScoreDesc || '';
            feedback.advantage = ev.typedAdvantage || '';
            feedback.shortcoming = ev.typedShortcoming || '';
            feedback.suggestions = ev.typedSuggestions || [];
            feedback.points = (ev.typedPoints || []).map(function (p) {
              return { name: p.name || '', score: p.score || '', desc: p.desc || '' };
            });
          } catch (ex) {}

          return reply({ status: 'success', score: score, feedback: feedback });
        }
        if (s == -1) return fail('评估失败');
        setTimeout(checkEval, evalPoll);
      }

      setTimeout(checkEval, evalPoll);
    }

    // ========== fetchTaskList ==========
    else if (action === 'fetchTaskList') {
      try {
        var courseId = document.getElementById('courseId');
        var cpi = document.getElementById('cpi');
        if (!courseId || !courseId.value) return fail('无法获取courseId');
        var listUrl = '/mooc2-ans/ai-evaluate/answer/list?courseid=' + courseId.value
          + '&cpi=' + (cpi ? cpi.value : '') + '&type=&q=&pageNo=1&pageSize=100';
        // 用 fetch (same-origin)
        fetch(listUrl).then(function (resp) { return resp.text(); }).then(function (html) {
          // 尝试JSON解析
          try {
            var json = JSON.parse(html);
            if (json && json.data) return reply(json.data);
          } catch (ex) {}
          // HTML回复 -> 提取任务链接
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          var items = doc.querySelectorAll('.mission-item, .ai-item, [data-uuid], a[href*="publishRelationUuid"]');
          var tasks = [];
          items.forEach(function (el) {
            var title = el.querySelector('.title, .name, h3, h4');
            var link = el.querySelector('a[href*="publishRelationUuid"]') || el;
            var href = link.getAttribute ? link.getAttribute('href') : '';
            var uuid = '';
            if (href) {
              var m = href.match(/publishRelationUuid=([^&]+)/);
              if (m) uuid = m[1];
            }
            if (!uuid) {
              uuid = el.getAttribute('data-uuid') || '';
            }
            var scoreEl = el.querySelector('.score, .grade');
            tasks.push({
              title: title ? title.textContent.trim() : '未知任务',
              publishRelationUuid: uuid,
              answerScore: scoreEl ? parseFloat(scoreEl.textContent) || 0 : 0,
            });
          });
          // 如果啥也没解析到，把原始HTML片段返回供调试
          if (tasks.length === 0) {
            // 尝试从app.relations获取
            var appInst = getApp();
            if (appInst && appInst.relations && appInst.relations.length > 0) {
              appInst.relations.forEach(function (r) {
                tasks.push({
                  title: r.title || r.name || '任务',
                  publishRelationUuid: r.publishRelationUuid || r.uuid || '',
                  answerScore: r.answerScore || 0,
                });
              });
            }
          }
          reply(tasks);
        }).catch(function (err) {
          fail('fetchTaskList 请求失败: ' + err.message);
        });
      } catch (err) {
        fail('fetchTaskList 错误: ' + err.message);
      }
    }

    // ========== getPageInfo ==========
    else if (action === 'getPageInfo') {
      try {
        var courseIdEl = document.getElementById('courseId');
        var clazzIdEl = document.getElementById('clazzId');
        var cpiEl = document.getElementById('cpi');
        var pubUuidEl = document.getElementById('publishRelationUuid');
        var p = getCleanSearchParams();
        reply({
          courseId: (courseIdEl && courseIdEl.value) || p.get('courseid') || p.get('courseId') || '',
          clazzId: (clazzIdEl && clazzIdEl.value) || p.get('clazzid') || p.get('clazzId') || '',
          cpi: (cpiEl && cpiEl.value) || p.get('cpi') || '',
          publishRelationUuid: (pubUuidEl && pubUuidEl.value) || p.get('publishRelationUuid') || ''
        });
      } catch (err) {
        fail('getPageInfo 错误: ' + err.message);
      }
    }

    // ========== uploadFile (文件上传型任务 - 旧架构) ==========
    else if (action === 'uploadFile') {
      var fileName = e.data.fileName || 'document.docx';
      var fileDataB64 = e.data.fileData; // base64 encoded
      if (!fileDataB64) return fail('缺少文件数据');

      try {
        // base64 -> Blob -> File
        var byteChars = atob(fileDataB64);
        var byteArr = new Uint8Array(byteChars.length);
        for (var bi = 0; bi < byteChars.length; bi++) {
          byteArr[bi] = byteChars.charCodeAt(bi);
        }
        var mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (fileName.endsWith('.doc')) mimeType = 'application/msword';
        if (fileName.endsWith('.pdf')) mimeType = 'application/pdf';
        var blob = new Blob([byteArr], { type: mimeType });
        var file = new File([blob], fileName, { type: mimeType });

        console.log('[ChaoxingAI] uploadFile: 上传文件', fileName, '大小:', file.size, '类型:', file.type);
        // 注：跳过 app.validateFile（isUseAiComment 分支有 bug：数组 !== 字符串 恒为 true）
        // 直接调用 uploadFile，服务端会做最终校验
        app.uploadFile(file);

        // 等待上传完成 + 文件解析
        var uploadWaited = 0;
        var uploadMax = T.UPLOAD;
        var uploadPoll = T.UPLOAD_POLL;

        function checkUpload() {
          uploadWaited += uploadPoll;
          if (uploadWaited > uploadMax) return fail('文件上传/解析超时(' + Math.round(uploadMax / 1000) + 's)');

          // 检查是否还在上传
          if (app.isUploading) {
            return setTimeout(checkUpload, uploadPoll);
          }

          // 检查文件是否已设置
          var c = app.current;
          if (!c.fileObjectId) {
            if (uploadWaited < 10000) return setTimeout(checkUpload, uploadPoll);
            return fail('文件上传后未获取到fileObjectId');
          }

          // 对于需要解析的文件类型（doc/docx/pdf），等待解析完成
          if (c.fileParseStatus === '0') {
            console.log('[ChaoxingAI] uploadFile: 文件解析中...');
            return setTimeout(checkUpload, uploadPoll);
          }

          // 解析完成或不需要解析
          console.log('[ChaoxingAI] uploadFile: 文件就绪, fileObjectId:', c.fileObjectId, 'parseStatus:', c.fileParseStatus);
          reply({
            status: 'success',
            fileObjectId: c.fileObjectId,
            fileType: c.fileType,
            fileName: c.fileName,
            fileParseStatus: c.fileParseStatus,
            canStartEvaluate: app.canStartEvaluate
          });
        }

        setTimeout(checkUpload, uploadPoll);
      } catch (err) {
        fail('uploadFile 错误: ' + err.message);
      }
    }

    // ========== retryTask (重新练习) ==========
    else if (action === 'retryTask') {
      // 新架构：优先点击页面上的"重新练习"按钮原地重置（不刷新页面），找不到按钮才回退导航
      if (isNewArch()) {
        _cachedLoadData = null;
        var rBtn = findRetryButton();
        if (rBtn) {
          console.log('[ChaoxingAI] retryTask(新架构): 点击"重新练习"原地重置');
          rBtn.click();
          var rw = 0;
          function waitResetDone() {
            rw += 300;
            var ta = document.querySelector('textarea.input-textarea');
            var stillEval = !!document.querySelector('.evaluate-result__body--done');
            if (ta && !stillEval) {
              return reply({ success: true, method: 'inplace' });
            }
            if (rw >= 10000) {
              return fail('点击"重新练习"后重置超时');
            }
            setTimeout(waitResetDone, 300);
          }
          setTimeout(waitResetDone, 400);
          return;
        }
        console.log('[ChaoxingAI] retryTask(新架构): 未找到原地重练按钮，回退导航到作答页');
        reply({ success: true, method: 'navigate' });
        setTimeout(function () {
          var path = location.pathname.replace(/\/chat$/, '');
          location.href = location.origin + path + location.search;
        }, 100);
        return;
      }

      // 打印 Vue 实例所有方法，方便调试
      var appMethods = [];
      for (var k in app) {
        if (typeof app[k] === 'function' && k.charAt(0) !== '_' && k.charAt(0) !== '$') {
          appMethods.push(k);
        }
      }
      console.log('[ChaoxingAI] retryTask: Vue方法列表:', appMethods.join(', '));
      console.log('[ChaoxingAI] retryTask: current keys:', Object.keys(app.current || {}));

      // 方法1: 尝试 Vue 实例上的方法
      var retryMethods = ['againAnswer', 'retryAnswer', 'againPractice', 'restartAnswer', 'reAnswer', 'reloadAnswer', 'newAnswer', 'handleAgain', 'handleRetry', 'handleRestart', 'onAgain', 'onRetry', 'doRetry', 'doAgain', 'goRetry', 'goPractice'];
      for (let mi = 0; mi < retryMethods.length; mi++) {
        const methodName = retryMethods[mi];
        if (typeof app[methodName] === 'function') {
          console.log('[ChaoxingAI] retryTask: 调用 app.' + methodName + '()');
          reply({ success: true, method: methodName });
          setTimeout(function () { app[methodName](); }, 100);
          return;
        }
      }

      // 方法2: 直接导航（最可靠 —— DIV按钮点击无法触发Vue路由）
      var c = app.current || {};
      var uuid = c.publishRelationUuid || app.publishRelationUuid || '';
      if (!uuid) {
        // 从 URL 或 data 中提取
        var match = window.location.href.match(/publishRelationUuid[=\/]([a-f0-9\-]+)/i);
        if (match) uuid = match[1];
      }
      if (!uuid) {
        // 从 answerRecords 或 data 属性中搜索
        try {
          var dataStr = JSON.stringify(app.$data || app.current || {});
          var m2 = dataStr.match(/"publishRelationUuid"\s*:\s*"([a-f0-9\-]+)"/i);
          if (m2) uuid = m2[1];
        } catch (ex) {}
      }
      if (uuid) {
        console.log('[ChaoxingAI] retryTask: 导航重试, uuid=' + uuid);
        reply({ success: true, method: 'navigate' });
        setTimeout(function () {
          var base = window.location.origin + window.location.pathname;
          var params = new URLSearchParams(window.location.search);
          params.delete('answerUuid');
          params.delete('recordUuid');
          params.set('publishRelationUuid', uuid);
          window.location.href = base + '?' + params.toString();
        }, 100);
        return;
      }

      // 方法3: 用当前页面 URL 重新加载（去掉 answer 相关参数）
      console.log('[ChaoxingAI] retryTask: 无法获取UUID，尝试刷新页面');
      reply({ success: true, method: 'reload' });
      setTimeout(function () { window.location.reload(); }, 100);
    }

    // ========== getThinkLadderState (AI思维阶梯任务 - 旧架构) ==========
    else if (action === 'getThinkLadderState') {
      try {
        var c = app.current || {};
        var messages = c.messageList || [];

        // 解析当前题目（从messageList最后一条AI消息）
        var currentQuestion = null;
        for (var i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 2 && messages[i].content) {
            try {
              var qData = JSON.parse(messages[i].content);
              if (qData.questionStem) {
                currentQuestion = {
                  stem: qData.questionStem,
                  options: JSON.parse(qData.questionOptions || '[]'),
                  type: qData.questionType || '',
                  dimension: qData.dimension || '',
                  knowledgePoint: qData.knowledgePoint || '',
                };
                break;
              }
            } catch (e) {}
          }
        }

        reply({
          title: c.title || '',
          type: c.type,
          thinkLadderType: c.thinkLadderType,
          requirement: c.requirement || '',
          recordUuid: c.recordUuid || '',
          recordStatus: c.recordStatus || 0,
          evaluateStatus: c.evaluateStatus || 0,
          remainAnswerCount: c.remainAnswerCount,
          answerScore: c.answerScore,
          currentQuestion: currentQuestion,
          messageCount: messages.length,
          answerRecords: c.answerRecords || [],
          allTopicIds: c.allTopicIds || '',
          tipNum: c.tipNum,
        });
      } catch (err) {
        fail('getThinkLadderState 错误: ' + err.message);
      }
    }

    // ========== sendThinkLadderAnswer (AI思维阶梯任务 - 用sendMessage) ==========
    else if (action === 'sendThinkLadderAnswer') {
      var answer = e.data.answer;
      if (!answer) return fail('缺少 answer 参数');

      try {
        var c = app.current;

        // 关键：主干生长模式下recordUuid可能为空，从answerRecords复用
        if (!c.recordUuid && c.answerRecords && c.answerRecords.length > 0) {
          c.recordUuid = c.answerRecords[c.answerRecords.length - 1].recordUuid;
          console.log('[ChaoxingAI] 复用recordUuid:', c.recordUuid);
        }

        if (typeof app.sendMessage === 'function') {
          app.sendMessage(answer);
        } else if (typeof app.send === 'function') {
          app.send(answer);
        } else {
          return fail('找不到发送方法');
        }

        // 等待AI回复
        var waited = 0;
        var maxWait = 60000;
        var poll = 500;

        function waitReply() {
          waited += poll;
          if (waited > maxWait) return fail('等待AI回复超时');

          if (c.isLoadingChat) {
            return setTimeout(waitReply, poll);
          }

          // AI回复完成，检查结果
          var newMessages = c.messageList || [];
          if (newMessages.length > (c._lastMsgCount || 0)) {
            c._lastMsgCount = newMessages.length;
            var lastMsg = newMessages[newMessages.length - 1];
            var isCorrect = lastMsg.content && lastMsg.content.indexOf('回答正确') !== -1;
            var isWrong = lastMsg.content && lastMsg.content.indexOf('回答错误') !== -1;

            reply({ status: 'success', isCorrect: isCorrect, isWrong: isWrong });
            return;
          }

          // 如果还在loading就继续等
          if (c.isLoadingChat) {
            return setTimeout(waitReply, poll);
          }

          // 不确定状态，再等一会
          if (waited < 5000) {
            return setTimeout(waitReply, poll);
          }

          reply({ status: 'success' });
        }

        c._lastMsgCount = (c.messageList || []).length;
        setTimeout(waitReply, 3000);
      } catch (err) {
        fail('sendThinkLadderAnswer 错误: ' + err.message);
      }
    }

    // ========== endThinkLadderTask (AI思维阶梯任务) ==========
    else if (action === 'endThinkLadderTask') {
      try {
        if (typeof app.endTask === 'function') {
          app.endTask();
          reply({ status: 'success' });
        } else if (typeof app.submit === 'function') {
          app.submit();
          reply({ status: 'success' });
        } else {
          fail('找不到结束任务方法');
        }
      } catch (err) {
        fail('endThinkLadderTask 错误: ' + err.message);
      }
    }

    // ========== setLanguage (代码编辑任务 - 点击UI选择器) ==========
    else if (action === 'setLanguage') {
      var codeNum = e.data.codeNum;
      if (codeNum === undefined || codeNum === null) return fail('缺少 codeNum 参数');

      try {
        var langList = app.langList || {};
        var langEntry = null;
        for (var key in langList) {
          if (langList[key].codeNum === codeNum) {
            langEntry = langList[key];
            break;
          }
        }
        if (!langEntry) return fail('未找到语言 codeNum=' + codeNum);

        // Click the language selector dropdown to open it
        var langSelector = document.querySelector('.selectBoxLang.fl');
        if (langSelector) {
          langSelector.click();

          // Find and click the matching language option
          setTimeout(function () {
            var langLinks = document.querySelectorAll('.selectBoxLang a');
            var clicked = false;
            for (var i = 0; i < langLinks.length; i++) {
              if (langLinks[i].textContent.trim() === langEntry.codeName) {
                langLinks[i].click();
                clicked = true;
                break;
              }
            }
            if (!clicked) {
              // Fallback: set directly
              var c = app.current;
              if (c && c.answerResult) {
                c.answerResult.languageIndex = codeNum;
                c.answerResult.languageName = langEntry.codeName;
              }
            }
            reply({ status: 'success', languageIndex: codeNum, languageName: langEntry.codeName, clicked: clicked });
          }, 200);
        } else {
          // No UI selector, set directly
          var c = app.current;
          if (c && c.answerResult) {
            c.answerResult.languageIndex = codeNum;
            c.answerResult.languageName = langEntry.codeName;
            reply({ status: 'success', languageIndex: codeNum, languageName: langEntry.codeName });
          } else {
            fail('无法访问 answerResult');
          }
        }
      } catch (err) {
        fail('setLanguage 错误: ' + err.message);
      }
    }

    // ========== setCode (代码编辑任务) ==========
    else if (action === 'setCode') {
      var code = e.data.code;
      if (code === undefined || code === null) return fail('缺少 code 参数');

      try {
        // Method 1: Direct CodeMirror DOM access (most reliable)
        var cmElement = document.querySelector('.CodeMirror');
        if (cmElement && cmElement.CodeMirror) {
          cmElement.CodeMirror.setValue(code);
          cmElement.CodeMirror.clearHistory();
          reply({ status: 'success', length: code.length });
          return;
        }

        // Method 2: Try app.editors (if it's a real editor instance)
        if (app.editors && Object.keys(app.editors).length > 0) {
          var editorId = app.currentEditorId || Object.keys(app.editors)[0];
          var editor = app.editors[editorId];
          if (editor && typeof editor.setValue === 'function') {
            editor.setValue(code);
            reply({ status: 'success', length: code.length });
            return;
          }
        }

        fail('找不到代码编辑器实例');
      } catch (err) {
        fail('setCode 错误: ' + err.message);
      }
    }

    // ========== evaluateCode (代码编辑任务) ==========
    else if (action === 'evaluateCode') {
      try {
        // Build answerResult JSON
        var cmElement = document.querySelector('.CodeMirror');
        var code = cmElement && cmElement.CodeMirror ? cmElement.CodeMirror.getValue() : '';
        var c = app.current;
        var answerResult = {
          answerResultCode: code,
          languageIndex: c.answerResult ? c.answerResult.languageIndex : -1,
          languageName: c.answerResult ? c.answerResult.languageName : ''
        };

        // Call init API to create record (this is what "保存代码" button does)
        var initUrl = '/mooc2-ans/ai-evaluate/v2/answer/init?courseid=' + (new URLSearchParams(location.search).get('courseid') || '')
          + '&clazzid=' + (new URLSearchParams(location.search).get('clazzid') || '')
          + '&cpi=' + (new URLSearchParams(location.search).get('cpi') || '')
          + '&publishRelationUuid=' + (c.publishRelationUuid || '');

        fetch(initUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
          body: 'type=4&codeUuid=' + (c.codeUuid || '') + '&answerResult=' + encodeURIComponent(JSON.stringify(answerResult))
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.status && data.data && data.data.recordUuid) {
            // Update Vue state with recordUuid
            c.recordUuid = data.data.recordUuid;
            if (data.data.answerUuid) c.answerUuid = data.data.answerUuid;

            // Now start evaluation
            setTimeout(function () {
              if (typeof app.startEvaluationExecute === 'function') {
                app.startEvaluationExecute();
              } else if (typeof app.startEvaluate === 'function') {
                app.startEvaluate();
              }
            }, 500);

            reply({ status: 'started', recordUuid: data.data.recordUuid });
          } else {
            fail('初始化作答记录失败: ' + (data.msg || JSON.stringify(data)));
          }
        })
        .catch(function(err) {
          fail('evaluateCode 网络错误: ' + err.message);
        });
      } catch (err) {
        fail('evaluateCode 错误: ' + err.message);
      }
    }

    // ========== getCodeState (代码编辑任务) ==========
    else if (action === 'getCodeState') {
      try {
        var c = app.current || {};
        var content = htmlToPlainText(c.content || c.requirementContent || '').trim();

        reply({
          title: c.title || '',
          requirement: content || c.requirement || '',
          type: c.type,
          codeUuid: c.codeUuid || '',
          languageIndex: c.answerResult ? c.answerResult.languageIndex : -1,
          languageName: c.answerResult ? c.answerResult.languageName : '',
          langList: app.langList || {},
          recordStatus: c.recordStatus || 0,
          evaluateStatus: c.evaluateStatus || 0,
          remainAnswerCount: c.remainAnswerCount,
          answerScore: c.answerScore,
          publishSetting: c.publishSetting || {},
          lastAnswerResult: c.answerResult || null,
          canStartEvaluate: app.canStartEvaluate,
        });
      } catch (err) {
        fail('getCodeState 错误: ' + err.message);
      }
    }

    else {
      fail('未知action: ' + action);
    }
  });

  console.log('[ChaoxingAI] page-inject.js 已加载', isNewArch() ? '(新架构 situationalDialogue)' : '(旧架构 ai-evaluate)', 'Vue应用:', !!getApp());
})();
