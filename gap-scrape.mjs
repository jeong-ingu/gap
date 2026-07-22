// 여러 단지 매물갭 vs 실거래갭 수집기
// 실행: node gap-scrape.mjs
// 각 단지 지도 페이지 진입(세션 확보) 후 in-page fetch 로:
//   - pyeongList(평형)  - article/list A1·B1(매물 범위)  - pyeong/realPrice/list A1·B1(실거래)
// 매물갭 = median(매매) - median(전세),  실거래갭 = 최근매매 - 최근전세(갱신제외)
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 단지 목록 (naver.me → complexId 해석 결과). 동네 그룹별.
const GROUPS = {
  '신검단중앙': ['146059','148541','151666','148117','156458','153397','167518'],
  '아라역':     ['124846','124978','124847','124980','128035','162339','167537'],
  '안양 만안구': ['112054','147880','9223','3092'],
  '금정':       ['121277','101283'],
  '사직':       ['107577','107994','136343'],
};
// 단지 지도 URL (해석된 것). complexId → url
const URLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'gap-complexes.json'), 'utf8'));

const OUT_JSON = path.join(__dirname, 'gap-data.json');
const OUT_JS = path.join(__dirname, 'gap-data.js');

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pyeong = (supply) => Math.round(supply / 3.3058);

// 날짜 범위: 실거래 최근 3개월
function dateRange() {
  const end = new Date();
  const start = new Date(end); start.setMonth(start.getMonth() - 3);
  const f = (d) => d.toISOString().slice(0, 10);
  return { startDate: f(start), endDate: f(end) };
}

// 페이지 컨텍스트에서 한 단지의 원시 데이터 수집
async function collectComplex(page, cid, dr) {
  return await page.evaluate(async ({ cid, dr }) => {
    const gj = async (url) => { try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); return await r.json(); } catch { return null; } };
    const pj = async (url, body) => { try { const r = await fetch(url, { method: 'post', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }); return await r.json(); } catch { return null; } };
    const B = '/front-api/v1';

    // 평형
    const pl = await gj(`${B}/complex/pyeongList?complexNumber=${cid}`);
    const pyeongs = (pl?.result || []).map(x => ({ number: x.number, name: x.name, supply: x.supplyArea, excl: x.exclusiveArea }));

    // 매물 (페이지네이션)
    const fetchArticles = async (tradeType) => {
      const items = []; let lastInfo = [];
      for (let i = 0; i < 6; i++) {
        const j = await pj(`${B}/complex/article/list`, { complexNumber: cid, userChannelType: 'PC', tradeTypes: [tradeType], size: 30, articleSortType: 'PRICE_ASC', lastInfo });
        const r = j?.result; if (!r) break;
        for (const it of (r.list || [])) {
          const rep = it.representativeArticleInfo;
          const dup = it.duplicatedArticleInfo?.articleInfoList;
          const arr = (dup && dup.length) ? dup : [rep];
          for (const a of arr) if (a) items.push({ excl: a.spaceInfo?.exclusiveSpace, price: a.priceInfo?.dealPrice || a.priceInfo?.warrantyPrice || 0, name: rep?.complexName });
        }
        if (!r.hasNextPage) break; lastInfo = r.lastInfo ?? [];
      }
      return items;
    };
    const artA1 = await fetchArticles('A1');
    const artB1 = await fetchArticles('B1');

    // 단지 기본정보 (준공/세대수/동수/좌표) + 최근접역
    const summary = (await gj(`${B}/complex/mapComplexSummaryInfo?complexNumber=${cid}`))?.result?.complexInfo || null;
    let tr = (await gj(`${B}/article/transport?itemType=complex&itemId=${cid}`))?.result;
    if (!tr?.subwayList?.length) {
      const one = await pj(`${B}/complex/article/list`, { complexNumber: cid, userChannelType: 'PC', tradeTypes: ['A1'], size: 1, articleSortType: 'RANKING_DESC', lastInfo: [] });
      const an = one?.result?.list?.[0]?.representativeArticleInfo?.articleNumber;
      if (an) tr = (await gj(`${B}/article/transport?itemType=article&itemId=${an}`))?.result;
    }
    let station = null;
    for (const s of (tr?.subwayList || [])) for (const t of (s.typeList || []))
      if (t.walkingDistance != null && (!station || t.walkingDistance < station.walkDist))
        station = { name: s.stationName, line: t.name, walkMin: t.walkingDuration, walkDist: t.walkingDistance };
    const info = {
      approvalDate: summary?.useApprovalDate || null,
      approvalYear: summary?.useApprovalDate ? summary.useApprovalDate.slice(0, 4) : null,
      elapsedYear: summary?.approvalElapsedYear ?? null,
      households: summary?.totalHouseholdNumber ?? null,
      buildings: summary?.buildingCount ?? null,
      address: summary?.address ? [summary.address.city, summary.address.division, summary.address.sector, summary.address.roadName].filter(Boolean).join(' ') : null,
      station,
    };
    const complexName = summary?.name || artA1.find(x => x.name)?.name || artB1.find(x => x.name)?.name || null;

    // 실거래 (평형별 A1·B1)
    const real = {};
    for (const pt of pyeongs) {
      const q = `complexNumber=${cid}&pyeongTypeNumber=${pt.number}&realEstateType=A01&startDate=${dr.startDate}&endDate=${dr.endDate}`;
      const a = await gj(`${B}/complex/pyeong/realPrice/list?${q}&tradeType=A1`);
      const b = await gj(`${B}/complex/pyeong/realPrice/list?${q}&tradeType=B1`);
      const toArr = (j) => Array.isArray(j?.result) ? j.result : (j?.result ? Object.values(j.result) : []);
      real[pt.number] = { A1: toArr(a), B1: toArr(b) };
    }
    return { complexName, info, pyeongs, artA1, artB1, real };
  }, { cid, dr });
}

