import React from 'react';
import { StyleProp, StyleSheet, Text, TextProps, TextStyle } from 'react-native';
import { useThemeColors } from '../hooks/useThemeColors';

type AppHeaderTitleProps = Omit<TextProps, 'children'> & {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  /** Preferred size; shrinks to stay on one line. Default 24. */
  size?: number;
  /**
   * When true (default), title grows in a header row.
   * Set false when nested in a title+subtitle column wrap (Notes, sheets).
   */
  fill?: boolean;
  /** When false, long titles ellipsize instead of shrinking into neighboring actions. */
  shrink?: boolean;
};

/**
 * Screen nav title: large/bold by default, always one line (shrinks for long titles).
 */
export default function AppHeaderTitle({
  children,
  style,
  size = 24,
  fill = true,
  shrink = true,
  ...rest
}: AppHeaderTitleProps) {
  const colors = useThemeColors();
  const label = typeof children === 'string' ? children : '';
  // Short titles must not shrink; long ones may scale down to stay on one line.
  const allowScale = shrink && label.length > 16;

  return (
    <Text
      {...rest}
      style={[
        styles.title,
        fill ? styles.fill : styles.stacked,
        { color: colors.text, fontSize: size },
        style,
        styles.alignLeft, // always left like Email Sync (overrides accidental center)
      ]}
      numberOfLines={1}
      adjustsFontSizeToFit={allowScale}
      minimumFontScale={0.72}
      ellipsizeMode="tail"
      allowFontScaling
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  title: {
    minWidth: 0,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  alignLeft: {
    textAlign: 'left',
  },
  fill: {
    flex: 1,
    flexShrink: 1,
  },
  stacked: {
    flexGrow: 0,
    flexShrink: 1,
    width: '100%',
  },
});
