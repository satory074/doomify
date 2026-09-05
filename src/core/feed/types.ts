import type { Track } from '../spotify/types';

/** その曲がフィードに出てきた理由。カードのラベルとバケット重みに使う */
export type FeedReason =
  | 'top'
  | 'saved'
  | 'recent'
  | 'playlist'
  | 'deepcut'
  | 'appears_on'
  | 'feature'
  | 'genre'
  | 'new'
  | 'hipster';

export type Bucket = 'known' | 'adjacent' | 'discover';

export const BUCKET_OF: Record<FeedReason, Bucket> = {
  top: 'known',
  saved: 'known',
  recent: 'known',
  playlist: 'known',
  deepcut: 'adjacent',
  appears_on: 'adjacent',
  feature: 'adjacent',
  genre: 'discover',
  new: 'discover',
  hipster: 'discover',
};

export interface FeedItem {
  /** track.id と同じ。React の key と重複排除に使う */
  id: string;
  track: Track;
  reason: FeedReason;
  /** 理由の補足(アーティスト名・ジャンル名・プレイリスト名など) */
  reasonDetail?: string;
  bucket: Bucket;
}

export function reasonLabel(item: Pick<FeedItem, 'reason' | 'reasonDetail'>): string {
  const d = item.reasonDetail;
  switch (item.reason) {
    case 'top':
      return 'あなたのよく聴く曲';
    case 'saved':
      return 'あなたの保存曲';
    case 'recent':
      return '最近聴いた曲';
    case 'playlist':
      return d ? `プレイリスト「${d}」` : 'あなたのプレイリスト';
    case 'deepcut':
      return d ? `${d} のアルバムから` : 'アルバムの深掘り';
    case 'appears_on':
      return d ? `${d} の参加作品から` : '参加作品から';
    case 'feature':
      return d ? `${d} とつながる曲` : 'つながりのある曲';
    case 'genre':
      return d ? `ジャンル: ${d}` : 'ジャンルから';
    case 'new':
      return '最近の新譜';
    case 'hipster':
      return 'まだ知られていない曲';
  }
}
