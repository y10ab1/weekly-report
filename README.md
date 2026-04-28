# weekly-report

從 GitHub 自動抓取本週 commits 與 PRs，依自訂分類整理後，自動填入週報系統。

支援 Gemini AI 智慧總結，也可純規則分類。可透過 GitHub Actions 排程執行或本地手動執行。

## 快速開始

### 1. Fork 或 Clone

```bash
git clone https://github.com/<your-username>/weekly-report.git
cd weekly-report
npm install
npx playwright install chromium
```

### 2. 設定環境變數

複製範本並填入你的資訊：

```bash
cp .env.example .env
```

編輯 `.env`，填入所有**必要**的環境變數（見下方說明）。

### 3. 預覽

```bash
source .env && DRY_RUN=true node index.js
```

### 4. 實際填寫

```bash
source .env && node index.js
```

## 環境變數

### 必要

| 變數 | 說明 |
|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token，需有 repo 讀取權限 |
| `GITHUB_USERNAME` | 你的 GitHub 帳號 |
| `REPORT_EMAIL` | 公司 Email |
| `REPORT_DEPT` | 部門名稱（需與週報系統下拉選單完全一致） |
| `REPORT_NAME` | 姓名（需與週報系統下拉選單完全一致） |
| `REPORT_URL` | 週報系統網址 |
| `CATEGORIES` | 分類設定 JSON（格式見下方） |

### 可選

| 變數 | 預設 | 說明 |
|---|---|---|
| `GEMINI_API_KEY` | — | Gemini API Key，用於 AI 自動總結 |
| `DAYS` | `7` | 抓取最近幾天的活動 |
| `DRY_RUN` | `false` | 設為 `true` 僅預覽不填寫 |
| `HEADLESS` | `true` | 設為 `false` 顯示瀏覽器視窗 |
| `USE_AI` | `true` | 設為 `false` 停用 AI 總結 |

## CATEGORIES 格式

`CATEGORIES` 是一個 JSON 陣列，每個元素代表一個分類：

```json
[
  {
    "name": "AI條漫生成",
    "field": "#content-1",
    "repos": ["manga_canvas5", "manga-canvas", "comic", "webtoon"]
  },
  {
    "name": "AI中心業務與研究",
    "field": "#content-2",
    "repos": ["*"]
  }
]
```

| 欄位 | 說明 |
|---|---|
| `name` | 分類顯示名稱（也用作 AI prompt 的分類名） |
| `field` | 對應週報表單的 CSS selector（如 `#content-1`） |
| `repos` | 匹配的 repo 名稱關鍵字陣列。設為 `["*"]` 代表「其餘未匹配的全部歸到這類」 |

分類匹配邏輯：
1. 先依序匹配有具體 `repos` 的分類
2. 最後把未被匹配的活動歸入 `repos: ["*"]` 的分類

你可以定義多個分類，例如三個分類：

```json
[
  {"name": "前端開發", "field": "#content-1", "repos": ["web-app", "admin-panel"]},
  {"name": "後端開發", "field": "#content-2", "repos": ["api-server", "microservice"]},
  {"name": "其他",     "field": "#content-3", "repos": ["*"]}
]
```

## GitHub Actions 自動執行

Fork 後，在你的 repo 中設定：

### Secrets（Settings → Secrets and variables → Actions → Secrets）

| Secret | 說明 |
|---|---|
| `GH_PAT` | GitHub Personal Access Token |
| `GEMINI_API_KEY` | Gemini API Key（可選） |

### Variables（Settings → Secrets and variables → Actions → Variables）

| Variable | 說明 |
|---|---|
| `GH_USERNAME` | 你的 GitHub 帳號 |
| `REPORT_EMAIL` | 公司 Email |
| `REPORT_DEPT` | 部門名稱 |
| `REPORT_NAME` | 姓名 |
| `REPORT_URL` | 週報系統網址 |
| `CATEGORIES` | 分類設定 JSON |

設定完成後，每週四下午 4:00（台灣時間）會自動執行。也可以在 Actions 頁面手動觸發。

## 專案結構

```
weekly-report/
├── index.js          # 主程式（Node.js，推薦使用）
├── fill-form.js      # Playwright 填表腳本（搭配 weekly-report.sh）
├── weekly-report.sh  # Shell 版本（使用 gh CLI + python3）
├── .env.example      # 環境變數範本
├── .github/
│   └── workflows/
│       └── weekly-report.yml  # GitHub Actions 排程
├── package.json
└── README.md
```

## 執行方式

| 方式 | 指令 | 說明 |
|---|---|---|
| Node.js（推薦） | `node index.js` | 完整流程：抓取 → 分類/AI → 填表 |
| Node.js 預覽 | `DRY_RUN=true node index.js` | 只看分類結果，不填表 |
| Shell 版 | `./weekly-report.sh` | 使用 gh CLI，需要 python3 |
| Shell 預覽 | `./weekly-report.sh --dry-run` | 只看分類結果 |
| GitHub Actions | 自動排程或手動觸發 | 每週四 16:00 (UTC+8) |
