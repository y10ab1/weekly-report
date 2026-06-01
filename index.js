#!/usr/bin/env node
/**
 * 週報自動填寫工具
 *
 * 從 GitHub 抓取本週所有 commits 和 PRs，依使用者自訂分類後自動填入週報系統。
 *
 * 環境變數:
 *   GITHUB_TOKEN     - GitHub Personal Access Token (必要)
 *   GITHUB_USERNAME  - GitHub 帳號 (必要)
 *   GITHUB_EMAILS    - 你在各 repo commit 時使用的 email，逗號分隔 (可選，用於抓取別人 repo 的 commit)
 *   REPORT_EMAIL     - 公司 Email (必要)
 *   REPORT_DEPT      - 部門 (必要)
 *   REPORT_NAME      - 姓名 (必要)
 *   REPORT_URL       - 週報系統網址 (必要)
 *   CATEGORIES       - 分類設定 JSON (必要，格式見 README.md)
 *   GEMINI_API_KEY   - Gemini API Key (可選，用於 AI 總結)
 *   DAYS             - 抓取天數 (預設: 7)
 *   DRY_RUN          - 設為 true 則僅預覽不填寫
 *   HEADLESS         - 設為 false 則顯示瀏覽器 (預設: true)
 *   USE_AI           - 設為 false 則不使用 AI 總結 (預設: true，需要 GEMINI_API_KEY)
 */

import { chromium } from 'playwright';

// === Helpers ===

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`錯誤: 缺少必要的環境變數 ${name}`);
    console.error('請參考 .env.example 或 README.md 設定所有必要的環境變數。');
    process.exit(1);
  }
  return value;
}

function parseCategories(json) {
  try {
    const categories = JSON.parse(json);
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('CATEGORIES 必須是非空的 JSON 陣列');
    }
    for (const cat of categories) {
      if (!cat.name || !cat.field || !Array.isArray(cat.repos)) {
        throw new Error(`每個 category 必須包含 name, field, repos 欄位。問題項目: ${JSON.stringify(cat)}`);
      }
    }
    return categories;
  } catch (e) {
    console.error(`錯誤: CATEGORIES 解析失敗 — ${e.message}`);
    console.error('格式範例: [{"name":"分類一","field":"#content-1","repos":["repo-keyword"]},{"name":"其他","field":"#content-2","repos":["*"]}]');
    process.exit(1);
  }
}

// === 設定 ===

const config = {
  githubToken: requireEnv('GITHUB_TOKEN'),
  geminiApiKey: process.env.GEMINI_API_KEY,
  githubUsername: requireEnv('GITHUB_USERNAME'),
  githubEmails: process.env.GITHUB_EMAILS
    ? process.env.GITHUB_EMAILS.split(',').map(e => e.trim())
    : [],
  reportEmail: requireEnv('REPORT_EMAIL'),
  reportDept: requireEnv('REPORT_DEPT'),
  reportName: requireEnv('REPORT_NAME'),
  reportUrl: requireEnv('REPORT_URL'),
  categories: parseCategories(requireEnv('CATEGORIES')),
  days: parseInt(process.env.DAYS || '7', 10),
  dryRun: process.env.DRY_RUN === 'true',
  headless: process.env.HEADLESS !== 'false',
  useAI: process.env.USE_AI !== 'false',
};

// === GitHub API ===

