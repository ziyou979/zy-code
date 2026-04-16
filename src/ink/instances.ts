// 存储所有 Ink 实例，确保连续的 render() 调用
// 使用同一个 Ink 实例，而不是创建新实例
//
// 这个 Map 必须存储在单独的文件中，因为 render.js 创建实例，
// 而 instance.js 应在卸载时从 Map 中删除自身

import type Ink from './ink.js'

const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