// 전용면적 → 타깃 버킷. 59(전용~59), 75(전용74~76, 29·30평), 84(전용84~85, 33·34·35평)
const AREAKEY = (e) => e == null ? null : (e >= 56 && e < 63 ? 59 : e >= 73 && e < 79 ? 75 : e >= 80 && e < 88 ? 84 : null);
const AREALABEL = { 59: '25평', 75: '30평', 84: '34평' };

function buildRows(cid, raw) {
  // 각 매물을 가장 가까운 평형타입에 1:1 배정 (중복 방지)
  const assign = (list) => list.map(x => {
    if (x.excl == null) return null;
    let best = null, bd = 1e9;
    for (const pt of raw.pyeongs) { const d = Math.abs(pt.excl - x.excl); if (d < bd) { bd = d; best = pt; } }
    return (best && bd < 2.0) ? { ptNum: best.number, price: x.price } : null;
  }).filter(Boolean);
  const aA1 = assign(raw.artA1), aB1 = assign(raw.artB1);

  // 평형타입을 전용면적 버킷(59/75/84)으로 묶기 — 그 외 면적은 제외
  const buckets = {};
  for (const pt of raw.pyeongs) {
    const k = AREAKEY(pt.excl); if (!k) continue;
    (buckets[k] = buckets[k] || { key: k, pts: [], excls: [] });
    buckets[k].pts.push(pt); buckets[k].excls.push(pt.excl);
  }

  const byDate = (a) => [...a].sort((x, y) => (y.tradeDate || '').localeCompare(x.tradeDate || ''));
  const rows = [];
  for (const k of [59, 75, 84]) {
    const b = buckets[k]; if (!b) continue;
    const ptSet = new Set(b.pts.map(p => p.number));
    const saleList = aA1.filter(x => ptSet.has(x.ptNum)).map(x => x.price).filter(Boolean);
    const leaseList = aB1.filter(x => ptSet.has(x.ptNum)).map(x => x.price).filter(Boolean);
    const tx = (tt) => b.pts.flatMap(p => (raw.real[p.number]?.[tt] || []));
    const salesTx = tx('A1').filter(t => !t.isDelete && t.dealPrice && t.propertyType === 'NORMAL');
    const leaseTx = tx('B1').filter(t => !t.isDelete && !t.isRenew && t.deposit && t.propertyType === 'NORMAL'); // 갱신 제외
    const recentSale = byDate(salesTx)[0] || null;
    const recentLease = byDate(leaseTx)[0] || null;

    const medSale = median(saleList), medLease = median(leaseList);
    const listingGap = (medSale != null && medLease != null) ? medSale - medLease : null;
    const realGap = (recentSale && recentLease) ? recentSale.dealPrice - recentLease.deposit : null;
    const diff = (listingGap != null && realGap != null) ? Math.abs(listingGap - realGap) : null;
    const exclAvg = Math.round(b.excls.reduce((s, v) => s + v, 0) / b.excls.length * 10) / 10;

    rows.push({
      complexId: cid, complexName: raw.complexName || cid,
      bucket: k, pyeongLabel: AREALABEL[k], exclusive: exclAvg,
      saleMin: saleList.length ? Math.min(...saleList) : null, saleMax: saleList.length ? Math.max(...saleList) : null,
      saleMed: medSale, saleCnt: saleList.length,
      leaseMin: leaseList.length ? Math.min(...leaseList) : null, leaseMax: leaseList.length ? Math.max(...leaseList) : null,
      leaseMed: medLease, leaseCnt: leaseList.length,
      realSale: recentSale ? { price: recentSale.dealPrice, date: recentSale.tradeDate } : null,
      realLease: recentLease ? { price: recentLease.deposit, date: recentLease.tradeDate } : null,
      listingGap, realGap, diff,
    });
  }
  return rows;
}

async function main() {
  const dr = dateRange();
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', locale: 'ko-KR', viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const result = { groups: {}, updatedAt: new Date().toISOString(), dateRange: dr };
  for (const [gname, ids] of Object.entries(GROUPS)) {
    result.groups[gname] = [];
    for (const cid of ids) {
      const url = URLS[cid];
      if (!url) { console.error('URL 없음:', cid); continue; }
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);
        const raw = await collectComplex(page, cid, dr);
        const rows = buildRows(cid, raw);
        result.groups[gname].push({ complexId: cid, complexName: raw.complexName || cid, info: raw.info, url, rows });
        const st = raw.info?.station;
        console.error(`[${gname}] ${cid} ${raw.complexName || ''} — 평형 ${rows.length}, 준공 ${raw.info?.approvalYear || '?'}, 세대 ${raw.info?.households || '?'}, 역 ${st ? st.name + ' ' + st.walkMin + '분' : '?'}`);
      } catch (e) {
        console.error(`[${gname}] ${cid} 실패:`, e.message);
        result.groups[gname].push({ complexId: cid, complexName: cid, rows: [], error: e.message });
      }
    }
  }
  await browser.close();
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  fs.writeFileSync(OUT_JS, 'window.GAP = ' + JSON.stringify(result) + ';\n');
  const total = Object.values(result.groups).flat().reduce((s, c) => s + c.rows.length, 0);
  console.error(`\n완료: 단지 ${Object.values(result.groups).flat().length}개, 평형행 ${total}개 → gap-data.json`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error('실패:', e.message); process.exit(1); });
}
