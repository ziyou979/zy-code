import React from 'react';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box } from '../../ink.js';
import { type OptionWithDescription, Select } from '../CustomSelect/select.js';
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
   * Tree nodes to display.
   */
  readonly nodes: TreeNode<T>[];

  /**
   * Callback when a node is selected.
   */
  readonly onSelect: (node: TreeNode<T>) => void;

  /**
   * Callback when cancel is pressed.
   */
  readonly onCancel?: () => void;

  /**
   * Callback when focused node changes.
   */
  readonly onFocus?: (node: TreeNode<T>) => void;

  /**
   * Node to focus by ID.
   */
  readonly focusNodeId?: string | number;

  /**
   * Number of visible options.
   */
  readonly visibleOptionCount?: number;

  /**
   * Layout of the options.
   */
  readonly layout?: 'compact' | 'expanded' | 'compact-vertical';

  /**
   * When disabled, user input is ignored.
   */
  readonly isDisabled?: boolean;

  /**
   * When true, hides the numeric indexes next to each option.
   */
  readonly hideIndexes?: boolean;

  /**
   * Function to determine if a node should be initially expanded.
   * If not provided, all nodes start collapsed.
   */
  readonly isNodeExpanded?: (nodeId: string | number) => boolean;

  /**
   * Callback when a node is expanded.
   */
  readonly onExpand?: (nodeId: string | number) => void;

  /**
   * Callback when a node is collapsed.
   */
  readonly onCollapse?: (nodeId: string | number) => void;

  /**
   * Custom prefix function for parent nodes
   * @param isExpanded - Whether the parent node is currently expanded
   * @returns The prefix string to display (default: '▼ ' when expanded, '▶ ' when collapsed)
   */
  readonly getParentPrefix?: (isExpanded: boolean) => string;

  /**
   * Custom prefix function for child nodes
   * @param depth - The depth of the child node in the tree (0-indexed from parent)
   * @returns The prefix string to display (default: '  ▸ ')
   */
  readonly getChildPrefix?: (depth: number) => string;

  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  readonly onUpFromFirstItem?: () => void;
};

/**
 * TreeSelect is a generic component for selecting items from a hierarchical tree structure.
 * It handles expand/collapse state, keyboard navigation, and renders the tree as a flat list
 * using the Select component.
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
}: TreeSelectProps) {
  const t4 = new Set();
  const [internalExpandedIds, setInternalExpandedIds] = React.useState(t4);
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
    traverse(node_0, 0);
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
