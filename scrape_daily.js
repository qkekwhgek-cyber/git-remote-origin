/**
 * 데일리 리포트 전체 수집기
 * 실행: node scrape_daily.js
 * - AI 동향 / 브랜딩·디자인 / 마케팅·퍼널: Google News RSS (2주 이내 필터)
 * - @choi.openai 스레드: Playwright 브라우저 자동화
 * - 완성된 리포트 → Git push → GitHub Actions 이메일 발송
 */

const https = require('https');
const http = require('http');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 설정 ──────────────────────────────────────────────────────────
const MAX_NEWS_PER_CATEGORY = 8;
const MAX_THREADS = 10;
const DEDUP_LOOKBACK_DAYS = 3;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const REPORTS_DIR = path.join(__dirname, 'daily-reports');
const THREADS_USER = 'choi.openai';

// 카테고리별 검색 쿼리 — 분야 소식·출시·인사이트 중심
const NEWS_CATEGORIES = [
  {
    key: 'ai',
    emoji: '🤖',
    name: 'AI 동향',
    queries: [
      'Claude Anthropic 발표 출시',
      'ChatGPT OpenAI 신기능 업데이트',
      'AI LLM 에이전트 서비스 출시',
    ],
  },
  {
    key: 'brand',
    emoji: '🎨',
    name: '브랜딩·디자인',
    queries: [
      '브랜딩 전략 디자인 인사이트',
      'AI 디자인 창작 도구 출시',
      'brand design trends news 2026',
    ],
  },
  {
    key: 'marketing',
    emoji: '📊',
    name: '마케팅·퍼널',
    queries: [
      '광고 퍼포먼스 마케팅 전략',
      'SEO AI 검색 마케팅 인사이트',
      '디지털마케팅 전략 뉴스',
    ],
  },
];

// ── 날짜 유틸 ─────────────────────────────────────────────────────
function getTodayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getTwoWeeksAgo() {
  return new Date(Date.now() - TWO_WEEKS_MS);
}

// ── RSS 수집 ──────────────────────────────────────────────────────
function fetchUrl(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { clearTimeout(timer); resolve({ data, statusCode: res.statusCode, headers: res.headers }); });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}


function parseRSSItems(xml) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const c = m[1];
    const title = (c.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
      || c.match(/<title>(.*?)<\/title>/)?.[1] || '').trim();
    const link = (c.match(/<link>(.*?)<\/link>/)?.[1] || '').trim();
    const pubDate = new Date((c.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '').trim());
    const source = (c.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '').trim();
    if (title && link && !isNaN(pubDate)) {
      items.push({ title, link, pubDate, source });
    }
  }
  return items;
}

