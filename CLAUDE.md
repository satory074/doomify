# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**doomify** — Spotify の曲を縦スワイプで聴き流すモバイル向け PWA。ログイン(PKCE)→ カード 0 でタップ → 以降はスワイプで曲が切り替わる。
Recommendations API が無い前提で、ユーザー自身のデータ + 隣接探索 + 検索からフィードを自前生成する。

## Commands

```bash
npm run dev      # 127.0.0.1:5173 固定(Spotify の Redirect URI 完全一致のため。localhost は不可)
npm test         # Vitest(src/core のコロケーションテスト。React 非依存)
npm run lint     # oxlint
npm run build    # tsc -b && vite build(型チェック兼務)
npm run preview  # PWA/SW の動作確認
```

`.env` の `VITE_SPOTIFY_CLIENT_ID` が空だとログイン画面に設定案内が出る(PKCE なので公開値。シークレット無し)。

`http://127.0.0.1:5173/doomify/?demo=1` でログイン無しのデモモード(`src/demo.ts`: 偽 API + 疑似再生。音は出ない)。`&delay=1500` を足すと偽 API の応答が遅れ、スケルトン → 最初のカード → 裏の補充の順序を目で確かめられる。
開発ビルドでは `window.__doomify.goTo(i)` / `scrollToIndex(i, 'instant')` / `snapshot()` で移動と再生状態を確認できる。

## Architecture

- **`src/core/`** — React 非依存の純 TS。全モジュールに `*.test.ts` を併設。外部(fetch / crypto / now / rng / storage)は注入
  - `auth/` PKCE(`pkce.ts`)、トークン永続化(`tokenStore.ts`)、`authManager.ts`(single-flight refresh、6 か月失効の予告、`invalid_grant` → 再ログイン)
  - `spotify/` `apiClient.ts`(優先度キュー playback>action>feed、同時 2・間隔 150ms。**playback は同時 +1 の専用枠で間隔免除**、間隔待ちの sleep も起こす。429 共通ゲート、401 強制更新 1 回、GET 短命キャッシュ)、
    `endpoints.ts`(2026-02 以降の開発モードで使えるエンドポイントだけ。**search / artistAlbums の limit 上限は 10**)、`types.ts`、`cache.ts`(idb-keyval + TTL ≤24h。`getEntry` は期限切れでも 24h 以内なら stale として返す)
  - `feed/` `feedEngine.ts`(種 → 3 バケットの候補プール → 重み付き抽選 → items 追記専用)、`sources.ts`(種: top/saved/recent/following/playlists。`startSeeds` で届いた順に集約へ合流、IDB キャッシュは期限切れでも 24h 以内なら stale で先に使い裏で再取得)、
    `expanders.ts`(deep_cut / appears_on / genre_search / tag_new / tag_hipster)、`scheduler.ts`(予算内の補充計画・重複キー・アーティスト間隔)、`history.ts`(seen 30 日・親和度)
  - `playback/` `controller.ts`(意図の集約: 意図が来たら即時発行、250ms 以内の連続は最新だけ間隔明けに(leading+trailing)、abort+seq、
    要求解決後に別曲の報告があれば 1.5s・無報告なら 3s で 1 回再送、自動送り判定、位置補間。snapshot に intentAt/issuedAt/resolvedAt/startedAt の計測値)、
    `sdkTarget.ts`(Web Playback SDK。`activate()` はタップ内で同期に)、`connectTarget.ts`(遠隔。可視中 10 秒ポーリング)
  - `snap.ts` スクロール幾何、`palette.ts` カバーからの配色、`env.ts` 端末判定、`format.ts`
- **`src/hooks/`** — `useAuth`(コールバック処理は module-level で 1 回だけ)、`useFeed`、`usePlayback`(target/controller の生成・破棄、失敗回数、visibilitychange 復帰)、
  `useActiveIndex`(意図 `onIntent` を先に通知: `scrollsnapchanging`(Chrome 129+)/ 無ければ scroll 中に最寄りが変わった瞬間 / `scrollToIndex` の呼び出し時。
  確定は `scrollend` + 幾何、無ければ scroll アイドル 150ms。確定が意図と食い違えば意図を出し直す。ResizeObserver で再整列)、`useSettings`、`useCoverPalette`、`useMediaSession`、`useKeyboardNav`
- **`src/components/`** — `FeedScreen`(配線の中心)、`Feed`(殻は全部・中身は active ±2)、`CardShell`/`TrackCard`/`CardActions`、`TapToStartGate`、`TopBar`、
  `DevicePicker`、`PlaylistPicker`、`SettingsSheet`、`Modal`(`<dialog>`)、`Toast`、`UpdatePrompt`(SW は prompt 更新)、`SpotifyMark`(帰属)
- **`src/services.ts`** — auth / client / api / store / history のシングルトン

## 設計上の約束

- **API 呼び出しは予算制**: 補充 1 回 ≤6 コール(`FEED_CONSTANTS.budgetPerRefill`)。レート制限中は known バケットのみ(ゼロコール)。ポーリングは Connect モードだけ
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

## Deploy

- GitHub Pages(`.github/workflows/deploy.yml`: test → lint → build → deploy-pages)。`base: '/doomify/'`
- Redirect URI はアプリのルート(`${origin}${BASE_URL}`)。Dashboard 側は `http://127.0.0.1:5173/doomify/` と `https://satory074.github.io/doomify/`
- SW: `registerType: 'prompt'`(autoUpdate は再生中にリロードする)。`i.scdn.co` の画像だけ 1 日キャッシュ、API/認可/SDK は NetworkOnly
