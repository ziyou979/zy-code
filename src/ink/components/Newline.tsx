import React from 'react';
export type Props = {
  /**
   * Number of newlines to insert.
   *
   * @default 1
   */
  readonly count?: number;
};

/**
 * Adds one or more newline (\n) characters. Must be used within <Text> components.
 */
export default function Newline({
  count = 1
}: Props) {
  const t2 = "\n".repeat(count);
  return <ink-text>{t2}</ink-text>;
}
