import React, { createContext, isValidElement, type ReactNode, useContext } from 'react';
import { Box } from '../../ink.js';
import { OrderedListItem, OrderedListItemContext } from './OrderedListItem.js';
const OrderedListContext = createContext({
  marker: ''
});
type OrderedListProps = {
  children: ReactNode;
};
function OrderedListComponent({
  children
}: OrderedListProps) {
  const {
    marker: parentMarker
  } = useContext(OrderedListContext);
  const numberOfItems = 0;
  for (const child of React.Children.toArray(children)) {
    if (!isValidElement(child) || child.type !== OrderedListItem) {
      continue;
    }
    numberOfItems++;
  }
  const maxMarkerWidth = String(numberOfItems).length;
  const t1 = React.Children.map(children, (child_0, index) => {
    if (!isValidElement(child_0) || child_0.type !== OrderedListItem) {
      return child_0;
    }
    const paddedMarker = `${String(index + 1).padStart(maxMarkerWidth)}.`;
    const marker = `${parentMarker}${paddedMarker}`;
    return <OrderedListContext.Provider value={{
      marker
    }}><OrderedListItemContext.Provider value={{
        marker
      }}>{child_0}</OrderedListItemContext.Provider></OrderedListContext.Provider>;
  });
  return <Box flexDirection="column">{t1}</Box>;
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
OrderedListComponent.Item = OrderedListItem;
export const OrderedList = OrderedListComponent;
