// 运行在 mobilelearn.chaoxing.com 任务列表页主世界 (MAIN world)
// 读取页面全局变量 courseId / classId，调用 AI实践活动列表 API
(function () {
  'use strict';

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
      // === DEBUG: 打印 Vue 数据结构 ===
      console.log('[ChaoxingAI DEBUG] appEl:', appEl, 'app:', app);
      if (data) {
        Object.keys(data).forEach(function (key) {
          if (/^activeList\d+$/.test(key) && Array.isArray(data[key]) && data[key].length > 0) {
            console.log('[ChaoxingAI DEBUG] ' + key + ' (' + data[key].length + '项):');
            data[key].forEach(function (item, idx) {
              if (item.activeType === 5 || item.activeType === '5') {
                console.log('[ChaoxingAI DEBUG]   [' + idx + '] activeType=5 全部字段:', Object.keys(item));
                try { console.log('[ChaoxingAI DEBUG]   [' + idx + '] RAW:', JSON.stringify(item).substring(0, 800)); } catch(e) { console.log('[ChaoxingAI DEBUG]   [' + idx + '] RAW stringify失败, keys:', Object.keys(item)); }
              } else {
                console.log('[ChaoxingAI DEBUG]   [' + idx + ']', JSON.stringify({
                  name: item.name, title: item.title, activeType: item.activeType,
                  activeTypeName: item.activeTypeName, typeName: item.typeName,
                  url: item.url, stuUrl: item.stuUrl, content: typeof item.content === 'string' ? item.content.substring(0, 300) : item.content
                }));
              }
            });
          }
        });
      } else {
        console.log('[ChaoxingAI DEBUG] Vue data 为空');
      }
      // === END DEBUG ===
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

    // 获取页面全局课程参数
    if (action === 'getPageInfo') {
      var cid = window.courseId || '';
      var clz = window.classId || '';
      var cp = window.cpi || '';
      if (cid && clz) {
        reply({ courseId: cid, classId: clz, cpi: cp });
      } else {
        fail('未找到 courseId/classId');
      }
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
        reply({ status: true, data: collectRenderedAiTasks() });
      } catch (err) {
        fail('读取页面任务失败: ' + err.message);
      }
    }

    else {
      fail('未知 action: ' + action);
    }
  });

  console.log('[ChaoxingAI] task-page-inject.js 已加载 (mobilelearn)');
})();
