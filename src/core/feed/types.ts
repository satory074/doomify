import type { Track } from '../spotify/types';
import type { Strategy } from './scheduler';

/** その曲がフィードに出てきた理由。カードのラベルとバケット重みに使う */
export type FeedReason =
  | 'top'
  | 'saved'
  | 'recent'
  | 'playlist'
  | 'deepcut'
  | 'appears_on'
  | 'feature'
  | 'similar'
  | 'bridge'
  | 'similar_track'
  | 'genre'
  | 'tag'
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
  similar: 'discover',
  bridge: 'discover',
  similar_track: 'discover',
  genre: 'discover',
  tag: 'discover',
  new: 'discover',
  hipster: 'discover',
};

/** 「この曲が出た理由」の元になった種(アーティストまたは曲) */
export interface SeedRef {
  id: string;
  name: string;
}

export interface FeedItem {
  /** track.id と同じ。React の key と重複排除に使う */
  id: string;
  track: Track;
  reason: FeedReason;
  /** 理由の補足(アーティスト名・ジャンル名・プレイリスト名など) */
  reasonDetail?: string;
  bucket: Bucket;
  /** 候補を作った戦略(バンディットの学習に使う) */
  strategy?: Strategy;
  /** 類似・橋渡しの元になった種 */
  seed?: SeedRef;
  /** 種からの距離(0: 既知、1: 類似、2: 類似の類似) */
  hop?: number;
  /** ライブラリに保存済みか(判定できたときだけ) */
  saved?: boolean;
}

/** 好みと無関係な「くじ引き」の理由(連続させない) */
export function isWildcardReason(reason: FeedReason): boolean {
  return reason === 'new' || reason === 'hipster';
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
    case 'similar':
      return d ? `${d} が好きなら` : 'あなたの好みに近いアーティスト';
    case 'bridge':
      return d ? `${d} からたどって` : 'つながりをたどって';
    case 'similar_track':
      return d ? `『${d}』に似た曲` : 'いいねした曲に似た曲';
    case 'genre':
      return d ? `ジャンル: ${d}` : 'ジャンルから';
    case 'tag':
      return d ? `あなたのよく聴く ${d}` : 'あなたのジャンルから';
    case 'new':
      return '最近の新譜';
    case 'hipster':
      return 'まだ知られていない曲';
  }
}
