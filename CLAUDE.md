# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**doomify** — Spotify の曲を縦スワイプで聴き流すモバイル向け PWA。ログイン(PKCE)→ カード 0 でタップ → 以降はスワイプで曲が切り替わる。
Recommendations API が無い前提で、ユーザー自身のデータ + 隣接探索 + 検索からフィードを自前生成する。
並びは TikTok / Instagram Reels / X の For You と同じ骨格: 枠テンプレート → 名前付きフィルタ → 行動確率の重み付き和(価値モデル)→ 著者減衰などの再ランク → 温度付き抽選、
セッション内の滞在で即時に狭まる興味、未知アーティストの段階配信(1 枚 → 2 → 4 → 無制限)。

## Commands

```bash
npm run dev      # 127.0.0.1:5173 固定(Spotify の Redirect URI 完全一致のため。localhost は不可)
npm test         # Vitest(src/core のコロケーションテスト。React 非依存)
npm run lint     # oxlint
npm run build    # tsc -b && vite build(型チェック兼務)
npm run preview  # PWA/SW の動作確認
```

`.env` の `VITE_SPOTIFY_CLIENT_ID` が空だとログイン画面に設定案内が出る(PKCE なので公開値。シークレット無し)。

`http://127.0.0.1:5173/doomify/?demo=1` でログイン無しのデモモード(`src/demo.ts`: 偽 API + 偽 MusicBrainz/ListenBrainz(`testApi.ts` の `createFakeExternal`)+ 疑似再生。音は出ない。「Artist a6 が好きなら」のカードが出る)。`&delay=1500` を足すと偽 API の応答が遅れ、スケルトン → 最初のカード → 裏の補充の順序を目で確かめられる。
開発ビルドでは `window.__doomify.goTo(i)` / `scrollToIndex(i, 'instant')` / `snapshot()` で移動と再生状態を確認できる。

## Architecture

- **`src/core/`** — React 非依存の純 TS。全モジュールに `*.test.ts` を併設。外部(fetch / crypto / now / rng / storage)は注入
  - `auth/` PKCE(`pkce.ts`)、トークン永続化(`tokenStore.ts`)、`authManager.ts`(single-flight refresh、6 か月失効の予告、`invalid_grant` → 再ログイン)
  - `spotify/` `apiClient.ts`(優先度キュー playback>action>feed、同時 2・間隔 150ms。**playback は同時 +1 の専用枠で間隔免除**、間隔待ちの sleep も起こす。429 共通ゲート、401 強制更新 1 回、GET 短命キャッシュ)、
    `endpoints.ts`(2026-02 以降の開発モードで使えるエンドポイントだけ。**search / artistAlbums の limit 上限は 10**)、`types.ts`、`cache.ts`(idb-keyval + TTL ≤24h。`getEntry` は期限切れでも 24h 以内なら stale として返す)
  - `feed/` `feedEngine.ts`(種 → 3 バケットの候補プール → 枠テンプレート → 名前付きフィルタ → 価値モデル → 再ランク → 温度付き抽選 → items 追記専用。発見は既知アーティスト・保存済みを出さない。
    フィードバック → 報酬 → 学習。`exposures` で同じ訪問の離脱は 1 回だけ。「違う」はプールをパージし、active+3 より先の未表示キューをゼロコールで引き直す)、
    `sources.ts`(種: top/saved/recent/following/playlists。`startSeeds` で届いた順に集約へ合流、IDB キャッシュは期限切れでも 24h 以内なら stale で先に使い裏で再取得)、
    `expanders.ts`(deep_cut / appears_on / **similar_artist / bridge(2 ホップ)/ similar_track** / genre_search(タグ・年代の個人化)/ tag_new / tag_hipster)、
    `scheduler.ts`(予算内の補充計画・バンディットの重み・クールダウン中の除外・重複キー・アーティスト間隔)、
    `taste.ts`(既知アーティスト集合・年代プロファイル・候補スコア = 関連度の事前分布)、`reward.ts`(滞在・完走率(`startMs`/`positionMs` で一時停止を除く)・操作 → 連続値の報酬 r∈[-1,1]。`leaveOutcome` が完走/早期スキップ/not dwelled も返す)、
    `history.ts`(v3: seen 30 日・親和度・戦略統計・探索状態・避けるアーティスト・空振りタグ + 行動計数 4 階層・試験状態・セッション。v1/v2 から自動移行、キーは `doomify:history:v1` のまま)、
    `valueModel.ts`(行動 9 種の確率を グローバル → 戦略 → タグ → アーティスト の経験ベイズ(擬似計数 5)で推定し `EV = Σ w_a × P(a)`。重みは X の実値の読み替え(share 2.0 / less −8)、計数は半減期 14 日)、
    `session.ts`(無操作 30 分で区切るセッション。一瞥 3 秒を引いた滞在をタグ・アーティストに積み、12 枚で確信 1、`sessionBoost = exp(1.2 × 確信 × 興味)`。同日タグの減点は 10 枚まで無し → 0.9^k、下限 0.4)、
    `ranker.ts`(名前付きフィルタ 8 種 → `score = 関連度 × exp(1.5·EV) × 著者減衰((1−0.25)·0.5^n+0.25)× OON 0.75 × セッション × 同日 × 同タグ連続 0.5` → 温度付き抽選)、
    `pacing.ts`(枠 anchor / exploit / trial / wildcard の配分と位置(先頭は anchor)、試験の段階配信(結果待ち 1 枚 → 2 → 4 → ∞、負で 7 日停止)、Thompson 標本)、
    `bandit.ts`(戦略ごとの Beta Thompson sampling)、`exploration.ts`(手応え EMA でスライダー ±0.15、早期スキップ 4 連続で 6 枚クールダウン)、
    `identity.ts`(Spotify アーティスト/ISRC → MBID。曖昧なら url-rels の Spotify リンクで本人確認)、`enrichment.ts`(裏で MBID → 類似アーティスト・タグ・類似録音を集める直列キュー。供給をブロックしない)
  - `external/` `http.ts`(投げない fetchJson + 最小間隔・同時数・バックオフのスロットル)、`musicbrainz.ts`(1 req/s。名前検索 / url-rels+genres / ISRC)、`listenbrainz.ts`(Labs の類似アーティスト・類似録音は **POST の JSON 配列で複数 MBID を 1 回に**、タグは 25 件ずつ GET)。いずれも CORS 可・キー不要
  - `playback/` `controller.ts`(意図の集約: 意図が来たら即時発行、250ms 以内の連続は最新だけ間隔明けに(leading+trailing)、abort+seq、
    要求解決後に別曲の報告があれば 1.5s・無報告なら 3s で 1 回再送、自動送り判定、位置補間。snapshot に intentAt/issuedAt/resolvedAt/startedAt の計測値)、
    `sdkTarget.ts`(Web Playback SDK。`activate()` はタップ内で同期に)、`connectTarget.ts`(遠隔。可視中 10 秒ポーリング)
  - `snap.ts` スクロール幾何、`palette.ts` カバーからの配色、`env.ts` 端末判定、`format.ts`
