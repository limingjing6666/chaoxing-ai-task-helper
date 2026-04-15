// 运行在页面主世界 (MAIN world)，可直接访问 Vue 实例
(function () {
  function getApp() {
    var el = document.getElementById('app');
    return el && el.__vue__;
  }

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== 'cxai-content') return;
    var action = e.data.action;
    var id = e.data.id;

    function reply(data) {
      window.postMessage({ source: 'cxai-page', id: id, data: data }, '*');
    }
    function fail(msg) {
      window.postMessage({ source: 'cxai-page', id: id, error: msg }, '*');
    }

    var app = getApp();
    if (!app) {
      return fail('找不到Vue应用实例(#app.__vue__)，请确认页面已完全加载');
    }

    // ========== getState ==========
    if (action === 'getState') {
      var c = app.current || {};
      try {
        reply({
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
          fileObjectId: c.fileObjectId || '',
          fileType: c.fileType || '',
          fileName: c.fileName || '',
          fileParseStatus: c.fileParseStatus || '',
          canStartEvaluate: app.canStartEvaluate,
        });
      } catch (err) {
        fail('getState 错误: ' + err.message);
      }
    }

    // ========== sendMessage ==========
    else if (action === 'sendMessage') {
      if (app.current.isLoadingChat) return fail('AI老师正在回复中');
      if (app.current.recordStatus === 1 || app.current.recordStatus === 2) return fail('作答已提交');

      app.textareaText = e.data.text;
      app.sendMessage();

      var waited = 0;
      var maxWait = 90000;
      var poll = 400;

      function waitSend() {
        if (waited < 5000 && !app.current.isLoadingChat) {
          waited += poll;
          return setTimeout(waitSend, poll);
        }
        waitResponse();
      }

      function waitResponse() {
        if (waited >= maxWait) return fail('等待AI老师回复超时(90s)');
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
        var courseId = document.getElementById('courseId');
        var clazzId = document.getElementById('clazzId');
        var cpi = document.getElementById('cpi');
        var pubUuid = document.getElementById('publishRelationUuid');
        reply({
          courseId: courseId ? courseId.value : '',
          clazzId: clazzId ? clazzId.value : '',
          cpi: cpi ? cpi.value : '',
          publishRelationUuid: pubUuid ? pubUuid.value : '',
        });
      } catch (err) {
        fail('getPageInfo 错误: ' + err.message);
      }
    }

    // ========== submitEvaluate ==========
    else if (action === 'submitEvaluate') {
      if (!app.canStartEvaluate) return fail('当前不满足提交条件(无对话/未上传文件/已提交)');

      app.startEvaluate();

      var evalWaited = 0;
      var evalMax = 180000;
      var evalPoll = 2000;

      function checkEval() {
        evalWaited += evalPoll;
        if (evalWaited > evalMax) return fail('评估超时(180s)');
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

    // ========== uploadFile (文件上传型任务) ==========
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
        var uploadMax = 120000;
        var uploadPoll = 2000;

        function checkUpload() {
          uploadWaited += uploadPoll;
          if (uploadWaited > uploadMax) return fail('文件上传/解析超时(120s)');

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
      for (var mi = 0; mi < retryMethods.length; mi++) {
        if (typeof app[retryMethods[mi]] === 'function') {
          console.log('[ChaoxingAI] retryTask: 调用 app.' + retryMethods[mi] + '()');
          reply({ success: true, method: retryMethods[mi] });
          setTimeout(function () { app[retryMethods[mi]](); }, 100);
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

    else {
      fail('未知action: ' + action);
    }
  });

  console.log('[ChaoxingAI] page-inject.js 已加载，Vue应用:', !!getApp());
})();
