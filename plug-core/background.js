// Service Worker - 处理DeepSeek API调用（避免内容脚本的CORS限制）

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEEPSEEK_CHAT') {
    callDeepSeek(message.apiKey, message.baseUrl, message.model, message.messages, message.maxTokens, message.thinkingMode)
      .then(res => sendResponse({ success: true, data: res.content, usage: res.usage }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'DEEPSEEK_TEST') {
    testConnection(message.apiKey, message.baseUrl, message.model, message.thinkingMode)
      .then(info => sendResponse({ success: true, data: info }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 获取当前课程的AI实践任务列表
  if (message.type === 'FETCH_TASK_LIST') {
    fetchTaskList(message.courseId, message.cpi)
      .then(list => sendResponse({ success: true, data: list }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 解析任务引擎中的AI实践子任务URL
  if (message.type === 'RESOLVE_TASK_AI_URLS') {
    resolveTaskAiUrls(message.taskId, message.classId)
      .then(urls => sendResponse({ success: true, data: urls }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 核查新版/旧版讨论任务是否已由当前学生回复过
  if (message.type === 'CHECK_DISCUSS_STATUS') {
    checkDiscussStatusBatch(message.items, message.puid, message.userName)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 核查非 mooc2-ans 域名扫描到的 AI 实践作答状态
  if (message.type === 'CHECK_AI_PRACTICE_STATUS') {
    checkAiPracticeStatusBatch(message.items)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 批量模式：导航到下一个任务
  if (message.type === 'NAVIGATE_TASK') {
    var tabId = sender.tab ? sender.tab.id : null;
    chrome.storage.local.set({ cxai_batch_queue: message.queue, cxai_batch_auto: true }, () => {
      if (tabId) {
        chrome.tabs.update(tabId, { url: message.url });
      } else {
        // 备用：在当前活动标签页打开
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) chrome.tabs.update(tabs[0].id, { url: message.url });
        });
      }
    });
    sendResponse({ success: true });
    return true;
  }
});

const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
};

function normalizeModelId(model) {
  const raw = String(model || 'deepseek-flash').trim();
  return MODEL_ALIASES[raw] || raw;
}

function buildChatUrl(baseUrl) {
  const b = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v1$/i.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

function buildChatPayload(model, messages, maxTokens, thinkingMode, url, includeThinking) {
  const resolvedModel = normalizeModelId(model);
  const mode = String(thinkingMode || 'none').toLowerCase();
  const isThinking = mode !== 'none' && mode !== 'disabled';
  const isDeepSeek = /deepseek\.com/i.test(url) || /^deepseek-/i.test(resolvedModel);

  const payload = {
    model: resolvedModel,
    messages,
  };

  if (includeThinking && isDeepSeek) {
    // DeepSeek V4 默认开启 high 思考模式，显式设置 thinking/reasoning_effort 以防 reasoning_content 耗尽 max_tokens
    payload.thinking = { type: isThinking ? 'enabled' : 'disabled' };
    payload.reasoning_effort = isThinking ? mode : 'none';
  }

  if (isThinking && isDeepSeek) {
    // 思考模式下 reasoning_content 与 content 共享 max_tokens，且 temperature 不生效
    payload.max_tokens = Math.max(maxTokens || 1200, 8192);
  } else {
    payload.temperature = 0.75;
    payload.max_tokens = maxTokens || 1200;
  }

  return payload;
}

async function callDeepSeek(apiKey, baseUrl, model, messages, maxTokens, thinkingMode) {
  const url = buildChatUrl(baseUrl);

  async function sendRequest(includeThinking) {
    const payload = buildChatPayload(model, messages, maxTokens, thinkingMode, url, includeThinking);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error(`网络连接失败 (${url}): ${e.message}。请检查网络或Base URL是否正确`);
    }
    return resp;
  }

  let resp = await sendRequest(true);
  if (!resp.ok) {
    const text = await resp.text();
    // 兼容部分第三方 OpenAI 代理不支持 thinking/reasoning_effort 字段
    if (resp.status === 400 && /thinking|reasoning_effort|unknown|extra_forbidden/i.test(text)) {
      resp = await sendRequest(false);
      if (!resp.ok) {
        const retryText = await resp.text();
        throw new Error(`DeepSeek API ${resp.status}: ${retryText.substring(0, 200)}`);
      }
    } else {
      if (resp.status === 401) throw new Error('API Key 无效或已过期');
      if (resp.status === 402) throw new Error('API 余额不足');
      if (resp.status === 429) throw new Error('请求频率超限，请稍后再试');
      throw new Error(`DeepSeek API ${resp.status}: ${text.substring(0, 200)}`);
    }
  }

  const data = await resp.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('API 返回数据异常: ' + JSON.stringify(data).substring(0, 200));
  }
  const msg = data.choices[0].message || {};
  return {
    content: msg.content || '',
    reasoningContent: msg.reasoning_content || '',
    usage: data.usage || null,  // 含 prompt_tokens, completion_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens
  };
}

async function fetchTaskList(courseId, cpi) {
  const url = `https://mooc2-ans.chaoxing.com/mooc2-ans/ai-evaluate/answer/list?courseid=${courseId}&cpi=${cpi}&type=&q=&pageNo=1&pageSize=100`;
  let resp;
  try {
    resp = await fetch(url, { method: 'GET', credentials: 'include' });
  } catch (e) {
    throw new Error('获取任务列表失败: ' + e.message);
  }
  if (!resp.ok) throw new Error('任务列表接口返回 ' + resp.status);
  const html = await resp.text();
  // 从返回的HTML/JSON中提取任务列表
  // 该接口返回的是包含任务卡片的HTML片段或JSON
  try {
    const data = JSON.parse(html);
    if (data && data.data) return data.data;
  } catch (e) {
    // 非JSON，尝试从HTML提取
  }
  return [];
}

function isAiPracticeUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    var url = String(rawUrl).trim();
    return /\/ai-evaluate\//i.test(url)
      || /\/mooc2-ans\/ai-evaluate\//i.test(url)
      || /\/mooc2-ans-vue\/situationalDialogue/i.test(url);
  } catch (e) {
    return false;
  }
}

// 解析任务引擎中的AI实践子任务
async function resolveTaskAiUrls(taskId, classId) {
  // 1. 跟随 jumpStudyPlanList 重定向，获取 encryTaskUserId
  const jumpUrl = `https://task.chaoxing.com/api/v1/middlePageApi/jumpStudyPlanList?taskId=${taskId}&moocClassId=${classId}`;
  let jumpResp;
  try {
    jumpResp = await fetch(jumpUrl, { redirect: 'follow', credentials: 'include' });
  } catch (e) {
    throw new Error('无法访问任务引擎: ' + e.message);
  }

  let encryTaskUserId = null;
  // 尝试从最终URL参数中提取
  try {
    const finalUrl = new URL(jumpResp.url);
    encryTaskUserId = finalUrl.searchParams.get('encryTaskUserId');
  } catch (e) { /* ignore */ }

  // 备用：从HTML中提取
  if (!encryTaskUserId) {
    const html = await jumpResp.text();
    const m = html.match(/eTaskUserId\s*=\s*["']([^"']+)["']/);
    if (m) encryTaskUserId = m[1];
  }

  if (!encryTaskUserId) throw new Error('无法获取 encryTaskUserId');

  // 2. 获取分组
  const groupResp = await fetch(
    `https://task.chaoxing.com/userStudyPlan/getGroupData?encryTaskUserId=${encodeURIComponent(encryTaskUserId)}`,
    { method: 'POST', credentials: 'include' }
  );
  const groupData = await groupResp.json();
  if (!groupData.result || !groupData.data) return [];

  const aiUrls = [];

  // 3. 遍历分组获取计划
  for (const group of groupData.data) {
    const encGroupId = encodeURIComponent(group.encryptGroupId);
    const planResp = await fetch(
      `https://task.chaoxing.com/userStudyPlan/getPlanDataByGroupId?encryTaskUserId=${encodeURIComponent(encryTaskUserId)}&encryGroupId=${encGroupId}`,
      { method: 'POST', credentials: 'include' }
    );
    const planData = await planResp.json();
    if (!planData.result || !planData.data) continue;

    // 4. 获取每个子计划的跳转URL，并基于真实目标页识别 AI 实践
    for (const plan of planData.data) {
      try {
        const encPlanId = encodeURIComponent(plan.encryptPlanId);
        const urlResp = await fetch(
          `https://task.chaoxing.com/userStudyPlan/getToStudyUrl?encryptPlanId=${encPlanId}&encryTaskUserId=${encodeURIComponent(encryTaskUserId)}&studyJumpType=0`,
          { method: 'POST', credentials: 'include' }
        );
        const urlData = await urlResp.json();
        if (urlData.result && urlData.data && urlData.data.url && isAiPracticeUrl(urlData.data.url)) {
          aiUrls.push({
            name: plan.name,
            url: urlData.data.url,
            isFinish: plan.isFinish || false,
            planType: plan.planType,
          });
        }
      } catch (e) { /* skip individual plan errors */ }
    }
  }

  return aiUrls;
}

async function testConnection(apiKey, baseUrl, model) {
  const res = await callDeepSeek(
    apiKey,
    baseUrl,
    model,
    [{ role: 'user', content: 'Hi' }],
    16,
    'none'
  );
  const resolved = normalizeModelId(model);
  return `连接成功! 模型: ${resolved}${res.content ? '' : ' (响应正常)'}`;
}

function extractDiscussIds(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(String(rawUrl), 'https://groupweb.chaoxing.com');
    const pathMatch = u.pathname.match(/\/bbs\/([^/?#]+)\/([^/?#]+)/);
    if (pathMatch) {
      return { bbsid: decodeURIComponent(pathMatch[1]), uuid: decodeURIComponent(pathMatch[2]) };
    }
    const bbsid = u.searchParams.get('bbsid');
    const uuid = u.searchParams.get('uuid');
    if (bbsid && uuid) return { bbsid, uuid };
  } catch (e) { /* ignore */ }
  return null;
}

async function fetchCurrentPuidFromChaoxing() {
  try {
    const resp = await fetch('https://noteyd.chaoxing.com/pc/files/getYunPanUploadUrl?from=group&CrossOrigin=true', {
      credentials: 'include'
    });
    if (!resp.ok) return '';
    const json = await resp.json();
    const raw = json && typeof json.data === 'string' ? json.data : JSON.stringify(json || {});
    const m = raw.match(/[?&]puid=(\d+)/);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

function replyMatchesUser(item, puid, userName) {
  if (!item || typeof item !== 'object') return false;
  if (puid) {
    const candidates = [item.create_puid, item.createrPuid, item.puid, item.creater_id];
    if (candidates.some(v => v !== undefined && v !== null && String(v) === puid)) return true;
  } else if (userName && !item.isAnonymous) {
    if (String(item.creater_name || '').trim() === userName) return true;
  }
  return false;
}

async function checkSingleDiscussReplied(bbsid, uuid, puid, userName) {
  const MAX_PAGES = 8;
  let lastValue = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const apiUrl = `https://groupweb.chaoxing.com/pc/invitation/getReplyList?bbsid=${encodeURIComponent(bbsid)}&uuid=${encodeURIComponent(uuid)}&tag=&order=2&lastValue=${encodeURIComponent(lastValue)}&lastAuxValue=`;
    let json = null;
    try {
      const resp = await fetch(apiUrl, { credentials: 'include' });
      if (!resp.ok) return null;
      json = await resp.json();
    } catch (e) {
      return null;
    }
    if (!json || !json.status) return null;
    const datas = Array.isArray(json.datas) ? json.datas : [];
    for (const item of datas) {
      if (replyMatchesUser(item, puid, userName)) return { replied: true, exhaustive: false };
      if (Array.isArray(item && item.second_data)) {
        for (const sub of item.second_data) {
          if (replyMatchesUser(sub, puid, userName)) return { replied: true, exhaustive: false };
        }
      }
    }
    const poff = json.poff || {};
    const nextCursor = poff.lastValue !== undefined && poff.lastValue !== null ? String(poff.lastValue) : '';
    if (Number(poff.lastPage) === 1 || datas.length === 0 || !nextCursor || nextCursor === String(lastValue)) {
      return { replied: false, exhaustive: true };
    }
    lastValue = nextCursor;
  }
  return { replied: false, exhaustive: false };
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

async function checkDiscussStatusBatch(items, hintPuid, hintUserName) {
  const out = {};
  if (!Array.isArray(items) || items.length === 0) return out;
  let puid = String(hintPuid || '').trim();
  const userName = String(hintUserName || '').trim();
  if (!puid) {
    puid = await fetchCurrentPuidFromChaoxing();
  }
  if (!puid && !userName) return out;

  const targets = [];
  for (const it of items) {
    if (!it || !it.url) continue;
    const ids = extractDiscussIds(it.url);
    if (ids) targets.push({ url: it.url, bbsid: ids.bbsid, uuid: ids.uuid });
  }
  await runWithConcurrency(targets, 4, async (t) => {
    const res = await checkSingleDiscussReplied(t.bbsid, t.uuid, puid, userName);
    if (res) out[t.url] = res;
  });
  return out;
}

async function checkAiPracticeStatusBatch(items) {
  const out = {};
  if (!Array.isArray(items) || items.length === 0) return out;
  const targets = items.filter(it => it && it.url && /publishRelationUuid=/i.test(it.url));
  await runWithConcurrency(targets, 4, async (it) => {
    try {
      const u = new URL(it.url, 'https://mooc2-ans.chaoxing.com');
      const uuid = u.searchParams.get('publishRelationUuid');
      if (!uuid) return;
      const cId = u.searchParams.get('courseId') || u.searchParams.get('courseid') || it.courseId || '';
      const clId = u.searchParams.get('classId') || u.searchParams.get('clazzid') || it.classId || '';
      const cpi = u.searchParams.get('cpi') || it.cpi || '';
      const ldUrl = `https://mooc2-ans.chaoxing.com/mooc2-ans/ai-evaluate/v2/answer/load-data?courseid=${encodeURIComponent(cId)}&clazzid=${encodeURIComponent(clId)}&cpi=${encodeURIComponent(cpi)}&publishRelationUuid=${encodeURIComponent(uuid)}&recordUuid=`;
      const resp = await fetch(ldUrl, { credentials: 'include' });
      if (!resp.ok) return;
      const json = await resp.json();
      const d = json && json.data;
      if (!d) return;

      const patch = {};
      if ((it.taskMode === 'file' || it.taskMode === 'image') && Array.isArray(d.rules) && d.rules.length > 0) {
        const allowDoc = d.rules.some(rule => {
          const exts = rule && Array.isArray(rule.extensions) ? rule.extensions.join(',').toLowerCase() : '';
          return /doc|docx|pdf|txt|md/.test(exts) || rule.category === 'document';
        });
        patch.taskMode = allowDoc ? 'file' : 'image';
      }
      if (d.remainAnswerCount !== undefined && d.remainAnswerCount !== null && d.remainAnswerCount !== '') {
        patch.remainAnswerCount = Number(d.remainAnswerCount);
      }
      const answerCount = Number(d.answerCount || 0);
      const scoreCount = Number(d.scoreCount || 0);
      const records = Array.isArray(d.answerRecords) ? d.answerRecords : [];
      const reach = (d.publishSetting && d.publishSetting.reachStandard !== undefined && d.publishSetting.reachStandard !== null && d.publishSetting.reachStandard !== '')
        ? Number(d.publishSetting.reachStandard)
        : 0;
      let bestScore = (d.answerScore !== undefined && d.answerScore !== null && d.answerScore !== '')
        ? Number(d.answerScore)
        : NaN;
      if (Number.isNaN(bestScore) && records.length > 0) {
        for (const rec of records) {
          if (rec && rec.score !== undefined && rec.score !== null && rec.score !== '') {
            const s = Number(rec.score);
            if (!Number.isNaN(s) && (Number.isNaN(bestScore) || s > bestScore)) bestScore = s;
          }
        }
      }
      const hasEvaluated = records.some(rec => rec && Number(rec.status) === 2);
      const hasAttempt = answerCount > 0 || scoreCount > 0 || records.length > 0 || !Number.isNaN(bestScore);
      if (hasAttempt) {
        if (!Number.isNaN(bestScore)) patch.answerScore = bestScore;
        if (!Number.isNaN(reach) && reach > 0) patch.reachStandard = reach;
        const reached = Number.isNaN(bestScore)
          ? (hasEvaluated || answerCount > 0)
          : (Number.isNaN(reach) || reach <= 0 || bestScore >= reach);
        patch.isFinish = reached;
        patch.belowStandard = !reached;
      } else if (patch.remainAnswerCount === 0) {
        patch.isFinish = true;
      }
      out[it.url] = patch;
    } catch (e) { /* skip individual check failures */ }
  });
  return out;
}
