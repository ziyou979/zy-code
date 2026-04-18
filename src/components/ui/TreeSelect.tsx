import React from 'react';
import { Box } from '../../ink.js';
import { Select } from '../CustomSelect/select.js';
export type TreeNode<T> = {
  id: string | number;
  value: T;
  label: string;
  description?: string;
  dimDescription?: boolean;
  children?: TreeNode<T>[];
  metadata?: Record<string, unknown>;
};
type FlattenedNode<T> = {
  node: TreeNode<T>;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  parentId?: string | number;
};
export type TreeSelectProps<T> = {
  /**
   * 树节点列表。
   */
  readonly nodes: TreeNode<T>[];

  /**
   * 选中节点时的回调。
   */
  readonly onSelect: (node: TreeNode<T>) => void;

  /**
   * 按下取消时的回调。
   */
  readonly onCancel?: () => void;

  /**
   * 聚焦节点变化时的回调。
   */
  readonly onFocus?: (node: TreeNode<T>) => void;

  /**
   * 按 ID 指定初始聚焦的节点。
   */
  readonly focusNodeId?: string | number;

  /**
   * 可见选项数量。
   */
  readonly visibleOptionCount?: number;

  /**
   * 选项的布局方式。
   */
  readonly layout?: 'compact' | 'expanded' | 'compact-vertical';

  /**
   * 禁用时，用户输入将被忽略。
   */
  readonly isDisabled?: boolean;

  /**
   * 为 true 时，隐藏每个选项旁的数字索引。
   */
  readonly hideIndexes?: boolean;

  /**
   * 用于判断节点是否应初始展开的函数。
   * 如果未提供，所有节点初始均为收起状态。
   */
  readonly isNodeExpanded?: (nodeId: string | number) => boolean;

  /**
   * 节点展开时的回调。
   */
  readonly onExpand?: (nodeId: string | number) => void;

  /**
   * 节点收起时的回调。
   */
  readonly onCollapse?: (nodeId: string | number) => void;

  /**
   * 父节点的前缀自定义函数
   * @param isExpanded - 父节点当前是否展开
   * @returns 要显示的前缀字符串（默认：展开时为 '▼ '，收起时为 '▶ '）
   */
  readonly getParentPrefix?: (isExpanded: boolean) => string;

  /**
   * 子节点的前缀自定义函数
   * @param depth - 子节点在树中的深度（从父节点开始，0 起始）
   * @returns 要显示的前缀字符串（默认：'  ▸ '）
   */
  readonly getChildPrefix?: (depth: number) => string;

  /**
   * 用户在第一项按上方向键时的回调。
   * 如果提供，导航将不会循环到最后一项。
   */
  readonly onUpFromFirstItem?: () => void;
};

/**
 * TreeSelect 是一个泛型组件，用于从层级树结构中选择条目。
 * 它处理展开/收起状态、键盘导航，并使用 Select 组件将树渲染为扁平列表。
 */
