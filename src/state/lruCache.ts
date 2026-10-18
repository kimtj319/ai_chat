/**
 * 가장 오래 안 쓴 것부터 버리는 작은 캐시. Map 이 넣은 순서를 지키므로, 쓸 때마다
 * 지웠다 다시 넣어 맨 뒤로 보내면 맨 앞이 가장 오래 안 쓴 것이다.
 *
 * 출처 창이 한 번 연 문서를 붙잡아 두는 데 쓴다(state/sourceCache.ts). 버릴 때 놓아야
 * 할 것(pdf.js 문서, 캔버스)이 있어서 onEvict 를 받는다 — 밀려나든, 지우든, 같은 키에
 * 다른 값이 들어오든 옛 값에는 꼭 한 번 불린다.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly limit: number,
    private readonly onEvict?: (value: V, key: K) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** 순서를 건드리지 않고 본다. 그리기 전에 "있는가" 만 알고 싶을 때. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** 꺼내면서 가장 최근에 쓴 것으로 올린다. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      const old = this.map.get(key)!;
      this.map.delete(key);
      if (old !== value) this.onEvict?.(old, key);
    }
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const [oldestKey, oldest] = this.map.entries().next().value as [K, V];
      this.map.delete(oldestKey);
      this.onEvict?.(oldest, oldestKey);
    }
  }

  delete(key: K): void {
    if (!this.map.has(key)) return;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.onEvict?.(value, key);
  }

  clear(): void {
    const entries = [...this.map.entries()];
    this.map.clear();
    for (const [key, value] of entries) this.onEvict?.(value, key);
  }

  /** 가장 오래 안 쓴 것부터. */
  values(): V[] {
    return [...this.map.values()];
  }
}
