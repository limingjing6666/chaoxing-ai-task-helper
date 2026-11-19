// 运行在任务列表页主世界 (MAIN world)
// 兼容旧版 mobilelearn(stuActiveList) 与新版 fanyav3(studentCourse)
(function () {
  'use strict';

  function isFanyaCoursePage() {
    return location.hostname === 'mooc2-ans.chaoxing.com' && location.pathname.indexOf('/mooc2-ans-vue/fanyav3/studentCourse') !== -1;
  }

  function getSearchParams() {
    // 兼容 fanyav3/studentCourse??courseId=... 双问号 URL
    return new URLSearchParams(String(location.search || '').replace(/^\?+/, ''));
  }

  function normalizeTaskName(raw) {
    return (raw || '').replace(/\s+/g, ' ').trim();
  }

  function isDiscussTaskText(text) {
    return /主题讨论|讨论/i.test(String(text || ''));
  }

  function normalizeTaskUrl(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (/^\/\//.test(text)) return location.protocol + text;
    if (/^\//.test(text)) {
      try { return new URL(text, location.origin).href; } catch (e) { return text; }
    }
    return text;
  }

  function extractUrlFromString(text) {
    var match = String(text || '').match(/(?:https?:\/\/|\/\/|\/)[^"'\s)]+/);
    return match ? normalizeTaskUrl(match[0]) : '';
  }

  function extractTaskUrlFromNode(node) {
    if (!node) return '';

    var anchor = node.matches && node.matches('a[href]') ? node : node.querySelector && node.querySelector('a[href]');
    if (anchor && anchor.href) return anchor.href;

    var attrs = ['href', 'data-href', 'data-url', 'url', 'aiPracticeUrl', 'data-stuUrl'];
    for (var i = 0; i < attrs.length; i++) {
      var attr = node.getAttribute && node.getAttribute(attrs[i]);
      if (attr) return normalizeTaskUrl(attr);
    }

    var clickable = node.querySelector && node.querySelector('[onclick]');
    var onclickText = clickable && clickable.getAttribute ? clickable.getAttribute('onclick') : (node.getAttribute && node.getAttribute('onclick'));
    var extracted = extractUrlFromString(onclickText || '');
    if (extracted) return extracted;

    return '';
  }

  function extractTaskUrlFromItem(item) {
    if (!item) return '';

    var candidates = [item.url, item.stuUrl, item.detailUrl, item.jumpUrl, item.href, item.link, item.activeUrl];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) return normalizeTaskUrl(candidates[i]);
    }

    try {
      var content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
      if (content) {
        var nested = [content.stuUrl, content.url, content.detailUrl, content.jumpUrl, content.href, content.link, content.activeUrl, content.activityUrl, content.openUrl];
        for (var j = 0; j < nested.length; j++) {
          if (nested[j]) return normalizeTaskUrl(nested[j]);
        }
      }
    } catch (ex) {}

    return '';
  }

  function pushTask(tasks, task) {
    if (!task || !task.url) return;
    var entry = {
      name: normalizeTaskName(task.name || '未命名任务'),
      url: String(task.url).trim(),
      source: task.source || 'dom',
      taskMode: task.taskMode || 'chat',
    };
    if (task.isFinish !== undefined) entry.isFinish = task.isFinish;
    if (task.isEnded !== undefined) entry.isEnded = task.isEnded;
    if (task.answerScore !== undefined) entry.answerScore = task.answerScore;
    if (task.reachStandard !== undefined) entry.reachStandard = task.reachStandard;
    if (task.belowStandard !== undefined) entry.belowStandard = task.belowStandard;
    if (task.remainAnswerCount !== undefined) entry.remainAnswerCount = task.remainAnswerCount;
    tasks.push(entry);
  }

  function getPageParam(name) {
    try {
      var match = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
      if (match) return decodeURIComponent(match[1]);
      var iframe = document.querySelector('iframe[src*="' + name + '="]');
      if (iframe && iframe.src) {
        var m2 = iframe.src.match(new RegExp('[?&]' + name + '=([^&]*)'));
        if (m2) return decodeURIComponent(m2[1]);
      }
    } catch (e) {}
    return '';
  }

  function buildDiscussPlaceholder(activeId, courseId, classId, cpi) {
    return 'cxai-discuss://' + activeId + '?courseId=' + courseId + '&classId=' + classId + '&cpi=' + (cpi || '');
  }

  function collectRenderedAiTasks() {
    var pageCourseid = window.courseId || '';
    var pageClassid = window.classId || '';
    var pageCpi = window.cpi || '';
    var tasks = [];

    // 1. 直接 AI 实践项：li[aiPracticeUrl]
    var directItems = document.querySelectorAll('li[aiPracticeUrl]');
    directItems.forEach(function (li) {
      var url = li.getAttribute('aiPracticeUrl') || '';
      var titleEl = li.querySelector('p, .overHidden2, .title, .name');
      pushTask(tasks, {
        name: titleEl ? titleEl.textContent : '未命名任务',
        url: url,
        source: 'dom-direct'
      });
    });

    // 2. 普通任务流中的 AI 实践：icon-aiPractice[data-stuUrl]
    var aiIcons = document.querySelectorAll('.icon-aiPractice[data-stuUrl]');
    aiIcons.forEach(function (icon) {
      var url = icon.getAttribute('data-stuUrl') || '';
      var li = icon.closest('li');
      var titleEl = li ? li.querySelector('p, .overHidden2, .title, .name') : null;
      pushTask(tasks, {
        name: titleEl ? titleEl.textContent : '未命名任务',
        url: url,
        source: 'dom-active77'
      });
    });

    // 3. 主题讨论任务：按列表标签 + 链接/点击目标识别
    var listItems = document.querySelectorAll('li, .el-list-item, .active-item, .task-item');
    listItems.forEach(function (item) {
      var text = item && item.textContent ? item.textContent.replace(/\s+/g, ' ').trim() : '';
      if (!isDiscussTaskText(text)) return;
      var url = extractTaskUrlFromNode(item);
      if (!url) return;
      var titleEl = item.querySelector('p, .overHidden2, .title, .name');
      pushTask(tasks, {
        name: titleEl ? titleEl.textContent : '未命名任务',
        url: url,
        source: 'dom-discuss',
        taskMode: 'discuss'
      });
    });

    // 4. 尝试从页面 Vue 数据兜底提取所有 activeList*
    try {
      var appEl = document.getElementById('main');
      var app = appEl && appEl.__vue__ ? appEl.__vue__ : null;
      var data = app && app.$data ? app.$data : null;
      if (data) {
        (data.activeList4 || []).forEach(function (item) {
          pushTask(tasks, {
            name: item.title || item.name || '未命名任务',
            url: item.url,
            source: 'vue-active4'
          });
        });
        Object.keys(data).forEach(function (key) {
          if (!/^activeList\d+$/.test(key)) return;
          var arr = data[key];
          if (!Array.isArray(arr)) return;
          arr.forEach(function (item) {
            if (!item) return;
            var aType = Number(item.activeType);

            // AI 实践 (activeType=77)
            if (aType === 77) {
              var itemUrl = extractTaskUrlFromItem(item);
              if (!itemUrl) return;
              pushTask(tasks, {
                name: item.name || item.title || item.nameOne || '未命名任务',
                url: itemUrl,
                source: 'vue-' + key,
                taskMode: 'chat'
              });
            }
            // 主题讨论 (activeType=5)
            else if (aType === 5) {
              var extra = item.extraInfo || {};
              var topicId = extra.topicId;
              if (!topicId) return;
              var discussUrl = buildDiscussPlaceholder(item.id, pageCourseid, pageClassid, pageCpi);
              var taskName = item.nameOne || item.name || item.title || '未命名讨论';
              if (taskName.length > 40) taskName = taskName.substring(0, 40) + '...';
              pushTask(tasks, {
                name: taskName,
                url: discussUrl,
                source: 'vue-discuss-' + key,
                taskMode: 'discuss',
                isFinish: item.status === 2 ? true : (item.userStatus === 2 ? true : false)
              });
            }
            // 代码编辑型 AI 实践 (activeType=4)
            else if (aType === 4) {
              var itemUrl4 = extractTaskUrlFromItem(item);
              if (!itemUrl4) return;
              pushTask(tasks, {
                name: item.name || item.title || item.nameOne || '未命名代码任务',
                url: itemUrl4,
                source: 'vue-' + key,
                taskMode: 'code'
              });
            }
            // AI思维阶梯 (activeType=2)
            else if (aType === 2) {
              var itemUrl2 = extractTaskUrlFromItem(item);
              if (!itemUrl2) return;
              pushTask(tasks, {
                name: item.name || item.title || item.nameOne || '未命名思维阶梯',
                url: itemUrl2,
                source: 'vue-' + key,
                taskMode: 'ladder'
              });
            }
          });
        });
      }
    } catch (err) {}

    var seen = {};
    return tasks.filter(function (task) {
      if (!task || !task.url) return false;
      if (seen[task.url]) return false;
      seen[task.url] = true;
      return true;
    });
  }

  // 按规范化标题收集 DOM 卡片按钮状态队列，避免同名活动（如多个"主题讨论"）后者覆盖前者
  function collectFanyaDomFinishMap() {
    var queues = {};
    try {
      var cards = document.querySelectorAll('.task-item.activity-item, .task-item');
      cards.forEach(function (card) {
        var titleEl = card.querySelector('.item-title, p.item-title');
        var btn = card.querySelector('button.action-btn, .action-btn');
        if (!titleEl || !btn) return;
        var title = normalizeTaskName(titleEl.textContent);
        if (!title) return;
        var btnText = (btn.textContent || '').trim();
        var btnCls = btn.className || '';
        var entry = null;
        if (/已完成/.test(btnText)) {
          entry = { finish: true, explicitFinish: true };
        } else if (/查看详情/.test(btnText) || /\bgray\b/.test(btnCls)) {
          entry = { finish: true, explicitFinish: false };
        } else if (/去完成|立即参与/.test(btnText) || /\bprimary\b/.test(btnCls)) {
          entry = { finish: false, explicitFinish: false };
        }
        if (!entry) return;
        if (!Object.prototype.hasOwnProperty.call(queues, title)) queues[title] = [];
        queues[title].push(entry);
      });
    } catch (e) {}
    return queues;
  }

  function consumeDomFinish(domQueues, normName, isItemClosed) {
    if (!normName || !Object.prototype.hasOwnProperty.call(domQueues, normName)) return undefined;
    var q = domQueues[normName];
    if (!Array.isArray(q) || q.length === 0) return undefined;
    var idx = -1;
    if (isItemClosed) {
      idx = q.findIndex(function (e) { return e.finish === true; });
    } else {
      idx = q.findIndex(function (e) { return e.finish === false || e.explicitFinish === true; });
    }
    if (idx === -1) return undefined;
    var picked = q.splice(idx, 1)[0];
    return picked ? picked.finish : undefined;
  }

  function injectCpiParam(rawUrl, cpi) {
    if (!rawUrl || !cpi) return rawUrl;
    try {
      var u = new URL(rawUrl, location.origin);
      if (!u.searchParams.get('cpi')) {
        u.searchParams.set('cpi', cpi);
      }
      return u.toString();
    } catch (e) {
      return rawUrl;
    }
  }

  function parseFanyaActiveList(activeList, courseId, classId, cpi) {
    var tasks = [];
    var domFinishQueues = collectFanyaDomFinishMap();
    (activeList || []).forEach(function (item) {
      if (!item) return;
      var aType = Number(item.activeType || item.type);
      var rawName = item.nameOne || item.name || item.title || '';
      var normName = normalizeTaskName(rawName);
      var isItemClosed = (Number(item.status) === 2);
      var finishFromDom = consumeDomFinish(domFinishQueues, normName, isItemClosed);
      var defaultFinish = (Number(item.userStatus) === 2 || isItemClosed);

      // AI 实践 (activeType=77)
      if (aType === 77) {
        var content = null;
        var sc = null;
        try {
          content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
        } catch (e) {}
        if (content && content.sourceConfig) {
          try {
            sc = typeof content.sourceConfig === 'string' ? JSON.parse(content.sourceConfig) : content.sourceConfig;
          } catch (e) {}
        }

        var targetUrl = '';
        var taskMode = 'chat';
        if (sc && sc.publishRelationUuid) {
          var libType = Number(sc.libraryType);
          var cid = sc.courseId || courseId;
          var clz = sc.clazzId || classId;
          if (libType === 0) {
            targetUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans-vue/situationalDialogue?courseid='
              + encodeURIComponent(cid) + '&clazzid=' + encodeURIComponent(clz)
              + '&cpi=' + encodeURIComponent(cpi || '')
              + '&publishRelationUuid=' + encodeURIComponent(sc.publishRelationUuid);
            taskMode = 'chat';
          } else {
            targetUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/ai-evaluate/v2/answer?courseid='
              + encodeURIComponent(cid) + '&clazzid=' + encodeURIComponent(clz)
              + '&cpi=' + encodeURIComponent(cpi || '')
              + '&publishRelationUuid=' + encodeURIComponent(sc.publishRelationUuid);
            if (libType === 1) taskMode = 'file';
            else if (libType === 4) taskMode = 'code';
            else if (libType === 2) taskMode = 'ladder';
          }
        } else if (content && content.stuUrl) {
          targetUrl = normalizeTaskUrl(content.stuUrl);
        } else {
          targetUrl = extractTaskUrlFromItem(item);
        }

        if (!targetUrl) return;
        pushTask(tasks, {
          name: rawName || '未命名AI实践',
          url: targetUrl,
          source: 'fanya3-activity77',
          taskMode: taskMode,
          isFinish: finishFromDom !== undefined ? finishFromDom : defaultFinish,
          isEnded: isItemClosed
        });
      }
      // 主题讨论 (activeType=5)
      else if (aType === 5) {
        var discussUrl = item.url ? normalizeTaskUrl(item.url) : '';
        if (discussUrl) {
          discussUrl = injectCpiParam(discussUrl, cpi);
        } else if (item.extraInfo && item.extraInfo.topicId) {
          discussUrl = buildDiscussPlaceholder(item.id, courseId, classId, cpi);
        }
        if (!discussUrl) return;
        var dName = normName || '未命名讨论';
        if (dName.length > 40) dName = dName.substring(0, 40) + '...';
        pushTask(tasks, {
          name: dName,
          url: discussUrl,
          source: 'fanya3-discuss5',
          taskMode: 'discuss',
          isFinish: finishFromDom !== undefined ? finishFromDom : defaultFinish,
          isEnded: isItemClosed
        });
      }
    });

    var seen = {};
    return tasks.filter(function (t) {
      if (!t || !t.url || seen[t.url]) return false;
      seen[t.url] = true;
      return true;
    });
  }

  function applyAiLoadDataToTask(t, d) {
    if (!t || !d) return;
    if ((t.taskMode === 'file' || t.taskMode === 'image') && Array.isArray(d.rules) && d.rules.length > 0) {
      var allowDoc = d.rules.some(function (rule) {
        var exts = rule && Array.isArray(rule.extensions) ? rule.extensions.join(',').toLowerCase() : '';
        return /doc|docx|pdf|txt|md/.test(exts) || rule.category === 'document';
      });
      t.taskMode = allowDoc ? 'file' : 'image';
    }
    if (d.remainAnswerCount !== undefined && d.remainAnswerCount !== null && d.remainAnswerCount !== '') {
      t.remainAnswerCount = Number(d.remainAnswerCount);
    }

    var answerCount = Number(d.answerCount || 0);
    var scoreCount = Number(d.scoreCount || 0);
    var records = Array.isArray(d.answerRecords) ? d.answerRecords : [];
    var reach = (d.publishSetting && d.publishSetting.reachStandard !== undefined && d.publishSetting.reachStandard !== null && d.publishSetting.reachStandard !== '')
      ? Number(d.publishSetting.reachStandard)
      : 0;
    var bestScore = (d.answerScore !== undefined && d.answerScore !== null && d.answerScore !== '')
      ? Number(d.answerScore)
      : NaN;
    if (isNaN(bestScore) && records.length > 0) {
      records.forEach(function (rec) {
        if (rec && rec.score !== undefined && rec.score !== null && rec.score !== '') {
          var s = Number(rec.score);
          if (!isNaN(s) && (isNaN(bestScore) || s > bestScore)) bestScore = s;
        }
      });
    }
    var hasEvaluated = records.some(function (rec) { return rec && Number(rec.status) === 2; });
    var hasAttempt = answerCount > 0 || scoreCount > 0 || records.length > 0 || !isNaN(bestScore);
    if (hasAttempt) {
      if (!isNaN(bestScore)) t.answerScore = bestScore;
      if (!isNaN(reach) && reach > 0) t.reachStandard = reach;
      var reached = isNaN(bestScore)
        ? (hasEvaluated || answerCount > 0)
        : (isNaN(reach) || reach <= 0 || bestScore >= reach);
      if (t.isEnded && !reached) {
        t.isFinish = true;
        t.belowStandard = false;
      } else {
        t.isFinish = reached;
        t.belowStandard = !reached;
      }
    } else if (t.remainAnswerCount === 0) {
      t.isFinish = true;
    }
  }

  // 查询所有含 publishRelationUuid 的 AI 实践真实作答数据（含文件/图片类型判别与达标状态）
  function enrichFanyaFileTaskModes(tasks, courseId, classId, cpi) {
    var checks = tasks.map(function (t) {
      if (!t || !t.url || t.taskMode === 'discuss') return Promise.resolve(t);
      try {
        var u = new URL(t.url, location.origin);
        var uuid = u.searchParams.get('publishRelationUuid');
        if (!uuid) return Promise.resolve(t);
        var cId = u.searchParams.get('courseId') || u.searchParams.get('courseid') || courseId || '';
        var clId = u.searchParams.get('classId') || u.searchParams.get('clazzid') || classId || '';
        var cCpi = u.searchParams.get('cpi') || cpi || '';
        var ldUrl = '/mooc2-ans/ai-evaluate/v2/answer/load-data?courseid=' + encodeURIComponent(cId)
          + '&clazzid=' + encodeURIComponent(clId)
          + '&cpi=' + encodeURIComponent(cCpi)
          + '&publishRelationUuid=' + encodeURIComponent(uuid)
          + '&recordUuid=';
        return fetch(ldUrl, { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (json) {
            var d = json && json.data;
            if (d) applyAiLoadDataToTask(t, d);
            return t;
          })
          .catch(function () { return t; });
      } catch (e) {
        return Promise.resolve(t);
      }
    });
    return Promise.all(checks);
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

    // 获取页面全局课程参数（兼容 mobilelearn 全局变量与 fanyav3 URL 参数）
    if (action === 'getPageInfo') {
      var sp = getSearchParams();
      var cid = window.courseId || sp.get('courseId') || sp.get('courseid') || '';
      var clz = window.classId || window.clazzId || sp.get('clazzId') || sp.get('clazzid') || sp.get('classId') || '';
      var cp = window.cpi || sp.get('cpi') || '';
      if (cid && clz) {
        reply({ courseId: String(cid), classId: String(clz), cpi: String(cp), isFanya: isFanyaCoursePage() });
      } else {
        fail('未找到 courseId/classId');
      }
    }

    // 新版课程任务中心 (fanyav3/studentCourse)：调用 activityList 接口
    else if (action === 'getFanyaTasks') {
      var fCourseId = e.data.courseId;
      var fClassId = e.data.classId;
      var fCpi = e.data.cpi || '';
      var fUrl = '/mooc2-ans/fanya3/s/activityList?courseId=' + encodeURIComponent(fCourseId)
        + '&clazzId=' + encodeURIComponent(fClassId)
        + '&cpi=' + encodeURIComponent(fCpi);
      fetch(fUrl, { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (json) {
          var activeList = (json && json.data && Array.isArray(json.data.activeList)) ? json.data.activeList : [];
          var parsed = parseFanyaActiveList(activeList, fCourseId, fClassId, fCpi);
          return enrichFanyaFileTaskModes(parsed, fCourseId, fClassId, fCpi);
        })
        .then(function (enriched) {
          reply({ status: true, data: enriched });
        })
        .catch(function (err) { fail('请求 fanya3 activityList 失败: ' + err.message); });
    }

    // 调用 AI实践活动列表接口（activeList4，直接的AI实践任务）
    else if (action === 'getAiPracticeList') {
      var courseId = e.data.courseId;
      var classId = e.data.classId;
      var domain = (window.ServiceDomain && window.ServiceDomain.moocAnsDomainWithProtocol)
        || 'https://mooc2-ans.chaoxing.com';
      var url = domain + '/mooc2-ans/ai-evaluate/v2/answer/activities?courseid=' + courseId + '&clazzid=' + classId;

      if (window.$ && window.$.ajax) {
        window.$.ajax({
          url: url, type: 'get', dataType: 'json',
          crossDomain: true, xhrFields: { withCredentials: true },
          success: function (json) { reply(json); },
          error: function (xhr, status, err) { fail('请求失败: ' + (err || status)); }
        });
      } else {
        fetch(url, { credentials: 'include' })
          .then(function (r) { return r.json(); })
          .then(function (json) { reply(json); })
          .catch(function (err) { fail(err.message); });
      }
    }

    // 获取任务引擎任务列表（activeList3，通过 getData API）
    else if (action === 'getTaskEngineList') {
      var courseId2 = e.data.courseId;
      var classId2 = e.data.classId;
      var url2 = '/v2/apis/active/getData?DB_STRATEGY=DEFAULT&courseId=' + courseId2 + '&classId=' + classId2;

      if (window.axios) {
        window.axios.get(url2, { params: { courseId: courseId2, classId: classId2 } })
          .then(function (resp) { reply(resp.data); })
          .catch(function (err) { fail(err.message); });
      } else if (window.$ && window.$.ajax) {
        window.$.ajax({
          url: url2, type: 'get', dataType: 'json',
          success: function (json) { reply(json); },
          error: function (xhr, status, err) { fail('请求失败: ' + (err || status)); }
        });
      } else {
        fetch(url2).then(function (r) { return r.json(); })
          .then(function (json) { reply(json); })
          .catch(function (err) { fail(err.message); });
      }
    }

    else if (action === 'resolveDiscussInfo') {
      var activeId = e.data.activeId;
      var courseId = e.data.courseId;
      var classId = e.data.classId;
      var cpi = e.data.cpi || '';
      var apiUrl = '/v2/apis/discuss/getTopicDiscussInfo?activeId=' + activeId;
      if (courseId) apiUrl += '&courseId=' + courseId;
      if (classId) apiUrl += '&classId=' + classId;

      var doFetch = function () {
        fetch(apiUrl, { credentials: 'include' })
          .then(function (r) { return r.json(); })
          .then(function (json) {
            if (json && json.result === 1 && json.data) {
              var d = json.data;
              var domain = d.groupwebDomain || 'https://groupweb.chaoxing.com';
              var realUrl = domain + '/pc/topic/jumpToTopicDetail?bbsid=' + encodeURIComponent(d.bbsid)
                + '&uuid=' + encodeURIComponent(d.uuid)
                + '&courseId=' + encodeURIComponent(courseId || '')
                + '&classId=' + encodeURIComponent(classId || '')
                + '&cpi=' + encodeURIComponent(cpi || '')
                + '&t=' + Date.now();
              reply({ url: realUrl, bbsid: d.bbsid, uuid: d.uuid });
            } else {
              fail('API返回异常: ' + (json && json.msg || '未知'));
            }
          })
          .catch(function (err) { fail(err.message); });
      };

      if (window.$ && window.$.ajax) {
        window.$.ajax({
          url: apiUrl, type: 'get', dataType: 'json',
          success: function (json) {
            if (json && json.result === 1 && json.data) {
              var d = json.data;
              var domain = d.groupwebDomain || 'https://groupweb.chaoxing.com';
              var realUrl = domain + '/pc/topic/jumpToTopicDetail?bbsid=' + encodeURIComponent(d.bbsid)
                + '&uuid=' + encodeURIComponent(d.uuid)
                + '&courseId=' + encodeURIComponent(courseId || '')
                + '&classId=' + encodeURIComponent(classId || '')
                + '&cpi=' + encodeURIComponent(cpi || '')
                + '&t=' + Date.now();
              reply({ url: realUrl, bbsid: d.bbsid, uuid: d.uuid });
            } else {
              fail('API返回异常: ' + (json && json.msg || '未知'));
            }
          },
          error: function (xhr, status, err) { fail('请求失败: ' + (err || status)); }
        });
      } else {
        doFetch();
      }
    }

    else if (action === 'getRenderedAiTaskList') {
      try {
        if (isFanyaCoursePage()) {
          reply({ status: true, data: [] });
        } else {
          reply({ status: true, data: collectRenderedAiTasks() });
        }
      } catch (err) {
        fail('读取页面任务失败: ' + err.message);
      }
    }

    else {
      fail('未知 action: ' + action);
    }
  });

  console.log('[ChaoxingAI] task-page-inject.js 已加载', isFanyaCoursePage() ? '(新版 fanyav3)' : '(mobilelearn)');
})();
