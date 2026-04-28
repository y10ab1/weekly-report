#!/bin/bash
#
# 週報自動填寫腳本
#
# 用法:
#   ./weekly-report.sh              # 抓取 + 自動填入表單
#   ./weekly-report.sh --dry-run    # 僅預覽，不填入
#   ./weekly-report.sh --days 14    # 自訂抓取天數
#   ./weekly-report.sh --no-browser # 只產生內容檔，不開瀏覽器
#
# 需求:
#   - gh CLI (已登入 GitHub)
#   - playwright-cli (已安裝)
#
# 必要環境變數 (無預設值，請設定於 .env 或 shell):
#   GITHUB_USERNAME  - GitHub 帳號
#   REPORT_EMAIL     - 公司 Email
#   REPORT_DEPT      - 部門
#   REPORT_NAME      - 姓名
#   REPORT_URL       - 週報系統網址
#   CATEGORIES       - 分類設定 JSON (格式見 README.md)

set -euo pipefail

# === 檢查必要環境變數 ===
require_env() {
  if [ -z "${!1:-}" ]; then
    echo "錯誤: 缺少必要的環境變數 $1"
    echo "請參考 .env.example 或 README.md 設定所有必要的環境變數。"
    exit 1
  fi
}

require_env GITHUB_USERNAME
require_env REPORT_EMAIL
require_env REPORT_DEPT
require_env REPORT_NAME
require_env REPORT_URL
require_env CATEGORIES

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# === 參數解析 ===
DRY_RUN=false
DAYS=7
NO_BROWSER=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --days) DAYS="$2"; shift 2 ;;
    --no-browser) NO_BROWSER=true; shift ;;
    -h|--help)
      echo "用法: $0 [--dry-run] [--days N] [--no-browser]"
      echo ""
      echo "選項:"
      echo "  --dry-run      僅預覽內容，不填入表單"
      echo "  --days N       抓取最近 N 天的活動 (預設: 7)"
      echo "  --no-browser   只產生內容檔到 /tmp，不自動開瀏覽器"
      echo "  -h, --help     顯示此說明"
      exit 0
      ;;
    *) echo "未知參數: $1 (用 -h 查看說明)"; exit 1 ;;
  esac
done

SINCE_DATE=$(date -d "${DAYS} days ago" '+%Y-%m-%d' 2>/dev/null || date -v-${DAYS}d '+%Y-%m-%d')

# 從 CATEGORIES JSON 提取分類資訊
# 取得所有非 wildcard 分類的 repo 關鍵字 (用 | 分隔)
REPO_PATTERNS=$(echo "${CATEGORIES}" | python3 -c "
import json, sys
cats = json.load(sys.stdin)
patterns = []
for cat in cats:
    if '*' not in cat['repos']:
        patterns.extend(cat['repos'])
print('|'.join(patterns) if patterns else '')
")

echo "============================================"
echo "  週報自動填寫工具"
echo "============================================"
echo "使用者: ${GITHUB_USERNAME}"
echo "抓取範圍: ${SINCE_DATE} ~ 今天"
echo "模式: $([ "${DRY_RUN}" = true ] && echo "預覽" || echo "填寫")"
echo ""

# === Step 1: 抓取 GitHub Commits (非 merge) ===
echo "[1/4] 正在抓取 GitHub commits..."

COMMITS_RAW=$(gh api -X GET "search/commits" \
  -f "q=author:${GITHUB_USERNAME} committer-date:>=${SINCE_DATE}" \
  -f "per_page=100" \
  --jq '.items[] | select(.commit.message | startswith("Merge") | not) | "[" + .repository.name + "] " + (.commit.message | split("\n")[0])' \
  2>/dev/null || echo "")

COMMIT_COUNT=0
if [ -n "${COMMITS_RAW}" ]; then
  COMMIT_COUNT=$(echo "${COMMITS_RAW}" | wc -l)
fi
echo "  找到 ${COMMIT_COUNT} 個 commits"

# === Step 2: 抓取 GitHub PRs ===
echo "[2/4] 正在抓取 GitHub PRs..."

PRS_RAW=$(gh api -X GET "search/issues" \
  -f "q=author:${GITHUB_USERNAME} type:pr created:>=${SINCE_DATE}" \
  -f "per_page=100" \
  --jq '.items[] | "[PR:" + (.repository_url | split("/") | last) + "] " + .title' \
  2>/dev/null || echo "")

PR_COUNT=0
if [ -n "${PRS_RAW}" ]; then
  PR_COUNT=$(echo "${PRS_RAW}" | wc -l)
fi
echo "  找到 ${PR_COUNT} 個 PRs"

# === Step 3: 分類 ===
echo "[3/4] 正在分類..."

ALL_ACTIVITIES=$(printf '%s\n%s' "${COMMITS_RAW}" "${PRS_RAW}" | grep -v '^$' || echo "")

# 使用 python3 根據 CATEGORIES 動態分類，輸出 JSON
CLASSIFIED=$(echo "${ALL_ACTIVITIES}" | python3 -c "
import json, re, sys

categories = json.loads('''${CATEGORIES}''')
lines = [l.strip() for l in sys.stdin if l.strip()]

result = {}
matched = set()

def format_items(items):
    if not items:
        return '本週無紀錄'
    unique = sorted(set(items))
    return '\n'.join(f'- {item}' for item in unique)

# 先處理非 wildcard 分類
for cat in categories:
    if '*' in cat['repos']:
        continue
    pattern = re.compile(r'\[(?:PR:)?(?:' + '|'.join(re.escape(r) for r in cat['repos']) + r')\]', re.IGNORECASE)
    items = []
    for i, line in enumerate(lines):
        if pattern.search(line):
            items.append(line)
            matched.add(i)
    result[cat['name']] = format_items(items)

# 處理 wildcard 分類
for cat in categories:
    if '*' not in cat['repos']:
        continue
    items = [lines[i] for i in range(len(lines)) if i not in matched]
    result[cat['name']] = format_items(items)

print(json.dumps(result, ensure_ascii=False))
")

# 顯示分類結果
echo ""
echo "${CLASSIFIED}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for name, content in data.items():
    print(f'========== {name} ==========')
    print(content)
    print()
"

# 寫入暫存檔 (供 Playwright 讀取)
echo "${CLASSIFIED}" > /tmp/weekly_categories.json

# === Dry run 停在這裡 ===
if [ "${DRY_RUN}" = true ]; then
  echo "[DRY RUN] 以上為預覽內容，不會填入表單。"
  echo "內容已寫入: /tmp/weekly_categories.json"
  echo ""
  echo "移除 --dry-run 參數以實際填寫。"
  exit 0
fi

if [ "${NO_BROWSER}" = true ]; then
  echo "[NO BROWSER] 內容已寫入: /tmp/weekly_categories.json"
  echo ""
  echo "你可以手動執行:"
  echo "  playwright-cli open '${REPORT_URL}'"
  echo "  playwright-cli run-code --filename=${SCRIPT_DIR}/fill-form.js"
  exit 0
fi

# === Step 4: 用 Playwright 填寫表單 ===
echo "[4/4] 正在用 Playwright 填寫表單..."

export REPORT_EMAIL REPORT_DEPT REPORT_NAME CATEGORIES

playwright-cli open "${REPORT_URL}"
sleep 5

playwright-cli run-code --filename="${SCRIPT_DIR}/fill-form.js"

echo ""
echo "============================================"
echo "  週報填寫完成！"
echo "============================================"
echo "請在瀏覽器中確認內容是否正確。"
echo "系統會自動儲存，不需手動提交。"
echo ""
echo "完成後可執行: playwright-cli close"
