import { useEffect, useMemo, useState } from 'react';
import { createFeedEngine, type FeedEngine, type FeedSettings, type FeedStatus } from '../core/feed/feedEngine';
import type { FeedItem } from '../core/feed/types';
import type { ValueStore } from '../core/valueStore';
import type { Services } from '../services';

export function useFeed(
  services: Services,
  feedSettings: ValueStore<FeedSettings>,
): { engine: FeedEngine; items: readonly FeedItem[]; status: FeedStatus } {
  const engine = useMemo(
    () =>
      createFeedEngine({
        api: services.api,
        store: services.store,
        history: services.history,
        settings: feedSettings.get,
        isRateLimited: () => services.client.rateLimitedUntil() !== null,
      }),
    [services, feedSettings],
  );
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
