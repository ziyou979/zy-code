/**
 * UserForkBoilerplateMessage — 渲染 fork agent 的样板标记消息。
 * 仅在 FORK_SUBAGENT feature 启用时编译。
 *
 * 注意：此组件不导入 ink 包，因为调用方（UserTextMessage.tsx）
 * 通过同步 require() 加载此模块，而 ink 的 reconciler 包含
 * top-level await，Bun bundler 不允许 sync require 传递到此类模块。
 *
 * 渲染委托给调用方的容器组件处理布局和样式。
 */

import React from 'react'

interface Props {
  addMargin: boolean
  param: {
    text: string
    [key: string]: unknown
  }
}

export function UserForkBoilerplateMessage({ param }: Props): React.ReactElement {
  // fork-boilerplate 消息通常包含 <fork-boilerplate> 标签，
  // 直接展示其文本内容即可
  return React.createElement(React.Fragment, null, param.text)
}
