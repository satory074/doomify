/** scrollsnapchanging / scrollsnapchange(CSS Scroll Snap Module Level 2)。
 *  TypeScript 6.0 の lib.dom にはまだ無いのでここで補う。lib.dom に入ったらこのファイルを消す */
interface SnapEvent extends Event {
  /** ブロック方向(縦)のスナップ先。無ければ null */
  readonly snapTargetBlock: Node | null;
  readonly snapTargetInline: Node | null;
}

interface HTMLElementEventMap {
  scrollsnapchanging: SnapEvent;
  scrollsnapchange: SnapEvent;
}
