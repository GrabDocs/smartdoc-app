import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useThemeColors } from '../hooks/useThemeColors';
import { extractUrls, htmlToPlainText } from '../utils/linkifyPlainText';
import { validateAndSanitizeUrl } from '../utils/linkSecurity';
import { isGrabDocsReachJoinUrl } from '../utils/grabdocsJoinUrl';
import { openMeetingUrl } from '../utils/openMeetingUrl';
import LinkifiedText from './LinkifiedText';

type LinkifiedMultilineInputProps = Omit<TextInputProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  linkColor?: string;
};

function openUrl(raw: string) {
  const result = validateAndSanitizeUrl(raw);
  if (result.valid && result.url) {
    if (
      isGrabDocsReachJoinUrl(result.url) ||
      /zoom\.us|teams\.(microsoft|live)\.com|meet\.google\.com|\.webex\.com/i.test(result.url)
    ) {
      void openMeetingUrl(result.url);
      return;
    }
    Linking.openURL(result.url).catch(() => {});
  }
}

/**
 * Multiline field: plain read view with inline links when blurred; TextInput when editing.
 * Tappable link chips below the field work in both modes (reliable inside ScrollViews).
 */
export default function LinkifiedMultilineInput({
  style,
  textStyle,
  linkColor,
  value = '',
  onChangeText,
  placeholder,
  placeholderTextColor,
  multiline,
  onBlur,
  ...rest
}: LinkifiedMultilineInputProps) {
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const text = String(value ?? '');
  const plain = useMemo(() => htmlToPlainText(text), [text]);
  const urls = useMemo(() => extractUrls(text), [text]);
  const accent = linkColor ?? colors.primary ?? '#007AFF';
  const showReadOnly = !focused && plain.trim().length > 0;

  useEffect(() => {
    if (!focused) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [focused]);

  const handleBlur: TextInputProps['onBlur'] = (event) => {
    if (plain !== text) {
      onChangeText?.(plain);
    }
    setFocused(false);
    onBlur?.(event);
  };

  const linkChips =
    urls.length > 0 ? (
      <View style={styles.linkRow}>
        {urls.map((raw) => (
          <Pressable
            key={raw}
            style={({ pressed }) => [
              styles.linkChip,
              {
                borderColor: accent,
                backgroundColor: pressed ? `${accent}18` : colors.surface,
              },
            ]}
            onPress={() => openUrl(raw)}
            accessibilityRole="link"
            accessibilityLabel={`Open link ${raw}`}
          >
            <Text style={[styles.linkChipText, { color: accent }]} numberOfLines={2}>
              {raw}
            </Text>
          </Pressable>
        ))}
      </View>
    ) : null;

  if (showReadOnly) {
    const flatStyle = StyleSheet.flatten(style);
    return (
      <View>
        <View style={flatStyle}>
          <LinkifiedText style={[{ color: colors.text }, textStyle]} linkColor={accent}>
            {text}
          </LinkifiedText>
          <Pressable
            onPress={() => setFocused(true)}
            accessibilityRole="button"
            accessibilityLabel="Edit text"
            hitSlop={8}
            style={styles.editHint}
          >
            <Text style={[styles.editHintText, { color: accent }]}>Edit</Text>
          </Pressable>
        </View>
        {linkChips}
      </View>
    );
  }

  return (
    <View>
      <TextInput
        ref={inputRef}
        style={style}
        value={text}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        multiline={multiline}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        {...rest}
      />
      {linkChips}
    </View>
  );
}

const styles = StyleSheet.create({
  linkRow: {
    marginTop: 8,
    gap: 8,
  },
  linkChip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  linkChipText: {
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  editHint: {
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  editHintText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
