/**
 * Playwright 自動填寫週報表單
 *
 * 用法 (透過 playwright-cli run-code):
 *   playwright-cli run-code --filename=fill-form.js
 *
 * 需要先設定環境變數或準備好暫存檔:
 *   /tmp/weekly_categories.json - 分類內容 JSON (由 weekly-report.sh 產生)
 *
 * 環境變數:
 *   REPORT_EMAIL, REPORT_DEPT, REPORT_NAME, CATEGORIES
 */
async (page) => {
  const fs = require('fs');

  const email = process.env.REPORT_EMAIL;
  const dept = process.env.REPORT_DEPT;
  const name = process.env.REPORT_NAME;

  if (!email || !dept || !name) {
    console.log('錯誤: 缺少 REPORT_EMAIL, REPORT_DEPT 或 REPORT_NAME 環境變數');
    return '缺少必要環境變數';
  }

  let categories;
  try {
    categories = JSON.parse(process.env.CATEGORIES);
  } catch (e) {
    console.log('錯誤: CATEGORIES 環境變數解析失敗');
    return 'CATEGORIES 格式錯誤';
  }

  // 讀取分類內容
  let categoryContents = {};
  try {
    const raw = fs.readFileSync('/tmp/weekly_categories.json', 'utf-8');
    categoryContents = JSON.parse(raw);
  } catch (e) {
    console.log('Warning: /tmp/weekly_categories.json not found or invalid, using defaults');
    for (const cat of categories) {
      categoryContents[cat.name] = '本週無紀錄';
    }
  }

  // 進入 iframe
  const frame1 = page.locator('iframe[title="原創中心週報系統"]').contentFrame();
  const frame2 = frame1.locator('iframe[title="原創中心週報系統"]').contentFrame();

  const emailInput = frame2.getByRole('textbox', { name: 'xxx@gamania.com' });
  const isLoginPage = await emailInput.isVisible().catch(() => false);

  if (isLoginPage) {
    console.log('在登入頁面，開始填寫登入資訊...');
    await emailInput.fill(email);
    await frame2.locator('#login-dept').selectOption([dept]);
    await page.waitForTimeout(1000);
    await frame2.locator('#login-name').selectOption([name]);

    await frame2.getByRole('button', { name: '進入系統' }).click();
    await page.waitForTimeout(3000);
    console.log('已進入系統');
  } else {
    console.log('已在系統內，跳過登入');
  }

  // 等待第一個分類欄位出現
  const firstField = categories[0].field;
  await frame2.locator(firstField).waitFor({ state: 'visible', timeout: 10000 });

  // 依序填入每個分類欄位
  for (const cat of categories) {
    const content = categoryContents[cat.name] || '本週無紀錄';
    console.log(`填寫「${cat.name}」(${cat.field})...`);
    await frame2.locator(cat.field).fill(content);
    await page.waitForTimeout(2000);
  }

  console.log('週報填寫完成！等待自動儲存...');
  await page.waitForTimeout(3000);

  return '填寫完成！';
}
