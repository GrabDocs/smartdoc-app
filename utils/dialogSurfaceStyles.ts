import { StyleSheet, ViewStyle } from 'react-native';

export type DialogSurfaceColors = {
  card: string;
  border: string;
};

/** Border that reads on white backgrounds in light mode. */
export function dialogSurfaceBorder(
  isDarkMode: boolean,
  borderColor: string,
): Pick<ViewStyle, 'borderWidth' | 'borderColor'> {
  return {
    borderWidth: isDarkMode ? StyleSheet.hairlineWidth : 1,
    borderColor: isDarkMode ? borderColor : 'rgba(0, 0, 0, 0.12)',
  };
}

/** Shadow tuned so floating surfaces lift off the page in light mode. */
export function dialogSurfaceShadow(isDarkMode: boolean): Pick<
  ViewStyle,
  'shadowColor' | 'shadowOffset' | 'shadowOpacity' | 'shadowRadius' | 'elevation'
> {
  return {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: isDarkMode ? 4 : 6 },
    shadowOpacity: isDarkMode ? 0.5 : 0.22,
    shadowRadius: isDarkMode ? 12 : 16,
    elevation: isDarkMode ? 10 : 14,
  };
}

/** Tap-outside overlay for anchored popovers (profile menu, Notes •••, etc.). */
export function anchoredPopoverOverlayStyle(isDarkMode: boolean): ViewStyle {
  return {
    flex: 1,
    // Light: subtle dim. Dark: stronger scrim so the card lifts off near-black screens.
    backgroundColor: isDarkMode ? 'rgba(0, 0, 0, 0.45)' : 'rgba(0, 0, 0, 0.05)',
  };
}

/** Anchored popover card positioned with `{ top, right }`. */
export function anchoredPopoverCardStyle(
  colors: DialogSurfaceColors,
  isDarkMode: boolean,
  options?: { minWidth?: number; maxWidth?: number },
): ViewStyle {
  return {
    position: 'absolute',
    backgroundColor: colors.card,
    borderRadius: 13,
    minWidth: options?.minWidth ?? 210,
    ...(options?.maxWidth != null ? { maxWidth: options.maxWidth } : {}),
    overflow: 'hidden',
    ...dialogSurfaceBorder(isDarkMode, colors.border),
    ...dialogSurfaceShadow(isDarkMode),
  };
}

/** Centered modal scrim — slightly stronger in light mode so white cards pop. */
export function modalScrimOverlayStyle(
  isDarkMode: boolean,
  extra?: ViewStyle,
): ViewStyle {
  return {
    flex: 1,
    backgroundColor: isDarkMode ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.45)',
    ...extra,
  };
}

/** Floating card on a scrim (kebab menus, modal boxes, picker sheets). */
export function floatingDialogSurfaceStyle(
  colors: DialogSurfaceColors,
  isDarkMode: boolean,
  options?: { borderRadius?: number; minWidth?: number },
): ViewStyle {
  return {
    backgroundColor: colors.card,
    borderRadius: options?.borderRadius ?? 12,
    ...(options?.minWidth != null ? { minWidth: options.minWidth } : {}),
    ...dialogSurfaceBorder(isDarkMode, colors.border),
    ...dialogSurfaceShadow(isDarkMode),
  };
}
