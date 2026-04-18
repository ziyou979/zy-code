// Utility Types - general purpose TypeScript utility types.

export type DeepImmutable<T> = {
  readonly [K in keyof T]: DeepImmutable<T[K]>
}

export type DeepMutable<T> = {
  -readonly [K in keyof T]: DeepMutable<T[K]>
}

export type Permutations<T extends readonly unknown[]> = T extends []
  ? []
  : { [K in keyof T]: [T[K], ...Permutations<RemoveIndex<T, K>>] }[number]

type RemoveIndex<T extends readonly unknown[], K extends number | string> = K extends number
  ? T extends [infer First, ...infer Rest]
    ? K extends 0
      ? Rest
      : [First, ...RemoveIndex<Rest, Decrement<K>>]
    : []
  : []

type Decrement<I extends number> = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20][I]

export type MaybePromise<T> = T | Promise<T>

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> =
  Pick<T, Exclude<keyof T, Keys>> &
  { [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>> }[Keys]
