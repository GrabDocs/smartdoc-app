import React, { useMemo } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

/**
 * Lightweight markdown for Assist Ask answers: **bold**, line breaks, and "- " bullets.
 * No HTML.
 */
export default function MarkdownPlainText({
  text,
  style,
  boldStyle,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  boldStyle?: StyleProp<TextStyle>;
}) {
  const nodes = useMemo(() => {
    const raw = String(text || '').replace(/\r\n/g, '\n');
    if (!raw.trim()) return null;
    const lines = raw.split('\n');
    const out: React.ReactNode[] = [];
    lines.forEach((line, lineIdx) => {
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const content = bullet ? `• ${bullet[1]}` : line;
      out.push(
        <Text key={`l-${lineIdx}`} style={style}>
          {renderInline(content, `${lineIdx}`, boldStyle)}
          {lineIdx < lines.length - 1 ? '\n' : ''}
        </Text>,
      );
    });
    return out;
  }, [text, style, boldStyle]);

  if (!nodes) return null;
  return <Text style={style}>{nodes}</Text>;
}

function renderInline(
  text: string,
  keyBase: string,
  boldStyle?: StyleProp<TextStyle>,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        parts.push(
          <Text key={`${keyBase}-b-${n++}`} style={[{ fontWeight: '700' }, boldStyle]}>
            {text.slice(i + 2, end)}
          </Text>,
        );
        i = end + 2;
        continue;
      }
    }
    let j = i + 1;
    while (j < text.length && !text.startsWith('**', j)) j += 1;
    parts.push(text.slice(i, j));
    i = j;
  }
  return parts;
}
