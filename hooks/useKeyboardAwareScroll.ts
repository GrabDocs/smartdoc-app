import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  ScrollView,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

type FocusedInput = {
  measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void;
};

/**
 * Lifts a form above the keyboard on iOS and Android (including edge-to-edge
 * Android, where window resize often does not run) and scrolls the focused
 * field into the remaining viewport.
 *
 * `kbInset` is how many px the keyboard covers of `scrollHostRef`. When the
 * window already resized, inset is 0 so we do not double-lift.
 */
export function useKeyboardAwareScroll(options?: { onKeyboardShow?: () => void }) {
  const onKeyboardShow = options?.onKeyboardShow;
  const [kbInset, setKbInset] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const scrollHostRef = useRef<View>(null);
  const scrollYRef = useRef(0);
  const kbInsetRef = useRef(0);
  kbInsetRef.current = kbInset;

  const revealFocusedField = useCallback(() => {
    const delay = kbInsetRef.current > 0 ? 40 : 280;
    setTimeout(() => {
      const focused = TextInput.State.currentlyFocusedInput() as FocusedInput | null;
      const scroll = scrollRef.current as unknown as FocusedInput | null;
      if (!focused?.measureInWindow || !scroll?.measureInWindow) return;
      scroll.measureInWindow((_sx, sy, _sw, sh) => {
        if (sh <= 0) return;
        const visibleBottom = sy + sh;
        focused.measureInWindow((_x, y, _width, height) => {
          const overlap = y + height + 24 - visibleBottom;
          if (overlap > 1) {
            scrollRef.current?.scrollTo({ y: scrollYRef.current + overlap, animated: true });
          }
        });
      });
    }, delay);
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (event: { endCoordinates: { screenY: number; height: number } }) => {
      onKeyboardShow?.();
      const screenY = event.endCoordinates.screenY;
      const height = event.endCoordinates.height;
      const host = scrollHostRef.current;
      if (!host) {
        setKbInset(Math.max(0, Math.round(height)));
        return;
      }
      host.measureInWindow((_x, y, _w, h) => {
        const bottom = y + h;
        let inset = bottom > 0 && screenY > 0 ? bottom - screenY : height;
        if (height > 0) inset = Math.min(Math.max(0, inset), height);
        setKbInset(Math.max(0, Math.round(inset)));
      });
    };
    const onHide = () => setKbInset(0);
    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [onKeyboardShow]);

  useEffect(() => {
    if (kbInset <= 0) return;
    const timer = setTimeout(() => revealFocusedField(), 60);
    return () => clearTimeout(timer);
  }, [kbInset, revealFocusedField]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  return { kbInset, scrollRef, scrollHostRef, revealFocusedField, onScroll };
}
