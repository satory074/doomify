/** React の再レンダリングに縛られず「最新の値」を読むための小さな箱。
 *  エンジン/コントローラに設定を渡すときに ref の代わりに使う(render 中の ref 参照を避ける) */
export interface ValueStore<T> {
  get(): T;
  set(value: T): void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}
