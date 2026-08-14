export type Props = {
  /**
   * 要插入的换行符数量。
   *
   * @default 1
   */
  readonly count?: number
}

/**
 * 添加一个或多个换行符（\n），必须在 <Text> 组件内使用。
 */
export default function Newline({ count = 1 }: Props) {
  // @ts-expect-error
  return <ink-text>{'\n'.repeat(count)}</ink-text>
}