async function fetchCategoryNews(category, knownTitles) {
  const twoWeeksAgo = getTwoWeeksAgo();
  const allItems = [];
  const seenTitles = new Set();

  for (const query of category.queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
    try {
      const { data } = await fetchUrl(url);
      const items = parseRSSItems(data);
      for (const item of items) {
        if (item.pubDate < twoWeeksAgo) continue;
        const cleanTitle = item.title.replace(/\s+-\s+[^-]+$/, '').trim();
        if (seenTitles.has(cleanTitle)) continue;
        if (knownTitles.has(cleanTitle.toLowerCase())) continue;
        seenTitles.add(cleanTitle);
        allItems.push({ ...item, cleanTitle });
      }
    } catch (e) {
      console.warn(`  [RSS 오류] "${query}": ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  allItems.sort((a, b) => b.pubDate - a.pubDate);
  return allItems.slice(0, MAX_NEWS_PER_CATEGORY);
}

// ── Threads 수집 (Playwright) ──────────────────────────────────────
function extractUrlsFromFile(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const text = fs.readFileSync(filePath, 'utf-8');
  const matches = text.matchAll(/https:\/\/www\.threads\.[a-z]+\/@[^\s/]+\/post\/[^\s)\n"]+/g);
  return new Set([...matches].map(m => m[0].split('?')[0]));
}

function extractNewsTitlesFromFile(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const text = fs.readFileSync(filePath, 'utf-8');
  const titles = new Set();
  // 형식: "1. 제목 (출처) (날짜) — [기사보기](URL)"
  for (const m of text.matchAll(/^\d+\.\s+(.+?)\s+\([^)]*\)\s+\([\d-]+\)\s+—/gm)) {
    titles.add(m[1].trim().toLowerCase());
  }
  return titles;
}

function collectKnownNewsTitles() {
  const known = new Set();
  if (!fs.existsSync(REPORTS_DIR)) return known;
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .slice(-DEDUP_LOOKBACK_DAYS);
  for (const f of files) {
    extractNewsTitlesFromFile(path.join(REPORTS_DIR, f)).forEach(t => known.add(t));
  }
  console.log(`  [뉴스 중복제거] 최근 ${files.length}일치에서 ${known.size}개 제목 로드`);
  return known;
}

function collectKnownThreadUrls() {
  const known = new Set();
  if (!fs.existsSync(REPORTS_DIR)) return known;
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .slice(-DEDUP_LOOKBACK_DAYS);
  for (const f of files) {
    extractUrlsFromFile(path.join(REPORTS_DIR, f)).forEach(u => known.add(u));
  }
  const expanded = new Set(known);
  known.forEach(u => {
    expanded.add(u.replace('threads.com', 'threads.net'));
    expanded.add(u.replace('threads.net', 'threads.com'));
  });
  console.log(`  [스레드 중복제거] 최근 ${files.length}일치에서 ${expanded.size}개 URL 로드`);
  return expanded;
}

async function scrapeThreads() {
  console.log(`\n[📱 스레드] https://www.threads.net/@${THREADS_USER} 수집 중...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const posts = [];

  try {
    const res = await page.goto(`https://www.threads.net/@${THREADS_USER}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    console.log(`  HTTP ${res?.status()} → ${page.url()}`);

    if (page.url().includes('/login')) {
      console.warn('  [경고] 로그인 리다이렉트 감지됨');
      return posts;
    }

    await page.waitForTimeout(6000);

    const extracted = await page.evaluate((targetUser) => {
      const results = [];
      const seen = new Set();
      const NOISE = new Set(['팔로우', '답글', '리포스트', '좋아요', '공유', '더보기', targetUser, 'choi.openai']);

      const postLinks = Array.from(document.querySelectorAll(`a[href*="/@${targetUser}/post/"]`))
        .filter(a => !a.href.includes('/media') && !a.href.includes('/repost'));

      for (const link of postLinks) {
        const href = link.href.split('?')[0];
        if (seen.has(href)) continue;
        seen.add(href);

        let container = link;
        let pressable = null;
        for (let i = 0; i < 20; i++) {
          container = container.parentElement;
          if (!container) break;
          if (container.getAttribute('data-pressable-container') !== null) { pressable = container; break; }
        }

        const timeEl = pressable?.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || '';

        const texts = Array.from((pressable || link.parentElement).querySelectorAll('span, div'))
          .filter(el => {
            const t = el.innerText?.trim();
            if (!t || t.length < 10) return false;
            if (NOISE.has(t)) return false;
            if (/^\d+[분시일주개년]/.test(t)) return false;
            if (/^[\d,]+$/.test(t)) return false;
            return el.querySelectorAll('span, div').length === 0 && el.children.length === 0;
          })
          .map(el => el.innerText.trim());

        results.push({ url: href, content: texts.join(' ').trim(), timestamp });
      }
      return results;
    }, THREADS_USER);

    posts.push(...extracted);
    console.log(`  ${posts.length}개 게시글 추출`);
  } catch (e) {
    console.error(`  [오류] ${e.message}`);
  } finally {
    await browser.close();
  }
  return posts;
}

// ── 리포트 생성 ───────────────────────────────────────────────────
function buildNewsSection(category, items) {
  if (items.length === 0) return `## ${category.emoji} ${category.name}\n\n(최신 기사 없음)\n`;
  const lines = items.map((item, i) => {
    const dateStr = item.pubDate.toISOString().slice(0, 10);
    const source = item.source ? ` (${item.source})` : '';
    return `${i + 1}. ${item.cleanTitle}${source} (${dateStr}) — [기사보기](${item.link})`;
  });
  return `## ${category.emoji} ${category.name}\n\n${lines.join('\n')}\n`;
}

function buildThreadsSection(posts) {
  if (posts.length === 0) return `## 📱 @choi.openai 오늘의 스레드\n\n(새 게시글 없음)\n`;
  const lines = posts.map((p, i) => {
    const text = p.content.replace(/\s+/g, ' ').trim().slice(0, 300);
    return `${i + 1}. ${text} — [스레드보기](${p.url})`;
  });
  return `## 📱 @choi.openai 오늘의 스레드\n\n${lines.join('\n')}\n`;
}

function buildReport(today, newsSections, threadPosts) {
  const header = `# AI·브랜딩 트렌드 데일리 리포트\n**날짜:** ${today} | **수집 기준:** 최근 2주 이내 자료만 포함\n\n---\n\n`;
  const sections = newsSections.join('\n---\n\n') + '\n---\n\n' + buildThreadsSection(threadPosts);
  return header + sections;
}

function writeReport(today, content) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = path.join(REPORTS_DIR, `${today}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`\n[파일] ${filePath}`);
  return filePath;
}

function gitPush(today) {
  const relPath = `daily-reports/${today}.md`;
  try {
    execSync(`git -C "${__dirname}" add "${relPath}"`, { stdio: 'pipe' });
    execSync(`git -C "${__dirname}" commit -m "daily report ${today}: 전체 수집 (뉴스 + threads)"`, { stdio: 'pipe' });
    execSync(`git -C "${__dirname}" push origin main`, { stdio: 'inherit' });
    console.log('[Git] push 완료 → GitHub Actions 이메일 발송 트리거됨');
  } catch (e) {
    const msg = e.stderr?.toString() || e.message || '';
    if (msg.includes('nothing to commit')) {
      console.log('[Git] 변경사항 없음');
    } else {
      console.error(`[Git 오류] ${msg.slice(0, 300)}`);
    }
  }
}

// ── 메인 ──────────────────────────────────────────────────────────
async function main() {
  const today = getTodayKST();
  console.log(`\n====== 데일리 리포트 전체 수집 (${today}) ======`);

  // 1. 뉴스 카테고리 수집 (RSS)
  const knownNewsTitles = collectKnownNewsTitles();
  const newsSections = [];
  for (const category of NEWS_CATEGORIES) {
    console.log(`\n[${category.emoji} ${category.name}] RSS 수집 중...`);
    const items = await fetchCategoryNews(category, knownNewsTitles);
    console.log(`  → ${items.length}개 최신 기사 (2주 이내, 중복 제외)`);
    items.slice(0, 3).forEach(i => console.log(`     [${i.pubDate.toISOString().slice(0, 10)}] ${i.cleanTitle.slice(0, 60)}`));
    newsSections.push(buildNewsSection(category, items));
  }

  // 2. Threads 수집 (Playwright)
  const knownUrls = collectKnownThreadUrls();
  const allPosts = await scrapeThreads();
  const newPosts = allPosts.filter(p => p.content.length > 0 && !knownUrls.has(p.url)).slice(0, MAX_THREADS);
  console.log(`  → 신규 ${newPosts.length}개 (전체 ${allPosts.length}개)`);

  // 3. 리포트 작성
  const content = buildReport(today, newsSections, newPosts);
  writeReport(today, content);

  // 4. Git push
  gitPush(today);
}

main().catch(e => { console.error(`[치명적 오류] ${e.message}`); process.exit(1); });
