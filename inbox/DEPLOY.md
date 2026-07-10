# Inbox 배포 런북 (M0.5)

이 문서만 따라 하면 실서비스가 뜬다. 소요 ~40분. 코드는 전부 준비돼 있고,
아래 단계들은 **계정 자격증명이 필요해서 운영자만 할 수 있는 부분**이다.

## 0. 준비물

- GitHub 저장소 (이 코드)
- 이메일 주소 (각 서비스 가입용)
- 커스텀 도메인 1개 (다이제스트 메일 발신에 필요; 앱 자체는 `*.pages.dev`로도 동작)

## 1. Supabase (~10분)

1. [supabase.com](https://supabase.com) → New project (Free 플랜).
2. SQL Editor → New query → `supabase/schema.sql` 전체 붙여넣고 **Run**.
   - 스크립트는 멱등(idempotent)이라 업그레이드 때도 같은 파일을 다시 실행하면 된다.
   - `hnsw.iterative_scan`은 pgvector 0.8+ 필요 — 현재 Supabase 기본 제공.
3. Authentication → Providers → Email: **Enable email OTP/magic link** 확인.
4. Settings → API에서 복사:
   - `Project URL` → config.js `SUPABASE_URL`
   - `anon public` 키 → config.js `SUPABASE_ANON_KEY` (RLS로 공개 안전)
   - `service_role` 키 → **워커 시크릿 전용. 절대 클라이언트에 넣지 말 것.**

## 2. 클라이언트 설정 (~2분)

```bash
cd inbox
cp config.example.js config.js   # git-ignored
# SUPABASE_URL, SUPABASE_ANON_KEY 채우기
# FREE_SAVES_PER_MONTH: 30, FREE_ASKS_PER_MONTH: 10 (기본 권장)
```

> **업그레이드 주의**: config.js는 git-ignored라 pull로 갱신되지 않는다.
> 릴리스 노트에 새 config 키가 있으면 손으로 추가할 것. 키가 없으면 해당
> 미터링은 무제한으로 동작한다 (기능이 벽돌화되지는 않음 — 코드에서 보장).

## 3. Cloudflare Pages (~5분)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git.
2. 저장소 선택, **Build settings**: Framework preset `None`, Build command 없음,
   Build output directory: `inbox`.
3. `config.js`는 git-ignored이므로 둘 중 하나:
   - (간단) 배포 브랜치에만 config.js를 커밋하는 별도 브랜치 운용, 또는
   - (권장) Pages 빌드 커맨드로 생성:
     `echo "window.INBOX_CONFIG={SUPABASE_URL:'$SB_URL',SUPABASE_ANON_KEY:'$SB_ANON',FREE_SAVES_PER_MONTH:30,FREE_ASKS_PER_MONTH:10,JINA_READER:'https://r.jina.ai/',STRIPE_PAYMENT_LINK:'$STRIPE_LINK'}" > inbox/config.js`
     — 값은 Pages 환경변수(`SB_URL`, `SB_ANON`, `STRIPE_LINK`)로 주입.
4. 배포 후 `https://<project>.pages.dev` 접속 → 매직링크 로그인 → 저장 1건 테스트.
5. Supabase → Authentication → URL Configuration → Site URL에 배포 URL 등록
   (매직링크 리다이렉트용).

## 4. Resend + 다이제스트 워커 (~10분)

1. [resend.com](https://resend.com) 가입 → Domains → 커스텀 도메인 추가 → 안내대로
   DNS(SPF/DKIM) 레코드 등록 → verified 될 때까지 대기.
2. API Keys → 키 생성.
3. `workers/digest.js`의 발신 주소 `digest@yourdomain.com`을 검증된 도메인으로 수정.
4. 배포:
   ```bash
   cd inbox/workers
   npx wrangler login
   npx wrangler secret put SUPABASE_URL          # https://xxx.supabase.co
   npx wrangler secret put SUPABASE_SERVICE_KEY  # service_role 키
   npx wrangler secret put RESEND_API_KEY
   npx wrangler deploy
   ```
5. 수동 테스트: `curl https://inbox-digest.<account>.workers.dev/run`
   → `Sent N digests (0 failed)` 확인. 크론(월 14:00 UTC)은 wrangler.toml에 설정돼 있음.

## 5. Stripe (Pro 결제, ~10분)

1. [stripe.com](https://stripe.com) → Products → **Payment Link** 생성
   (Pro 구독 $4/월). 링크 URL을 config의 `STRIPE_PAYMENT_LINK`에.
2. 결제 완료 → `is_pro` 반영은 초기엔 수동으로 충분:
   Supabase SQL Editor에서
   ```sql
   update public.profiles set is_pro = true
   where user_id = (select id from auth.users where email = '<결제자 이메일>');
   ```
3. 자동화(볼륨 생기면): Stripe webhook → Cloudflare Worker에서
   `checkout.session.completed` 수신 → service key로 위 UPDATE 실행.
   (프로필 테이블·클라이언트 코드는 이미 대응돼 있어 워커 하나만 추가하면 됨.)

## 6. 계측 (PostHog, ~3분)

`index.html`의 `</head>` 직전에 PostHog 스니펫 삽입
([posthog.com](https://posthog.com) 가입 → 프로젝트 생성 → 스니펫 복사).
추적할 핵심 이벤트는 자동 pageview 외에 PLAN.md의 KPI 정의를 따른다
(노스스타: 주간 검색 성공 사용자).

## 7. 런칭 체크리스트

- [ ] 매직링크 로그인 왕복 (배포 도메인에서)
- [ ] 저장 → 요약·태그 생성 → 의미 검색 왕복
- [ ] Ask-your-inbox 인용 답변
- [ ] 월 한도 도달 시 페이월 + Stripe 링크 열림
- [ ] `/run`으로 다이제스트 발송 확인 (스팸함 체크)
- [ ] 공개 컬렉션 공유 링크가 비로그인 브라우저에서 열림
- [ ] iOS/Android 홈 화면 추가 → 공유 시트에 Inbox 노출

## 비용 요약

| 구성요소 | 플랜 | 월 비용 |
|---|---|---|
| Supabase | Free (500MB, 5만 MAU) | $0 |
| Cloudflare Pages/Workers | Free | $0 |
| Resend | Free (3,000통/월) | $0 |
| 도메인 | — | ~$1 |
| **합계** | | **~$1/월** |
