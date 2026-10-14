import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

type DraftFindBarProps = {
  visible: boolean;
  editable: boolean;
  /** Matches reported by the editor WebView. index is -1 when there are none. */
  result: { count: number; index: number };
  colors: { text: string; textSecondary: string; border: string; background: string; card?: string; primary?: string };
  onQueryChange: (query: string) => void;
  onStep: (direction: 1 | -1) => void;
  onReplace: (replacement: string) => void;
  onReplaceAll: (replacement: string) => void;
  onClose: () => void;
  onInputFocusChange?: (focused: boolean) => void;
};

export default function DraftFindBar({
  visible,
  editable,
  result,
  colors,
  onQueryChange,
  onStep,
  onReplace,
  onReplaceAll,
  onClose,
  onInputFocusChange,
}: DraftFindBarProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [visible]);

  // Only send when the query actually changes; re-sending resets the active match to the first one.
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) {
      lastSentRef.current = null;
      return;
    }
    if (lastSentRef.current === query) return;
    const t = setTimeout(() => {
      lastSentRef.current = query;
      onQueryChange(query);
    }, 150);
    return () => clearTimeout(t);
  }, [query, visible, onQueryChange]);

  if (!visible) return null;

  const hasMatches = result.count > 0;
  const status = query.trim()
    ? hasMatches
      ? `${result.index + 1} of ${result.count}`
      : 'No results'
    : '';
  const primary = colors.primary || '#007AFF';
  const inputStyle = [
    styles.input,
    { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
  ];

  return (
    <View style={[styles.container, { borderBottomColor: colors.border, backgroundColor: colors.card || colors.background }]}>
      <View style={styles.row}>
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={setQuery}
          placeholder="Find in note"
          placeholderTextColor={colors.textSecondary}
          style={inputStyle}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => onStep(1)}
          blurOnSubmit={false}
          onFocus={() => onInputFocusChange?.(true)}
          onBlur={() => onInputFocusChange?.(false)}
          accessibilityLabel="Find in note"
        />
        <Text style={[styles.status, { color: colors.textSecondary }]}>{status}</Text>
        <TouchableOpacity style={styles.iconBtn} onPress={() => onStep(-1)} disabled={!hasMatches} accessibilityLabel="Previous match">
          <Ionicons name="chevron-up" size={22} color={hasMatches ? colors.text : colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={() => onStep(1)} disabled={!hasMatches} accessibilityLabel="Next match">
          <Ionicons name="chevron-down" size={22} color={hasMatches ? colors.text : colors.textSecondary} />
        </TouchableOpacity>
        {editable ? (
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setShowReplace((v) => !v)}
            accessibilityLabel={showReplace ? 'Hide replace' : 'Show replace'}
          >
            <Ionicons name="swap-horizontal" size={20} color={showReplace ? primary : colors.text} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.iconBtn} onPress={onClose} accessibilityLabel="Close find">
          <Ionicons name="close" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>
      {editable && showReplace ? (
        <View style={[styles.row, { marginTop: 6 }]}>
          <TextInput
            value={replacement}
            onChangeText={setReplacement}
            placeholder="Replace with"
            placeholderTextColor={colors.textSecondary}
            style={inputStyle}
            autoCapitalize="none"
            autoCorrect={false}
            onFocus={() => onInputFocusChange?.(true)}
            onBlur={() => onInputFocusChange?.(false)}
            accessibilityLabel="Replace with"
          />
          <TouchableOpacity
            style={[styles.textBtn, { backgroundColor: primary, opacity: hasMatches ? 1 : 0.4 }]}
            onPress={() => onReplace(replacement)}
            disabled={!hasMatches}
          >
            <Text style={styles.textBtnLabelPrimary}>Replace</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.textBtn, { borderColor: colors.border, borderWidth: 1, opacity: hasMatches ? 1 : 0.4 }]}
            onPress={() => onReplaceAll(replacement)}
            disabled={!hasMatches}
          >
            <Text style={[styles.textBtnLabel, { color: colors.text }]}>All</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  input: {
    flex: 1,
    height: 36,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 15,
  },
  status: {
    fontSize: 12,
    minWidth: 58,
    textAlign: 'center',
  },
  iconBtn: {
    padding: 6,
  },
  textBtn: {
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  textBtnLabelPrimary: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  textBtnLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
});
