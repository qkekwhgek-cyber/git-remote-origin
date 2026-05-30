/**
 * @choi.openai Threads 최신글 수집기
 * 실행: node scrape_threads.js
 * 효과: daily-reports/YYYY-MM-DD.md 생성/업데이트 → git push → GitHub Actions 이메일 발송
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = {
  targetUser: 'choi.openai',
  profileUrl: 'https://www.threads.net/@choi.openai',
  reportsDir: path.join(__dirname, 'daily-reports'),
  maxPosts: 10,
  deduLookbackDays: 3,
};

function getTodayKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 리포트 파일에서 Threads 포스트 URL 추출 (중복 방지용)
function extractUrlsFromFile(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const text = fs.readFileSync(filePath, 'utf-8');
  // threads.net 과 threads.com 모두 매칭
  const matches = text.matchAll(/https:\/\/www\.threads\.[a-z]+\/@[^\s/]+\/post\/[^\s)\n"]+/g);
  return new Set([...matches].map(m => m[0].split('?')[0]));
}

function collectKnownUrls() {
  const known = new Set();
  if (!fs.existsSync(CONFIG.reportsDir)) return known;

  const files = fs.readdirSync(CONFIG.reportsDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .slice(-CONFIG.deduLookbackDays);

  for (const f of files) {
    extractUrlsFromFile(path.join(CONFIG.reportsDir, f)).forEach(u => known.add(u));
  }

  // threads.net ↔ threads.com 양방향 추가 (도메인 변경 대응)
  const expanded = new Set(known);
  known.forEach(u => {
    expanded.add(u.replace('threads.com', 'threads.net'));
    expanded.add(u.replace('threads.net', 'threads.com'));
  });

  console.log(`[중복제거] 최근 ${files.length}일치에서 ${expanded.size}개 URL 로드`);
  return expanded;
}

async function scrapeThreads() {
  console.log(`[스크래핑] ${CONFIG.profileUrl} 접속 중...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const posts = [];

  try {
    const response = await page.goto(CONFIG.profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log(`[스크래핑] HTTP ${response?.status()} → ${page.url()}`);

    if (page.url().includes('/login') || page.url().includes('/accounts/login')) {
      console.warn('[경고] 로그인 리다이렉트 감지됨');
      return posts;
    }

    // 렌더링 완료 대기 (React SPA는 JS 실행 후 DOM 완성)
    await page.waitForTimeout(6000);

    const extracted = await page.evaluate((targetUser) => {
      const results = [];
      const seen = new Set();

      const postLinks = Array.from(
        document.querySelectorAll(`a[href*="/@${targetUser}/post/"]`)
      ).filter(a => !a.href.includes('/media') && !a.href.includes('/repost'));

      for (const link of postLinks) {
        const href = link.href.split('?')[0];
        if (seen.has(href)) continue;
        seen.add(href);

        // data-pressable-container 부모 찾기
        let container = link;
        let pressableContainer = null;
        for (let i = 0; i < 20; i++) {
          container = container.parentElement;
          if (!container) break;
          if (container.getAttribute('data-pressable-container') !== null) {
            pressableContainer = container;
            break;
          }
        }

        const timeEl = pressableContainer?.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || '';

        // 리프 노드 텍스트만 수집 (노이즈 필터)
        const NOISE = new Set(['팔로우', '답글', '리포스트', '좋아요', '공유', '더보기', targetUser, 'choi.openai']);
        const texts = Array.from(
          (pressableContainer || link.parentElement).querySelectorAll('span, div')
        )
          .filter(el => {
            const t = el.innerText?.trim();
            if (!t || t.length < 10) return false;
            if (NOISE.has(t)) return false;
            if (/^\d+[분시일주개년]/.test(t)) return false;
            if (/^[\d,]+$/.test(t)) return false;
            return el.querySelectorAll('span, div').length === 0 && el.children.length === 0;
          })
          .map(el => el.innerText.trim());

        const content = texts.join(' ').trim();
        results.push({ url: href, content, timestamp });
      }

      return results;
    }, CONFIG.targetUser);

    posts.push(...extracted);
    console.log(`[스크래핑] ${posts.length}개 게시글 추출`);

  } catch (err) {
    console.error(`[오류] ${err.message}`);
  } finally {
    await browser.close();
  }

  return posts;
}

function buildThreadsSection(posts) {
  if (posts.length === 0) {
    return `## 📱 @choi.openai 오늘의 스레드\n\n(새 게시글 없음)\n`;
  }
  const lines = posts.map((p, i) => {
    const text = p.content.replace(/\s+/g, ' ').trim().slice(0, 300);
    return `${i + 1}. ${text} — ${p.url}`;
  });
  return `## 📱 @choi.openai 오늘의 스레드\n\n${lines.join('\n')}\n`;
}

function updateReportFile(reportPath, today, newPosts) {
  const SECTION_HEADER = '## 📱 @choi.openai 오늘의 스레드';
  const newSection = buildThreadsSection(newPosts);

  if (fs.existsSync(reportPath)) {
    const existing = fs.readFileSync(reportPath, 'utf-8');
    const idx = existing.indexOf(SECTION_HEADER);
    const updated = idx !== -1
      ? existing.slice(0, idx) + newSection
      : existing.trimEnd() + '\n\n---\n\n' + newSection + '\n';
    fs.writeFileSync(reportPath, updated, 'utf-8');
  } else {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateStr = kst.toISOString().slice(0, 10);
    const content = `# 📰 AI·브랜딩 트렌드 데일리 리포트\n\n**발행일:** ${dateStr} (KST)\n**수집 기준:** 최근 2주 이내 자료만 포함\n\n---\n\n${newSection}`;
    fs.writeFileSync(reportPath, content, 'utf-8');
  }
}

function gitPush(today) {
  const relPath = `daily-reports/${today}.md`;
  try {
    execSync(`git -C "${__dirname}" add "${relPath}"`, { stdio: 'pipe' });
    execSync(
      `git -C "${__dirname}" commit -m "daily report ${today}: @choi.openai threads 수집"`,
      { stdio: 'pipe' }
    );
    execSync(`git -C "${__dirname}" push origin main`, { stdio: 'inherit' });
    console.log('[Git] push 완료 → GitHub Actions 이메일 발송 트리거됨');
  } catch (err) {
    const msg = err.stderr?.toString() || err.message || '';
    if (msg.includes('nothing to commit')) {
      console.log('[Git] 변경사항 없음');
    } else {
      console.error(`[Git 오류] ${msg.slice(0, 200)}`);
    }
  }
}

async function main() {
  const today = getTodayKST();
  const reportPath = path.join(CONFIG.reportsDir, `${today}.md`);

  console.log(`\n====== @choi.openai 스레드 수집 (${today}) ======`);

  const knownUrls = collectKnownUrls();
  const allPosts = await scrapeThreads();

  const newPosts = allPosts
    .filter(p => p.content.length > 0 && !knownUrls.has(p.url))
    .slice(0, CONFIG.maxPosts);

  console.log(`[결과] 전체 ${allPosts.length}개 → 신규 ${newPosts.length}개`);

  if (allPosts.length === 0) {
    console.log('[실패] 게시글 수집 실패. 수동 확인 필요.');
    return;
  }
  if (newPosts.length === 0) {
    console.log('[완료] 모두 기존에 수집된 게시글입니다.');
    return;
  }

  // 미리보기
  console.log('\n--- 수집 미리보기 ---');
  newPosts.forEach((p, i) => {
    console.log(`${i + 1}. [${p.timestamp.slice(0, 10)}] ${p.content.slice(0, 80)}...`);
  });
  console.log('---\n');

  updateReportFile(reportPath, today, newPosts);
  console.log(`[파일] ${reportPath}`);

  gitPush(today);
}

main().catch(err => {
  console.error(`[치명적 오류] ${err.message}`);
  process.exit(1);
});