async function githubFetch(url) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'weekly-report-bot',
  };
  if (config.githubToken) {
    headers['Authorization'] = `token ${config.githubToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function getCommits(sinceDate) {
  // === Step 1: 用 Search API 搜尋（能搜到公開 + 自己的 private repo）===
  const query = `author:${config.githubUsername} committer-date:>=${sinceDate}`;
  const url = `https://api.github.com/search/commits?q=${encodeURIComponent(query)}&per_page=100`;

  let allCommits = [];
  let searchRepos = new Set();
  let page = 1;

  while (true) {
    const data = await githubFetch(`${url}&page=${page}`);
    const items = data.items || [];
    if (items.length === 0) break;
    for (const c of items) {
      searchRepos.add(c.repository.full_name);
    }
    allCommits = allCommits.concat(items);
    if (items.length < 100) break;
    page++;
  }

  const searchResults = allCommits
    .filter(c => !c.commit.message.startsWith('Merge'))
    .map(c => {
      const msg = c.commit.message.split('\n')[0];
      return `[${c.repository.name}] ${msg}`;
    });

  console.log(`  Search API 找到 ${searchResults.length} 個 commits（來自 ${searchRepos.size} 個 repo）`);

  // === Step 2: 用 Events API 找出近期有 push 的所有 repo ===
  const eventRepos = await getReposFromEvents(sinceDate);
  const missingRepos = eventRepos.filter(r => !searchRepos.has(r));

  if (missingRepos.length === 0) {
    console.log(`  所有活躍 repo 皆已涵蓋，無需補充`);
    return searchResults;
  }

  console.log(`  發現 ${missingRepos.length} 個 repo 需補充抓取: ${missingRepos.join(', ')}`);

  // === Step 3: 對 Search API 搜不到的 repo，用 Repo Commits API 補抓 ===
  const extraResults = await getCommitsFromRepos(missingRepos, sinceDate);
  console.log(`  補充抓到 ${extraResults.length} 個 commits`);

  // === Step 4: 合併去重 ===
  const combined = [...searchResults, ...extraResults];
  return [...new Set(combined)];
}

async function getReposFromEvents(sinceDate) {
  const sinceTime = new Date(sinceDate).getTime();
  const repos = new Set();

  // Events API 最多回傳 10 頁 x 100 筆，涵蓋最近 90 天
  for (let page = 1; page <= 3; page++) {
    const url = `https://api.github.com/users/${config.githubUsername}/events?per_page=100&page=${page}`;
    try {
      const events = await githubFetch(url);
      if (events.length === 0) break;

      for (const event of events) {
        const eventTime = new Date(event.created_at).getTime();
        if (eventTime < sinceTime) continue;

        if (event.type === 'PushEvent') {
          repos.add(event.repo.name);
        }
      }
    } catch (e) {
      console.log(`  Events API page ${page} 失敗: ${e.message}`);
      break;
    }
  }

  return [...repos];
}

async function getCommitsFromRepos(repos, sinceDate) {
  const results = [];
  const emails = config.githubEmails;
  const username = config.githubUsername;

  for (const repoFullName of repos) {
    // 抓取該 repo 所有 branch
    let branches = [];
    try {
      branches = await githubFetch(`https://api.github.com/repos/${repoFullName}/branches?per_page=100`);
    } catch (e) {
      console.log(`  無法取得 ${repoFullName} 的 branches: ${e.message}`);
      continue;
    }

    const repoName = repoFullName.split('/').pop();
    const seen = new Set();

    for (const branch of branches) {
      // 嘗試用 username 搜
      const authors = [username, ...emails];

      for (const author of authors) {
        const url = `https://api.github.com/repos/${repoFullName}/commits?sha=${branch.name}&author=${encodeURIComponent(author)}&since=${sinceDate}T00:00:00Z&per_page=100`;
        try {
          const commits = await githubFetch(url);
          for (const c of commits) {
            if (seen.has(c.sha)) continue;
            seen.add(c.sha);

            const msg = c.commit.message.split('\n')[0];
            if (msg.startsWith('Merge')) continue;
            results.push(`[${repoName}] ${msg}`);
          }
        } catch (e) {
          // 靜默忽略單一 branch 的錯誤
        }
      }
    }
  }

  return [...new Set(results)];
}

async function getPRs(sinceDate) {
  const query = `author:${config.githubUsername} type:pr created:>=${sinceDate}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100`;

  const data = await githubFetch(url);
  const items = data.items || [];

  return items.map(pr => {
    const repoName = pr.repository_url.split('/').pop();
    return `[PR:${repoName}] ${pr.title}`;
  });
}

// === 分類 ===

