// 运行在主题讨论详情页主世界 (MAIN world)
// 负责：读取话题内容、填写回复、提交回复
(function () {
  'use strict';

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

    // ========== getDiscussState ==========
    if (action === 'getDiscussState') {
      try {
        var topicContent = '';
        var topicTitle = '';
        var hasReplied = false;

        // 方式1: groupweb 页面 window.obj.topic
        if (window.obj && window.obj.topic) {
          var topic = window.obj.topic;
          topicContent = topic.text_content || topic.content || '';
          topicTitle = topic.title || '';
          // rtf_content 里可能有更完整的纯文本
          if (!topicContent && topic.rtf_content) {
            var tmp = document.createElement('div');
            tmp.innerHTML = topic.rtf_content;
            topicContent = tmp.textContent.trim();
          }
        }

        // 方式2: Vue 实例
        if (!topicContent) {
          var appEl = document.getElementById('app') || document.getElementById('main');
          var app = appEl && appEl.__vue__ ? appEl.__vue__ : null;
          if (app) {
            var data = app.$data || app;
            topicTitle = topicTitle || data.topicTitle || data.title || '';
            topicContent = data.topicContent || data.content || data.topicDesc || '';
            hasReplied = !!(data.hasReply || data.isReply || data.myReplyId);
          }
        }

        // 方式3: DOM - groupweb 话题详情区域
        if (!topicContent) {
          var topicEls = document.querySelectorAll('#bbsTopicDetail, .noticeDetail_detail, .topic-content, .topicContent, .bbs-content, .detail-content');
          for (var i = 0; i < topicEls.length; i++) {
            var text = topicEls[i].textContent.trim();
            if (text.length > 10) { topicContent = text; break; }
          }
        }

        // 方式4: 兜底
        if (!topicContent) {
          var possibleEls = document.querySelectorAll('.detail p, .topic p, .questionContent, .stem');
          for (var j = 0; j < possibleEls.length; j++) {
            var t = possibleEls[j].textContent.trim();
            if (t.length > 20) { topicContent = t; break; }
          }
        }

        if (!topicTitle) {
          topicTitle = document.title.replace(/\s*[-–—|].*/g, '').trim() || '主题讨论';
        }

        // 检查回复输入框
        var replyBox = document.querySelector('.replyEdit textarea, textarea[placeholder*="回复"], .ql-editor, textarea');
        var canReply = !!replyBox;

        reply({
          topicTitle: topicTitle,
          topicContent: topicContent,
          hasReplied: hasReplied,
          canReply: canReply,
        });
      } catch (err) {
        fail('getDiscussState 错误: ' + err.message);
      }
    }

    // ========== submitDiscussReply ==========
    else if (action === 'submitDiscussReply') {
      var replyText = e.data.text || '';
      if (!replyText.trim()) return fail('回复内容不能为空');

      try {
        // 查找回复文本框 - groupweb 页面用 .replyEdit textarea
        var textarea = document.querySelector('.replyEdit textarea, textarea[placeholder*="回复"], textarea.reply-textarea, textarea.replyContent, #replyContent, .reply-box textarea, textarea');
        var qlEditor = document.querySelector('.ql-editor');

        if (qlEditor) {
          qlEditor.innerHTML = '<p>' + replyText.replace(/\n/g, '</p><p>') + '</p>';
          qlEditor.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (textarea) {
          // 先聚焦让编辑器激活
          textarea.focus();
          textarea.value = replyText;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          // 触发 keyup 以便 autoheight 等脚本响应
          textarea.dispatchEvent(new Event('keyup', { bubbles: true }));

          if (textarea.__vue__) {
            textarea.__vue__.$emit('input', replyText);
          }
        } else {
          return fail('找不到回复输入框');
        }

        console.log('[ChaoxingAI] 回复内容已填入，等待提交...');

        // 等待让页面响应
        setTimeout(function () {
          // groupweb 页面的提交按钮是 .addReply
          var submitBtn = document.querySelector('.addReply');
          if (!submitBtn) {
            // 兜底：按文本匹配
            var candidates = document.querySelectorAll('button, .btn, a.btn, a.jb_btn, div.jb_btn, .submit-btn, .reply-btn');
            for (var i = 0; i < candidates.length; i++) {
              var btnText = candidates[i].textContent.trim();
              if (btnText === '回复' || btnText === '提交' || btnText === '发布' || btnText === '发表') {
                submitBtn = candidates[i];
                break;
              }
            }
          }

          if (!submitBtn) {
            return fail('找不到提交按钮');
          }

          console.log('[ChaoxingAI] 点击提交按钮:', submitBtn.textContent.trim());
          submitBtn.click();

          // 等待提交完成
          setTimeout(function () {
            reply({ status: 'success' });
          }, 3000);
        }, 800);
      } catch (err) {
        fail('submitDiscussReply 错误: ' + err.message);
      }
    }

    else {
      // 不认识的 action 不报错，可能是其他 inject 处理的
    }
  });

  console.log('[ChaoxingAI] discuss-inject.js 已加载 (讨论页)');
})();
