import type { FeedStats } from '../core/feed/feedEngine';
import { DEFAULT_GENRES } from '../core/feed/genres';
import type { SlotKind } from '../core/feed/pacing';
import type { FilterReason } from '../core/feed/ranker';
import type { Strategy } from '../core/feed/scheduler';
import type { AdvanceMode, Settings } from '../hooks/useSettings';
import { Modal } from './Modal';
import { SpotifyAttribution } from './SpotifyMark';

interface Props {
  open: boolean;
  settings: Settings;
  authNote: string | null;
  /** 開いている間だけ渡す(発見の様子) */
  stats: FeedStats | null;
  onUpdate: (patch: Partial<Settings>) => void;
  onResetHistory: () => void;
  onLogout: () => void;
  onClose: () => void;
}

const ADVANCE_OPTIONS: { value: AdvanceMode; label: string }[] = [
  { value: 'full', label: '曲の終わりまで' },
  { value: 60, label: '60 秒で次へ' },
  { value: 30, label: '30 秒で次へ' },
];

const STRATEGY_LABEL: Record<Strategy, string> = {
  saved_random: '保存曲',
  playlist_random: 'プレイリスト',
  deep_cut: 'アルバム深掘り',
  appears_on: '参加作品',
  similar_artist: '似たアーティスト',
  bridge: '似たアーティストの先',
  similar_track: 'いいねに似た曲',
  genre_search: 'ジャンル検索',
  tag_new: '新譜',
  tag_hipster: '隠れた曲',
};

const DISCOVERY_STRATEGIES: readonly Strategy[] = ['similar_artist', 'similar_track', 'bridge', 'appears_on', 'deep_cut', 'genre_search', 'tag_new', 'tag_hipster'];

const SLOT_LABEL: Record<SlotKind, string> = { anchor: 'なじみ', exploit: '期待値', trial: '試験', wildcard: 'くじ引き' };