- **`src/hooks/`** — `useAuth`(コールバック処理は module-level で 1 回だけ)、`useFeed`(engine と enrichment を同じ useMemo で生成)、`usePlayback`(target/controller の生成・破棄、失敗回数、visibilitychange 復帰)、
  `useActiveIndex`(意図 `onIntent` を先に通知: `scrollsnapchanging`(Chrome 129+)/ 無ければ scroll 中に最寄りが変わった瞬間 / `scrollToIndex` の呼び出し時。
  確定は `scrollend` + 幾何、無ければ scroll アイドル 150ms。確定が意図と食い違えば意図を出し直す。ResizeObserver で再整列)、`useSettings`、`useCoverPalette`、`useMediaSession`、`useKeyboardNav`
- **`src/components/`** — `FeedScreen`(配線の中心。離脱 → `markLeft`(滞在 `dwellMs`・`startMs`・`positionMs` 付き)、戻り → `markReturned`、いいね/プレイリスト/共有/開く/もっと/違う → `mark*`。
  画面が隠れる/閉じるときは現在カードの離脱を記録して `flush`)、`Feed`(殻は全部・中身は active ±2)、
  `CardShell`/`TrackCard`(理由ラベル + 「こういうのをもっと / これは違う」)/`CardActions`(保存 / プレイリストへ / 共有(Web Share API → リンクコピー)/ Spotify で開く)、`TapToStartGate`、`TopBar`、
  `DevicePicker`、`PlaylistPicker`、`SettingsSheet`(発見度・外部データのトグル・自動ジャンル・「発見の様子」診断: セッション・枠・反応率・試験・落とした候補)、`Modal`(`<dialog>`)、`Toast`、`UpdatePrompt`(SW は prompt 更新)、`SpotifyMark`(帰属)
- **`src/services.ts`** — auth / client / api / store / history / external(MusicBrainz・ListenBrainz クライアント)のシングルトン