export function TreeSelect({
  nodes,
  onSelect,
  onCancel,
  onFocus,
  focusNodeId,
  visibleOptionCount,
  layout = "expanded",
  isDisabled = false,
  hideIndexes = false,
  isNodeExpanded,
  onExpand,
  onCollapse,
  getParentPrefix,
  getChildPrefix,
  onUpFromFirstItem
}: TreeSelectProps<any>) {
  const [internalExpandedIds, setInternalExpandedIds] = React.useState(new Set<string>());
  const isProgrammaticFocusRef = React.useRef(false);
  const lastFocusedIdRef = React.useRef(null);
  const isExpanded = nodeId => {
    if (isNodeExpanded) {
      return isNodeExpanded(nodeId);
    }
    return internalExpandedIds.has(nodeId);
  };
  const result = [];
  function traverse(node, depth, parentId) {
    const hasChildren = !!node.children && node.children.length > 0;
    const nodeIsExpanded = isExpanded(node.id);
    result.push({
      node,
      depth,
      isExpanded: nodeIsExpanded,
      hasChildren,
      parentId
    });
    if (hasChildren && nodeIsExpanded && node.children) {
      for (const child of node.children) {
        traverse(child, depth + 1, node.id);
      }
    }
  }
  for (const node_0 of nodes) {
    traverse(node_0, 0, null);
  }
  const flattenedNodes = result;
  const defaultGetParentPrefix = isExpanded_0 => isExpanded_0 ? "\u25BC " : "\u25B6 ";
  const defaultGetChildPrefix = _depth => "  \u25B8 ";
  const parentPrefixFn = getParentPrefix ?? defaultGetParentPrefix;
  const childPrefixFn = getChildPrefix ?? defaultGetChildPrefix;
  const buildLabel = flatNode => {
    let prefix = "";
    if (flatNode.hasChildren) {
      prefix = parentPrefixFn(flatNode.isExpanded);
    } else {
      if (flatNode.depth > 0) {
        prefix = childPrefixFn(flatNode.depth);
      }
    }
    return prefix + flatNode.node.label;
  };
  const options = flattenedNodes.map(flatNode_0 => ({
    label: buildLabel(flatNode_0),
    description: flatNode_0.node.description,
    dimDescription: flatNode_0.node.dimDescription ?? true,
    value: flatNode_0.node.id
  }));
  const map = new Map();
  flattenedNodes.forEach(fn => map.set(fn.node.id, fn.node));
  const nodeMap = map;
  const findFlattenedNode = nodeId_0 => flattenedNodes.find(fn_0 => fn_0.node.id === nodeId_0);
  const toggleExpand = (nodeId_1, shouldExpand) => {
    const flatNode_1 = findFlattenedNode(nodeId_1);
    if (!flatNode_1 || !flatNode_1.hasChildren) {
      return;
    }
    if (shouldExpand) {
      if (onExpand) {
        onExpand(nodeId_1);
      } else {
        setInternalExpandedIds(prev => new Set(prev).add(nodeId_1));
      }
    } else {
      if (onCollapse) {
        onCollapse(nodeId_1);
      } else {
        setInternalExpandedIds(prev_0 => {
          const newSet = new Set(prev_0);
          newSet.delete(nodeId_1);
          return newSet;
        });
      }
    }
  };
  const handleKeyDown = e => {
    if (!focusNodeId || isDisabled) {
      return;
    }
    const flatNode_2 = findFlattenedNode(focusNodeId);
    if (!flatNode_2) {
      return;
    }
    if (e.key === "right" && flatNode_2.hasChildren) {
      e.preventDefault();
      toggleExpand(focusNodeId, true);
    } else {
      if (e.key === "left") {
        if (flatNode_2.hasChildren && flatNode_2.isExpanded) {
          e.preventDefault();
          toggleExpand(focusNodeId, false);
        } else {
          if (flatNode_2.parentId !== undefined) {
            e.preventDefault();
            isProgrammaticFocusRef.current = true;
            toggleExpand(flatNode_2.parentId, false);
            if (onFocus) {
              const parentNode = nodeMap.get(flatNode_2.parentId);
              if (parentNode) {
                onFocus(parentNode);
              }
            }
          }
        }
      }
    }
  };
  const handleChange = nodeId_2 => {
    const node_1 = nodeMap.get(nodeId_2);
    if (!node_1) {
      return;
    }
    onSelect(node_1);
  };
  const handleFocus = nodeId_3 => {
    if (isProgrammaticFocusRef.current) {
      isProgrammaticFocusRef.current = false;
      return;
    }
    if (lastFocusedIdRef.current === nodeId_3) {
      return;
    }
    lastFocusedIdRef.current = nodeId_3;
    if (onFocus) {
      const node_2 = nodeMap.get(nodeId_3);
      if (node_2) {
        onFocus(node_2);
      }
    }
  };
  return <Box tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{<Select options={options} onChange={handleChange} onFocus={handleFocus} onCancel={onCancel} defaultFocusValue={focusNodeId} visibleOptionCount={visibleOptionCount} layout={layout} isDisabled={isDisabled} hideIndexes={hideIndexes} onUpFromFirstItem={onUpFromFirstItem} />}</Box>;
}