const FILTER_LABEL: Record<FilterReason, string> = {
  seen: '見た曲',
  duplicate: '重複',
  avoided: '避けるアーティスト',
  known_artist: '既知アーティスト',
  excluded_tag: '除外ジャンル',
  trial_cap: '試験の上限',
  artist_spacing: 'アーティスト間隔',
  wildcard_adjacent: 'くじ引きの連続',
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function SettingsSheet({ open, settings, authNote, stats, onUpdate, onResetHistory, onLogout, onClose }: Props) {
  const toggleGenre = (g: string) => {
    const has = settings.genres.includes(g);
    onUpdate({ genres: has ? settings.genres.filter((x) => x !== g) : [...settings.genres, g] });
  };
  const toggleTag = (t: string) => {
    const excluded = settings.excludedTags.includes(t);
    onUpdate({ excludedTags: excluded ? settings.excludedTags.filter((x) => x !== t) : [...settings.excludedTags, t] });
  };
  const topTags = stats?.topTags ?? [];
  return (
    <Modal open={open} onClose={onClose} title="設定">
      {authNote !== null ? <div className="notice">{authNote}</div> : null}

      <fieldset className="field">
        <legend>曲のどこから流すか</legend>
        <div className="segmented" role="radiogroup">
          <button type="button" role="radio" aria-checked={settings.startPosition === 'hook'} onClick={() => onUpdate({ startPosition: 'hook' })}>
            サビ寄り(約 30% 地点)
          </button>
          <button type="button" role="radio" aria-checked={settings.startPosition === 'beginning'} onClick={() => onUpdate({ startPosition: 'beginning' })}>
            冒頭から
          </button>
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>自動で次の曲へ</legend>
        <div className="segmented" role="radiogroup">
          {ADVANCE_OPTIONS.map((o) => (
            <button key={String(o.value)} type="button" role="radio" aria-checked={settings.advance === o.value} onClick={() => onUpdate({ advance: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>
          発見度 <output>{Math.round(settings.discovery * 100)}%</output>
        </legend>
        <div className="slider-row">
          <span>なじみ</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.discovery}
            onChange={(e) => onUpdate({ discovery: Number(e.target.value) })}
            aria-label="発見度"
          />
          <span>発見</span>
        </div>
        <p className="muted">
          低いと保存曲・よく聴く曲が中心。高いと似たアーティスト・参加作品・ジャンル検索・新譜が増えます。手応え(飛ばした / 最後まで聴いた)に合わせて ±15% の範囲で自動調整します。
        </p>
      </fieldset>

      <fieldset className="field">
        <legend>似たアーティストの情報源</legend>
        <div className="segmented" role="radiogroup">
          <button type="button" role="radio" aria-checked={settings.externalSources} onClick={() => onUpdate({ externalSources: true })}>
            MusicBrainz / ListenBrainz を使う
          </button>
          <button type="button" role="radio" aria-checked={!settings.externalSources} onClick={() => onUpdate({ externalSources: false })}>
            Spotify だけ
          </button>
        </div>
        <p className="muted">
          使うと、あなたのよく聴くアーティスト名と、いいねした曲の ISRC が MetaBrainz(非営利・CC0 データ)に送られ、「〇〇が好きなら」の候補と自動ジャンルが得られます。Spotify だけの場合は参加作品とジャンル検索で探します。
        </p>
      </fieldset>

      {settings.externalSources && topTags.length > 0 ? (
        <fieldset className="field">
          <legend>あなたのジャンル(聴取データから自動)</legend>
          <div className="chips">
            {topTags.map((t) => (
              <button
                key={t.tag}
                type="button"
                className="chip chip-toggle"
                aria-pressed={!settings.excludedTags.includes(t.tag)}
                onClick={() => toggleTag(t.tag)}
                title={`重み ${Math.round(t.weight * 100)}%`}
              >
                {t.tag}
              </button>
            ))}
          </div>
          <p className="muted">オフにしたジャンルは発見に使いません。</p>
        </fieldset>
      ) : null}

      <fieldset className="field">
        <legend>好きなジャンル(発見の種になります)</legend>
        <div className="chips">
          {DEFAULT_GENRES.map((g) => (
            <button key={g} type="button" className="chip chip-toggle" aria-pressed={settings.genres.includes(g)} onClick={() => toggleGenre(g)}>
              {g}
            </button>
          ))}
        </div>
      </fieldset>

      {stats !== null ? <Diagnostics stats={stats} /> : null}

      <div className="field field-actions">
        <button type="button" className="btn" onClick={onResetHistory}>
          見た曲の履歴を消す
        </button>
        <button type="button" className="btn btn-quiet" onClick={onLogout}>
          ログアウト
        </button>
      </div>

      <div className="about">
        <SpotifyAttribution />
        <p className="muted">
          doomify は Spotify の非公式アプリです。Spotify Premium が必要で、認可は 6 か月ごとに更新が必要です。
          類似アーティストとジャンルのデータは MusicBrainz / ListenBrainz(MetaBrainz Foundation)から提供されています。
        </p>
      </div>
    </Modal>
  );
}

function Diagnostics({ stats }: { stats: FeedStats }) {
  const ranked = DISCOVERY_STRATEGIES.map((s) => ({ s, ...stats.strategies[s], served: stats.served[s] ?? 0 }))
    .filter((x) => x.served > 0 || x.a + x.b > 5)
    .sort((a, b) => b.mean - a.mean)
    .slice(0, 3);
  const ext = stats.external;
  const slotEntries = (Object.keys(SLOT_LABEL) as SlotKind[]).map((k) => [k, stats.slots[k] ?? 0] as const).filter(([, n]) => n > 0);
  const filterEntries = (Object.keys(FILTER_LABEL) as FilterReason[])
    .map((k) => [k, stats.filters[k] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const rates = stats.valueModel.rates;
  const interests = stats.session.topInterests.map((t) => `${t.key} ${pct(t.share)}`).join(' / ');
  return (
    <fieldset className="field diag">
      <legend>発見の様子</legend>
      <dl className="diag-list">
        <div>
          <dt>このセッション</dt>
          <dd>
            {stats.session.cards} 枚・{Math.round(stats.session.minutes)} 分・確信度 {pct(stats.session.confidence)}
            {interests !== '' ? `。興味: ${interests}` : ''}
          </dd>
        </div>
        <div>
          <dt>枠の内訳</dt>
          <dd>{slotEntries.length === 0 ? 'まだありません' : slotEntries.map(([k, n]) => `${SLOT_LABEL[k]} ${n}`).join(' / ')}</dd>
        </div>
        <div>
          <dt>学習した反応率</dt>
          <dd>
            {stats.valueModel.exposures < 1
              ? 'まだデータがありません'
              : `完走 ${pct(rates.complete)} / 保存 ${pct(rates.like)} / 共有 ${pct(rates.share)} / 早期スキップ ${pct(rates.earlySkip)}(${Math.round(stats.valueModel.exposures)} 枚)`}
          </dd>
        </div>
        <div>
          <dt>未知アーティストの試験</dt>
          <dd>
            試験中 {stats.trials.active} / 定着 {stats.trials.graduated} / 停止中 {stats.trials.blocked}
          </dd>
        </div>
        <div>
          <dt>落とした候補</dt>
          <dd>{filterEntries.length === 0 ? 'なし' : filterEntries.map(([k, n]) => `${FILTER_LABEL[k]} ${n}`).join(' / ')}</dd>
        </div>
        <div>
          <dt>いまの発見度</dt>
          <dd>
            {Math.round(stats.effectiveDiscovery * 100)}%{stats.exploration.cooldownLeft > 0 ? `(飛ばし続きのため、あと ${stats.exploration.cooldownLeft} 枚は控えめ)` : ''}
          </dd>
        </div>
        <div>
          <dt>探索カードの当たり率</dt>
          <dd>{stats.recent.count === 0 ? 'まだデータがありません' : `${Math.round(stats.recent.hitRate * 100)}%(直近 ${stats.recent.count} 枚)`}</dd>
        </div>
        <div>
          <dt>効いている発見源</dt>
          <dd>{ranked.length === 0 ? 'まだ学習中' : ranked.map((x) => `${STRATEGY_LABEL[x.s]} ${Math.round(x.mean * 100)}%`).join(' / ')}</dd>
        </div>
        <div>
          <dt>既知のアーティスト</dt>
          <dd>{stats.knownArtists} 組(発見からは除外)</dd>
        </div>
        {ext !== null ? (
          <div>
            <dt>外部データ</dt>
            <dd>
              類似の種 {ext.similarSeeds} / 類似候補 {ext.similarEntries} / タグ付き {ext.taggedArtists} / MusicBrainz {ext.mb.requests} 回・ListenBrainz {ext.lb.requests} 回・キャッシュ {ext.cacheHits} 回
            </dd>
          </div>
        ) : null}
      </dl>
    </fieldset>
  );
}
