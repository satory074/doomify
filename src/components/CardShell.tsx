import type { CSSProperties, ReactNode } from 'react';
import { FALLBACK_PALETTE, type CardPalette } from '../core/palette';

interface Props {
  index: number;
  active: boolean;
  palette: CardPalette | null;
  children: ReactNode;
}

/** 常に描画される「殻」。高さ 100% でスナップ点になる。中身は近いカードだけ描く */
export function CardShell({ index, active, palette, children }: Props) {
  const p = palette ?? FALLBACK_PALETTE;
  const style = { '--card-bg': p.bg, '--card-glow': p.glow, '--card-accent': p.accent } as CSSProperties;
  return (
    <article className={`card${active ? ' is-active' : ''}`} data-index={index} aria-current={active ? 'true' : undefined} style={style}>
      {children}
    </article>
  );
}
