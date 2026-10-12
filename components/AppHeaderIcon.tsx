import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleProp, TextStyle, ViewStyle } from 'react-native';

/** Matches Financials screen header actions (cloud-upload / share / refresh). */
export const APP_HEADER_ICON_SIZE = 28;
/** Matches Financials / AppHeaderTitle default. */
export const APP_HEADER_TITLE_SIZE = 24;

/** Row for header action icons — no gap; spacing comes from each button's padding. */
export const appHeaderActionsStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
};

/** Touch target for a header action icon — matches Financials `headerButton`. */
export const appHeaderButtonStyle: ViewStyle = {
  padding: 8,
  marginTop: 4,
};

type AppHeaderIconProps = {
  name: React.ComponentProps<typeof Ionicons>['name'];
  color?: string;
  size?: number;
  style?: StyleProp<TextStyle>;
};

/**
 * Screen header action icon. Defaults to Financials size (28) so every
 * screen header stays consistent.
 */
export default function AppHeaderIcon({
  name,
  color,
  size = APP_HEADER_ICON_SIZE,
  style,
}: AppHeaderIconProps) {
  return <Ionicons name={name} size={size} color={color} style={style} />;
}