function classify(activities) {
  const result = {};
  const matched = new Set();

  const format = (arr) => {
    if (arr.length === 0) return '本週無紀錄';
    const unique = [...new Set(arr)].sort();
    return unique.map(item => `- ${item}`).join('\n');
  };

  // 先處理有具體 repos 的分類（非 wildcard）
  for (const cat of config.categories) {
    if (cat.repos.includes('*')) continue;

    const pattern = new RegExp(
      `\\[(?:PR:)?(?:${cat.repos.join('|')})\\]`,
      'i'
    );

    const items = [];
    for (let i = 0; i < activities.length; i++) {
      if (pattern.test(activities[i])) {
        items.push(activities[i]);
        matched.add(i);
      }
    }
    result[cat.name] = format(items);
  }

  // 處理 wildcard 分類（收集剩餘項目）
  for (const cat of config.categories) {
    if (!cat.repos.includes('*')) continue;

    const items = [];
    for (let i = 0; i < activities.length; i++) {
      if (!matched.has(i)) {
        items.push(activities[i]);
      }
    }
    result[cat.name] = format(items);
  }

  return result;
}

// === Gemini AI 總結 ===

function buildAIPrompt(allActivities) {
  const activitiesText = allActivities.join('\n');

  const categoryRules = config.categories
    .map((cat, i) => {
      const repoHint = cat.repos.includes('*')
        ? '不屬於其他分類的所有項目'
        : `涉及 ${cat.repos.join(', ')} 的項目`;
      return `${i + 1}. ${cat.name}：${repoHint}`;
    })
    .join('\n');

  const jsonKeys = config.categories.map(cat => `"${cat.name}"`).join(', ');
  const jsonExample = '{' + config.categories.map(cat => `"${cat.name}": "該分類的總結內容..."`).join(', ') + '}';

  return `你是一個專業的助手。請分析以下我本週在 GitHub 所有專案的 commit 與 PR 紀錄，並依照分類規則整理。

**分類規則：**
${categoryRules}

**格式要求：**
1. 每類總結出 5-10 個重點，以 dash (-) 條列。
2. 每句話 10~20 個字左右，保留專業名詞與所屬 Repo (在每項最前方用[REPO_NAME]），不要多餘的問候語。
3. **必須**嚴格以下列 JSON 格式回覆，不要包含 Markdown 語法 (如 \`\`\`json) 或其他說明文字：
${jsonExample}

JSON key 必須為: ${jsonKeys}

以下是 Commit 與 PR 紀錄：
${activitiesText}`;
}