## 設計上の約束

- **API 呼び出しは予算制**: 補充 1 回 ≤6 コール(`FEED_CONSTANTS.budgetPerRefill`。抽選した曲の保存済み判定 `libraryContains` 1 コールも含む)。レート制限中は known バケットのみ(ゼロコール)。ポーリングは Connect モードだけ。
  類似アーティストが届いた直後だけ、次の補充を待たずに 1 コール + 判定 1 コールで 2 枚先出しする(`topUpCards`)
- **発見は「知らない曲」に限る**: adjacent / discover の候補は主アーティストが既知集合(top/saved/recent/following/自分のプレイリスト)に無く、避けるアーティストでもなく、保存済みでもない曲だけ(deepcut は既知アーティストのアルバム深掘りなので例外)
- **学習は報酬で**: `reward.ts`(早期スキップ −1 の崖 / 3〜15 秒 −0.4 → −0.1 / 以降は完了率で −0.1 → 0.4(80%)→ 0.6 / 自動送り +0.6 / 鳴る前の離脱は滞在があれば −0.1 / いいね・プレイリスト・共有・もっと +1 / 開く +0.8 / 戻り +0.5 / 違う −1)。
  アーティスト・タグ・種・戦略(バンディット)・探索量(EMA、スライダーが錨)に加えて、価値モデルの行動計数とセッション興味に反映。「違う」はアーティストを 7 日避ける
- **ランキングは 3 社型の多目的期待値**: 候補ごとに `P(完走・保存・プレイリスト・開く・共有・戻り・もっと・早期スキップ・違う)` を推定し `EV = Σ w × P`。X 2026 の実値(Share 2.0、NotInterested を小標本向けに −8)。負の行動は正の 8 倍重い。
  `score = 関連度 × exp(1.5·EV) × 著者減衰 × OON 0.75 × セッション興味 × 同日減点 × 同タグ連続`。選択は枠ごとの温度付き抽選(anchor 0.4 / exploit 0.6 / trial 0.8 / wildcard 1.0)で argmax にはしない(可変報酬)
- **セッション内で即時に狭まる**: 滞在(一瞥 3 秒を引く)をタグ・アーティストに積み、カードが増えるほど強く効く(WSJ の実験: 視聴時間だけで 40 分〜2 時間でラビットホール)。候補を取りに行く段階(`similarArtist` の相手選び・ジャンル検索の重み)にも `tagBoost` で効かせる
- **未知アーティストは段階配信**: 表示 3 回未満のアーティストは trial 枠(バッチ 8 枚に 1 つ)で Thompson 標本により選び、結果待ちは 1 枚。正の結果で 2 → 4 → 無制限、負の結果で 7 日停止(プールからも落とす)
- **同じ訪問の離脱は 1 回だけ**: `exposures` が離脱と戻りを数え、画面が隠れたときの記録と実際の離脱を二重に数えない
- **「これは違う」は追記専用の唯一の例外**: プールをパージし、`lastActive + pruneAheadKeep(3)` より先(描画窓の外)の未表示カードを外して同数をゼロコールで引き直す。手前は不変なので scrollTop は動かない。`pruneAheadKeep: Infinity` で無効
- **外部データは任意で、供給をブロックしない**: `enrichment` は裏の直列キュー。失敗は「無し」。設定 `externalSources=false` なら 0 コール。結果(MBID・類似・タグ)は IDB に 30 日(`EXTERNAL_MAX_TTL_MS`)。Spotify のメタデータは従来どおり ≤24h
- **最初のカードは種 1 ソースで出す**: `bootstrap()` は曲を含む最初の種で解決し、items が空なら拡張(API)の応答を待たずにプールから `initialDraw` 枚を先に出す。
  残りの種・拡張は裏で合流(`seedsSettled()` で全確定を待てる)。種を待つ間は実カードと同寸のスケルトン(`Feed.tsx`)
- **再生要求は controller だけが出す**。意図(snap / 幾何 / `scrollToIndex`)→ `setActiveTrack` → 即時 `target.play`(スナップ完了を待たない)。UI から直接 `api.player.play` を呼ばない。
  開発ビルドでは `window.__doomify.timing()` / console の `[doomify] … intent→issued` で意図 → 要求 → 受理 → 発音の遅延を確認できる
