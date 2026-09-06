# doomify

Spotify の曲を、TikTok のように縦スワイプで次々に聴き流すモバイル向け PWA。
あなたの保存曲・よく聴く曲を種にして、参加作品・ジャンル・新譜へと広がるフィードを自前で生成します
(Spotify の Recommendations API は廃止済みのため)。

- 再生: Web Playback SDK でブラウザ内再生。Spotify アプリなどへの Connect 遠隔再生にも 1 タップで切替
- フィード: なじみ(保存曲・トップ曲・最近再生・自分のプレイリスト)+ 発見(似たアーティスト・参加作品・アルバム深掘り・ジャンル×年代検索・新譜)を「発見度」スライダーで配合
- 発見は「まだ知らない曲」だけ: よく聴く/保存/フォロー中のアーティストや保存済みの曲は発見として出しません。カードには「〇〇が好きなら」「『曲』に似た曲」のように理由が付きます
- 学習: 飛ばした / 最後まで聴いた / いいね / 「こういうのをもっと」「これは違う」を手応えとして、アーティスト・ジャンル・発見源ごとの当たりやすさを学び、発見度もスライダー ±15% の範囲で自動調整します(設定の「発見の様子」で確認できます)
- 似たアーティストの情報源: Spotify の Related Artists / Recommendations は使えないため、[MusicBrainz](https://musicbrainz.org/) と [ListenBrainz](https://listenbrainz.org/)(MetaBrainz Foundation、キー不要・CC0)から取得します。
  あなたのよく聴くアーティスト名と、いいねした曲の ISRC が MetaBrainz に送られます。設定で「Spotify だけ」に切り替えると外部には一切送りません
- 既定の再生: 曲の約 30% 地点から流し、60 秒で自動的に次へ(設定で変更可)
- 操作: いいね(♡ / アートを 2 回タップ)、プレイリストに追加、Spotify で開く、「こういうのをもっと」「これは違う」

## 前提(2026 年 9 月時点の Spotify 開発モード)

- アプリ所有者に **Spotify Premium** が必要(開発モード自体の条件)。フル再生も Premium が必要
- 利用者は所有者 + ダッシュボードで登録した **最大 5 人**
- 認可(リフレッシュトークン)は **6 か月**で失効し、再ログインが必要

## セットアップ

1. <https://developer.spotify.com/dashboard> でアプリを作成
   - APIs used: **Web API** と **Web Playback SDK** にチェック
   - Redirect URIs に次の 2 つを登録(完全一致・末尾スラッシュ必須。`localhost` は使えません)
     - `http://127.0.0.1:5173/doomify/`
     - `https://satory074.github.io/doomify/`
2. Client ID を `.env` に設定(PKCE のため公開値。シークレットは使いません)
   ```
   VITE_SPOTIFY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
3. 依存を入れて起動
   ```bash
   npm install
   npm run dev      # http://127.0.0.1:5173/doomify/
   ```
4. 家族・友人を追加する場合は Dashboard の Settings > User Management に名前とメールを登録(最大 5 人)

## コマンド

```bash
npm run dev      # 開発サーバ(127.0.0.1:5173 固定)
npm test         # Vitest(core のコロケーションテスト)
npm run lint     # oxlint
npm run build    # tsc -b && vite build
npm run preview  # ビルド成果物の確認(PWA/SW の動作確認はこちら)
```

## デプロイ

`main` への push で GitHub Actions が test → lint → build → GitHub Pages へ公開します(`.github/workflows/deploy.yml`)。
公開 URL: <https://satory074.github.io/doomify/>

## スマホで使うとき

- iOS Safari: 最初に「タップして再生を始める」を押す必要があります(ブラウザの自動再生制限)。
  画面をロックするとブラウザ内再生は止まります。ロック中も聴きたいときは右上の再生先から **Spotify アプリ** を選んでください
  (アプリを一度開いて何か再生してから戻ると一覧に出ます)
- ホーム画面に追加すると全画面で使えます

## ライセンス・帰属

音楽・メタデータ・カバーアートは Spotify から提供されています。カバーアートは無加工で表示し、各カードから Spotify へリンクしています。
類似アーティストとジャンルのデータは MusicBrainz / ListenBrainz(MetaBrainz Foundation、CC0)から提供されています。
Spotify の非公式アプリであり、Spotify Developer Terms / Developer Policy に従って個人利用の範囲で使ってください。
