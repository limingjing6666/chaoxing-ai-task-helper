// Service Worker - 处理DeepSeek API调用（避免内容脚本的CORS限制）

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEEPSEEK_CHAT') {
    callDeepSeek(message.apiKey, message.baseUrl, message.model, message.messages, message.maxTokens)
      .then(reply => sendResponse({ success: true, data: reply }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'DEEPSEEK_TEST') {
    testConnection(message.apiKey, message.baseUrl, message.model)
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

async function callDeepSeek(apiKey, baseUrl, model, messages, maxTokens) {
  const url = `${baseUrl}/v1/chat/completions`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.75,
        max_tokens: maxTokens || 1200,
      }),
    });
  } catch (e) {
    throw new Error(`网络连接失败 (${url}): ${e.message}。请检查网络或Base URL是否正确`);
  }

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401) throw new Error('API Key 无效或已过期');
    if (resp.status === 402) throw new Error('API 余额不足');
    if (resp.status === 429) throw new Error('请求频率超限，请稍后再试');
    throw new Error(`DeepSeek API ${resp.status}: ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('API 返回数据异常: ' + JSON.stringify(data).substring(0, 200));
  }
  return data.choices[0].message.content;
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
      || /mooc2-ans\.chaoxing\.com\/mooc2-ans\/ai-evaluate\//i.test(url);
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
  const url = `${baseUrl}/v1/chat/completions`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
      }),
    });
  } catch (e) {
    throw new Error(`无法连接 ${url}: ${e.message}`);
  }

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401) throw new Error('API Key 无效');
    throw new Error(`API 返回 ${resp.status}: ${text.substring(0, 100)}`);
  }

  const data = await resp.json();
  return `连接成功! 模型: ${data.model || model}`;
}
