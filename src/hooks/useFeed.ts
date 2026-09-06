import { useEffect, useMemo, useState } from 'react';
import { createEnrichment } from '../core/feed/enrichment';
import { createFeedEngine, type FeedEngine, type FeedSettings, type FeedStatus } from '../core/feed/feedEngine';
import type { FeedItem } from '../core/feed/types';
import type { ValueStore } from '../core/valueStore';
import type { Services } from '../services';

const now = () => Date.now();

export function useFeed(
  services: Services,
  feedSettings: ValueStore<FeedSettings>,
): { engine: FeedEngine; items: readonly FeedItem[]; status: FeedStatus } {
  // 強化キュー(外部の類似アーティスト・タグ)はエンジンと同じ寿命。設定で OFF なら enabled() が false になり何もしない
  const engine = useMemo(() => {
    const enrichment =
      services.external === null
        ? null
        : createEnrichment({
            mb: services.external.mb,
            lb: services.external.lb,
            store: services.store,
            now,
            enabled: () => feedSettings.get().externalSources !== false,
          });
    return createFeedEngine({
      api: services.api,
      store: services.store,
      history: services.history,
      settings: feedSettings.get,
      enrichment,
      isRateLimited: () => services.client.rateLimitedUntil() !== null,
    });
  }, [services, feedSettings]);
  const [items, setItems] = useState<readonly FeedItem[]>(() => engine.items());
  const [status, setStatus] = useState<FeedStatus>(() => engine.status());

  useEffect(() => {
    const unsubscribe = engine.subscribe((nextItems, nextStatus) => {
      setItems(nextItems);
      setStatus(nextStatus);
    });
    // 種の取得(IDB 読み + 最初のネットワーク要求)は履歴のロードを待たずに始める。
    // 抽選は履歴ロード後に行い、draw() が履歴を再判定するので見た曲は出ない
    void engine.bootstrap();
    void services.history.load().then(() => engine.ensureAhead(0));
    return unsubscribe;
  }, [engine, services.history]);

  return { engine, items, status };
}