- **自動再生制限**: 音を出す前に必ずユーザーのタップ(`TapToStartGate`)。`target.activate()` は await の前に同期で呼ぶ
- **document はスクロールさせない**(`.feed` が fixed の唯一のスクローラ)。`100vh/100dvh` は使わず `height:100%`
- **items は追記専用**(先頭削除は scrollTop ジャンプ)。上限 500 で「続きを読み込む」
- **Spotify ポリシー**: カバーアートは無加工(角丸のみ)、メタデータは提供どおり、常に「Spotify で開く」+ ロゴ。ビート同期演出・クロスフェード禁止。Spotify グリーンはロゴ/CTA のみ

## Gotchas

- `erasableSyntaxOnly` 有効 → クラスのパラメータプロパティ(`constructor(readonly x)`)は使えない
- `noUncheckedIndexedAccess` 有効 → 配列添字は `T | undefined`
- `ls` はこのマシンで `eza` にエイリアスされ非対話で固まることがある → スクリプトでは `/bin/ls`
- `npm install` が npm 10.9 の `edgesOut` バグで失敗する場合は `npx npm@latest install`
- Spotify の `artist.genres` は deprecated → 無い前提(`feed/genres.ts` の静的語彙 + 設定で選択)
- refresh 応答に `refresh_token` が無いことがある → 旧値を維持(`tokensFromResponse`)
- iOS で SDK が `autoplay_failed` → ゲートを再表示。2 回連続失敗で Connect を提案(`SUGGEST_CONNECT_AFTER`)
- Dark Reader 拡張が背景を `#181a1b` に塗り替えてカバー由来の配色を壊す → `index.html` の `darkreader-lock` メタで無効化(消さない)
- プログラムからのスムーズスクロールは、スナップ再整列と DOM 変化で中断される → `useActiveIndex.scrollToIndex` はスナップを一時的に外す。
  描画窓は active 基準のみ(pending で DOM を変えない)。Chrome はプログラムスクロールで `scrollend` を出さないので scroll アイドルでも確定する
- controller/target は `useMemo` で純粋に生成し、effect で `start()`/`stop()`(StrictMode の二重 effect で `dispose()` すると死ぬ)
- 自動化ブラウザのタブが非表示だと rAF が止まりスムーズスクロールが動かない(`document.visibilityState` を確認)
- MusicBrainz は 1 req/s(超過は 503)。ブラウザからは User-Agent を設定できないので既定のまま。ListenBrainz Labs の GET は 1 MBID しか受けず、複数は POST の `[{ artist_mbids: [...], algorithm }]`。`similar-recordings` はアルゴリズム名が別(`listenbrainz.ts` の定数)。`spotify-id-from-mbid` は 1 件ずつ
- ListenBrainz 本体の `metadata/lookup` / LB Radio / popularity はトークン必須なので使わない(`metadata/artist` のタグは不要)
- 類似データはニッチなアーティストで空になる(例: ボカロ P)→ `similar_artist` が不可のときは既存戦略へ自然に落ちる(`availability`)
- `history` の IDB キーは `doomify:history:v1` のまま中身が version 2(`migrateHistory` で v1 を読む)。テストで `record()` の旧 API も残している
- 開発ビルドでは `window.__doomify.feedStats()`(戦略の当たり率・実効発見度・外部データ・セッション・枠・フィルタ・試験・反応率)/ `items()`(理由・戦略・種・枠・EV・予測)/ `session()` でフィードの状態を確認できる
- 試験上限(段階配信)で当面出せない候補はプールに残る → `planRefill` には `drawablePoolSizes()`(いま出せる数)を渡す。プールの生数で不足を計算すると発見の取得が止まる。
  評価で恒久的に落ちた候補(既視・重複・避ける・既知・除外タグ)はその場でプールから捨てる(間隔・くじ引き連続・試験上限は一時的なので残す)
- `history` v3 は `actions`(行動計数)・`trials`・`session` を持つ。`migrateHistory` は v1/v2/v3 を受け、無いフィールドは既定値で埋める
- 抽選(`draw`)は乱数の消費順が学習状態で変わるので、seed 固定のテストは「何が出るか」ではなく性質(枠・間隔・比率)を検証する

## Deploy

- GitHub Pages(`.github/workflows/deploy.yml`: test → lint → build → deploy-pages)。`base: '/doomify/'`
- Redirect URI はアプリのルート(`${origin}${BASE_URL}`)。Dashboard 側は `http://127.0.0.1:5173/doomify/` と `https://satory074.github.io/doomify/`
- SW: `registerType: 'prompt'`(autoUpdate は再生中にリロードする)。`i.scdn.co` の画像だけ 1 日キャッシュ、API/認可/SDK は NetworkOnly