async function getAISummary(allActivities) {
  if (!config.geminiApiKey) {
    console.log('  未設定 GEMINI_API_KEY，跳過 AI 總結，使用規則分類。');
    return null;
  }

  const prompt = buildAIPrompt(allActivities);
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.geminiApiKey}`;

  try {
    const res = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`  Gemini API 錯誤 (${res.status}): ${errText}`);
      return null;
    }

    const data = await res.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!resultText) {
      console.log('  Gemini 回傳空內容');
      return null;
    }

    const cleanJson = resultText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(cleanJson);

    // 驗證回傳的 key 是否與分類名稱一致
    for (const cat of config.categories) {
      if (!(cat.name in parsed)) {
        console.log(`  警告: AI 回傳缺少分類「${cat.name}」，該欄位使用規則分類`);
      }
    }

    return parsed;
  } catch (e) {
    console.log(`  AI 處理失敗: ${e.message}`);
    return null;
  }
}

// === Playwright 填表 ===

async function fillForm(categoryContents) {
  console.log('啟動瀏覽器...');
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('導航到週報系統...');
    await page.goto(config.reportUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const frame1 = page.locator('iframe[title="原創中心週報系統"]').contentFrame();
    const frame2 = frame1.locator('iframe[title="原創中心週報系統"]').contentFrame();

    await frame2.getByRole('textbox', { name: 'xxx@gamania.com' }).waitFor({ state: 'visible', timeout: 15000 });

    console.log('填寫登入資訊...');
    await frame2.getByRole('textbox', { name: 'xxx@gamania.com' }).fill(config.reportEmail);
    await frame2.locator('#login-dept').selectOption([config.reportDept]);
    await page.waitForTimeout(1000);
    await frame2.locator('#login-name').selectOption([config.reportName]);

    await frame2.getByRole('button', { name: '進入系統' }).click();
    console.log('進入系統，等待載入...');
    await page.waitForTimeout(3000);

    // 等待第一個分類欄位出現
    const firstField = config.categories[0].field;
    await frame2.locator(firstField).waitFor({ state: 'visible', timeout: 15000 });
    console.log('表單已載入');

    // 依序填入每個分類欄位
    for (const cat of config.categories) {
      const content = categoryContents[cat.name] || '本週無紀錄';
      console.log(`填寫「${cat.name}」(${cat.field})...`);
      await frame2.locator(cat.field).fill(content);
      await page.waitForTimeout(2000);
    }

    console.log('等待自動儲存...');
    await page.waitForTimeout(5000);

    const savedIndicator = frame2.locator('text=已儲存').first();
    const isSaved = await savedIndicator.isVisible().catch(() => false);

    if (isSaved) {
      console.log('儲存成功！');
    } else {
      console.log('警告: 未偵測到「已儲存」指示，請手動確認。');
    }

  } finally {
    await browser.close();
    console.log('瀏覽器已關閉');
  }
}

// === 主流程 ===

async function main() {
  console.log('============================================');
  console.log('  週報自動填寫工具');
  console.log('============================================');

  const today = new Date();
  const lastWeek = new Date();
  lastWeek.setDate(today.getDate() - config.days);
  const sinceDate = lastWeek.toISOString().split('T')[0];

  console.log(`使用者: ${config.githubUsername}`);
  console.log(`關聯 emails: ${config.githubEmails.length > 0 ? config.githubEmails.join(', ') : '(未設定)'}`);
  console.log(`分類: ${config.categories.map(c => c.name).join(', ')}`);
  console.log(`抓取範圍: ${sinceDate} ~ ${today.toISOString().split('T')[0]}`);
  console.log(`模式: ${config.dryRun ? '預覽 (dry-run)' : '填寫'}`);
  console.log('');

  console.log('[1/4] 正在抓取 GitHub commits（Search API + Events API 補充）...');
  const commits = await getCommits(sinceDate);
  console.log(`  總共 ${commits.length} 個 commits`);

  console.log('[2/4] 正在抓取 GitHub PRs...');
  const prs = await getPRs(sinceDate);
  console.log(`  找到 ${prs.length} 個 PRs`);

  const allActivities = [...commits, ...prs];
  let categoryContents;

  if (config.useAI && config.geminiApiKey) {
    console.log('[3/4] 正在用 Gemini AI 分類與總結...');
    const aiResult = await getAISummary(allActivities);

    if (aiResult) {
      categoryContents = aiResult;
      console.log('  AI 總結完成');
    } else {
      console.log('  AI 總結失敗，回退到規則分類');
      categoryContents = classify(allActivities);
    }
  } else {
    console.log('[3/4] 正在用規則分類...');
    categoryContents = classify(allActivities);
  }

  // 如果 AI 回傳缺少某些分類，用規則分類補上
  const ruleClassified = classify(allActivities);
  for (const cat of config.categories) {
    if (!categoryContents[cat.name]) {
      categoryContents[cat.name] = ruleClassified[cat.name];
    }
  }

  console.log('');
  for (const cat of config.categories) {
    console.log(`========== ${cat.name} ==========`);
    console.log(categoryContents[cat.name]);
    console.log('');
  }

  if (config.dryRun) {
    console.log('[DRY RUN] 以上為預覽內容，不會填入表單。');
    return;
  }

  console.log('[4/4] 正在用 Playwright 填寫表單...');
  await fillForm(categoryContents);

  console.log('');
  console.log('============================================');
  console.log('  週報填寫完成！');
  console.log('============================================');
}

main().catch(err => {
  console.error('錯誤:', err.message);
  process.exit(1);
});
