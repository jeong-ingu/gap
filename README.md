# 단지 갭 비교 (매물갭 vs 실거래갭)

여러 아파트 단지의 **매물 갭**(매매 중간값 − 전세 중간값)과 **실거래 갭**(최근 매매 실거래 − 최근 전세 실거래·갱신제외)을
비교해, 두 갭의 차이가 작은 단지를 상단에 보여주는 대시보드입니다.

- 정적 페이지: [`index.html`](index.html) — 데이터는 `gap-data.js`(`window.GAP`)에서 읽음
- 수집기: [`gap-scrape.mjs`](gap-scrape.mjs) — 네이버 부동산(fin.land) 내부 API에서 매물·실거래·단지정보 수집

## 기능
- 동네 그룹별 표 + 갭 근접 TOP
- 전용 59·75·84㎡(25/30/34평)만, 평형 필터 버튼
- 매물갭/실거래갭/차이 컬럼 정렬
- 아파트 이름 클릭 → 단지 정보 모달(준공연도·세대수·최근접역/도보) + 네이버 부동산 링크

## 데이터 갱신
```bash
npm install            # playwright-core
node gap-scrape.mjs    # gap-data.js / gap-data.json 재생성
```
※ 수집 시 시스템에 설치된 Microsoft Edge를 사용합니다(네이버의 봇 차단 우회).

## GitHub Pages
`main` 브랜치 루트를 소스로 배포하면 `https://<계정>.github.io/gap/` 에서 열립니다.
