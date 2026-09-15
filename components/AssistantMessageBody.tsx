import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
    Linking,
    Platform,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useThemeColors } from '../hooks/useThemeColors';
import {
    normalizeDenseListMarkdown,
    parseBlocks,
    parseMarkdownLinks,
    processInlineFormatting,
    type FormattedBlock,
    type NestedListItem,
} from '../utils/chatFormatting';
import { formatDocumentOpenLinkLabel } from '../utils/chatLinkLabels';
import { localizeUtcDatesInAssistantText } from '../utils/chatUtcDisplay';
import { dedupeCitations } from '../utils/dedupeCitations';
import { validateAndSanitizeUrl } from '../utils/linkSecurity';
import type { SermonCitationType } from '../utils/sermonParagraphLinks';
import {
    buildParagraphToCiteMap,
    segmentParagraphForLinksEnriched,
    stripChartLinkLine,
    stripCiteAnchors,
} from '../utils/sermonParagraphLinks';

export interface AssistantMessageBodyProps {
  content: string;
  citations?: SermonCitationType[] | null;
  isPreview?: boolean;
  chartFileId?: number;
  textColor: string;
  previewColor?: string;
  onOpenSermon: (
    fileId: number,
    paragraph: number,
    title?: string,
    paragraphEnd?: number
  ) => void;
  /** Called when user taps a link. If not provided, external URLs open via Linking.openURL. */
  onOpenLink?: (url: string) => void;
  /** Show inline collapsible References section when citations exist. Default true. */
  showReferences?: boolean;
}

/** Render inline segments (bold, italic, code, URLs) as React Native Text. */
function renderInlineSegments(
  segments: ReturnType<typeof processInlineFormatting>,
  color: string,
  linkColor: string,
  codeBg: string,
  onOpenLink?: (url: string) => void
) {
  return segments.map((seg, i) => {
    if (seg.type === 'text') {
      return <Text key={i} style={{ color }}>{seg.text}</Text>;
    }
    if (seg.type === 'bold') {
      return (
        <Text key={i} style={{ fontWeight: '600', color }}>
          {seg.text}
        </Text>
      );
    }
    if (seg.type === 'italic') {
      return (
        <Text key={i} style={{ fontStyle: 'italic', color }}>
          {seg.text}
        </Text>
      );
    }
    if (seg.type === 'code') {
      return (
        <Text
          key={i}
          style={{
            backgroundColor: codeBg,
            paddingHorizontal: 4,
            paddingVertical: 2,
            borderRadius: 4,
            fontSize: 14,
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            color,
          }}
        >
          {seg.text}
        </Text>
      );
    }
    if (seg.type === 'url') {
      const result = validateAndSanitizeUrl(seg.raw);
      if (result.valid && result.url) {
        return (
          <Text
            key={i}
            style={{ color: linkColor, textDecorationLine: 'underline' }}
            onPress={() => {
              if (onOpenLink) onOpenLink(result.url!);
              else Linking.openURL(result.url!);
            }}
          >
            {seg.text}
          </Text>
        );
      }
      return (
        <Text key={i} style={{ color: '#ef4444' }}>
          {seg.text}
        </Text>
      );
    }
    return <Text key={i} style={{ color }}>{seg.text}</Text>;
  });
}

/** Split text by markdown links and return parts for rendering. */
function splitByMarkdownLinks(
  text: string
): Array<{ type: 'text' | 'link'; content: string; url?: string }> {
  const links = parseMarkdownLinks(text);
  if (links.length === 0) {
    return [{ type: 'text', content: text }];
  }
  const parts: Array<{ type: 'text' | 'link'; content: string; url?: string }> = [];
  let lastEnd = 0;
  for (const link of links) {
    if (link.start > lastEnd) {
      parts.push({ type: 'text', content: text.slice(lastEnd, link.start) });
    }
    parts.push({ type: 'link', content: link.text, url: link.url });
    lastEnd = link.end;
  }
  if (lastEnd < text.length) {
    parts.push({ type: 'text', content: text.slice(lastEnd) });
  }
  return parts;
}

/** Render a text string with paragraph links, markdown links, and inline formatting. */
function renderFormattedText(
  text: string,
  citeList: SermonCitationType[],
  citeMap: Map<number, number>,
  color: string,
  linkColor: string,
  codeBg: string,
  onOpenSermon: AssistantMessageBodyProps['onOpenSermon'],
  onOpenLink?: (url: string) => void
) {
  const segments = segmentParagraphForLinksEnriched(text, citeList, citeMap);
  return segments.map((seg, i) => {
    if (seg.type === 'link') {
      return (
        <Text
          key={i}
          style={{ color: linkColor, textDecorationLine: 'underline' }}
          onPress={() =>
            onOpenSermon(seg.fileId, seg.openStart, seg.title, seg.openEnd)
          }
        >
          {seg.text}
        </Text>
      );
    }
    // For text segments: split by markdown links, then apply inline formatting
    const mdParts = splitByMarkdownLinks(seg.text);
    return (
      <Text key={i} style={{ color }}>
        {mdParts.map((part, j) => {
          if (part.type === 'link' && part.url) {
            const result = validateAndSanitizeUrl(part.url);
            if (result.valid && result.url) {
              const linkLabel = formatDocumentOpenLinkLabel(part.content, result.url);
              return (
                <Text
                  key={j}
                  style={{ color: linkColor, textDecorationLine: 'underline' }}
                  onPress={() => {
                    if (onOpenLink) onOpenLink(result.url!);
                    else Linking.openURL(result.url!);
                  }}
                >
                  {linkLabel}
                </Text>
              );
            }
            return (
              <Text key={j} style={{ color: '#ef4444' }}>
                {part.content}
              </Text>
            );
          }
          const inlineSegs = processInlineFormatting(part.content);
          return (
            <React.Fragment key={j}>
              {renderInlineSegments(
                inlineSegs,
                color,
                linkColor,
                codeBg,
                onOpenLink
              )}
            </React.Fragment>
          );
        })}
      </Text>
    );
  });
}

export default function AssistantMessageBody({
  content,
  citations,
  isPreview,
  chartFileId,
  textColor,
  previewColor,
  onOpenSermon,
  onOpenLink,
  showReferences = true,
}: AssistantMessageBodyProps) {
  const colors = useThemeColors();
  const [referencesExpanded, setReferencesExpanded] = useState(false);

  const citeMap = useMemo(() => buildParagraphToCiteMap(content || ''), [content]);
  const displayRaw = useMemo(
    () => stripChartLinkLine(content || '', !!chartFileId),
    [content, chartFileId]
  );
  const clean = useMemo(() => stripCiteAnchors(displayRaw), [displayRaw]);
  const cleanLocalTimes = useMemo(
    () => localizeUtcDatesInAssistantText(clean),
    [clean]
  );
  const normalized = useMemo(
    () => normalizeDenseListMarkdown(cleanLocalTimes),
    [cleanLocalTimes]
  );
  const blocks = useMemo(() => parseBlocks(normalized), [normalized]);

  const citeList = citations || [];
  // Display only — keep full citeList for inline [[cite:N]] / paragraph link resolution.
  const displayCiteList = useMemo(
    () => dedupeCitations(citations || []),
    [citations],
  );
  const color = isPreview ? previewColor || textColor : textColor;
  const linkColor = '#007AFF';
  const codeBg = colors.isDark ? '#374151' : '#f3f4f6';
  const codeBlockBg = colors.isDark ? '#1f2937' : '#f3f4f6';

  if (!cleanLocalTimes.trim()) return null;

  const renderBlockContent = (block: FormattedBlock, keyPrefix: string) => {
    if (block.type === 'h1') {
      return (
        <Text
          key={keyPrefix}
          style={[styles.h1, { color }]}
        >
          {renderFormattedText(
            block.content,
            citeList,
            citeMap,
            color,
            linkColor,
            codeBg,
            onOpenSermon,
            onOpenLink
          )}
        </Text>
      );
    }
    if (block.type === 'h2') {
      return (
        <Text
          key={keyPrefix}
          style={[styles.h2, { color }]}
        >
          {renderFormattedText(
            block.content,
            citeList,
            citeMap,
            color,
            linkColor,
            codeBg,
            onOpenSermon,
            onOpenLink
          )}
        </Text>
      );
    }
    if (block.type === 'h3') {
      return (
        <Text
          key={keyPrefix}
          style={[styles.h3, { color }]}
        >
          {renderFormattedText(
            block.content,
            citeList,
            citeMap,
            color,
            linkColor,
            codeBg,
            onOpenSermon,
            onOpenLink
          )}
        </Text>
      );
    }
    if (block.type === 'code_block') {
      return (
        <View key={keyPrefix} style={[styles.codeBlock, { backgroundColor: codeBlockBg }]}>
          <Text
            style={[styles.codeBlockText, { color }]}
            selectable
          >
            {block.content}
          </Text>
        </View>
      );
    }
    if (block.type === 'ul' && block.items) {
      return (
        <View key={keyPrefix} style={styles.listBlock}>
          {block.items.map((item: NestedListItem, j: number) => (
            <View
              key={j}
              style={[styles.listRow, { paddingLeft: item.level * 16 }]}
            >
              <Text style={[styles.bullet, { color }]}>{'\u2022 '}</Text>
              <Text style={[styles.line, styles.listItemText, { color }]}>
                {renderFormattedText(
                  item.content,
                  citeList,
                  citeMap,
                  color,
                  linkColor,
                  codeBg,
                  onOpenSermon,
                  onOpenLink
                )}
              </Text>
            </View>
          ))}
        </View>
      );
    }
    if (block.type === 'ol' && block.items) {
      return (
        <View key={keyPrefix} style={styles.listBlock}>
          {block.items.map((item: NestedListItem, j: number) => (
            <View
              key={j}
              style={[styles.listRow, { paddingLeft: item.level * 16 }]}
            >
              <Text style={[styles.bullet, { color }]}>
                {(item.number ?? j + 1) + '. '}
              </Text>
              <Text style={[styles.line, styles.listItemText, { color }]}>
                {renderFormattedText(
                  item.content,
                  citeList,
                  citeMap,
                  color,
                  linkColor,
                  codeBg,
                  onOpenSermon,
                  onOpenLink
                )}
              </Text>
            </View>
          ))}
        </View>
      );
    }
    if (block.type === 'paragraph') {
      return (
        <View key={keyPrefix} style={styles.paraBlock}>
          <Text style={[styles.line, { color }]}>
            {renderFormattedText(
              block.content,
              citeList,
              citeMap,
              color,
              linkColor,
              codeBg,
              onOpenSermon,
              onOpenLink
            )}
          </Text>
        </View>
      );
    }
    return null;
  };

  const hasCitations = displayCiteList.length > 0;

  return (
    <View style={styles.wrap}>
      {blocks.map((block, i) => renderBlockContent(block, `block-${i}`))}

      {showReferences && hasCitations && (
        <View style={[styles.referencesContainer, { borderColor: colors.border }]}>
          <TouchableOpacity
            style={styles.referencesHeader}
            onPress={() => setReferencesExpanded((e) => !e)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={referencesExpanded ? 'chevron-down' : 'chevron-forward'}
              size={16}
              color={colors.textSecondary}
            />
            <Text style={[styles.referencesTitle, { color: colors.text }]}>
              References ({displayCiteList.length})
            </Text>
          </TouchableOpacity>
          {referencesExpanded && (
            <View style={styles.referencesList}>
              {displayCiteList.map((cit, idx) => {
                const c = typeof cit === 'object' ? cit : null;
                const name =
                  c?.source_name || c?.filename || c?.source_type || `Source ${idx + 1}`;
                const docId = c?.document_id ?? c?.source_id;
                const paraStart =
                  c?.paragraph_start ??
                  (c?.paragraph ? parseInt(String(c.paragraph), 10) : undefined);
                const paraEnd = c?.paragraph_end;
                const isLast = idx === displayCiteList.length - 1;
                const canOpen = docId != null;
                const numericId = docId != null
                  ? (typeof docId === 'string' ? parseInt(docId, 10) : docId)
                  : null;
                return (
                  <View
                    key={idx}
                    style={[
                      styles.referenceItem,
                      { borderBottomColor: colors.border },
                      isLast && styles.referenceItemLast,
                    ]}
                  >
                    <TouchableOpacity
                      style={styles.referenceItemHeader}
                      disabled={!canOpen}
                      activeOpacity={canOpen ? 0.6 : 1}
                      onPress={() => {
                        if (numericId != null) {
                          onOpenSermon(numericId, paraStart ?? 1, name, paraEnd);
                        }
                      }}
                    >
                      <View
                        style={[
                          styles.referenceBadge,
                          { backgroundColor: colors.primary + '20' },
                        ]}
                      >
                        <Text
                          style={[styles.referenceBadgeText, { color: colors.primary }]}
                        >
                          {idx + 1}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.referenceName,
                          { color: canOpen ? '#007AFF' : colors.text },
                          canOpen && { textDecorationLine: 'underline' },
                        ]}
                        numberOfLines={2}
                      >
                        {name}
                        {(paraStart != null || paraEnd != null) && (
                          <>
                            <Text style={{ fontWeight: '700' }}> • </Text>
                            {paraStart != null && paraEnd != null && paraEnd > paraStart
                              ? `par ${paraStart}–${paraEnd}`
                              : `par ${paraStart ?? paraEnd ?? ''}`}
                          </>
                        )}
                      </Text>
                    </TouchableOpacity>
                    {c?.excerpt && (
                      <Text
                        style={[styles.referenceExcerpt, { color: colors.textSecondary }]}
                        numberOfLines={3}
                      >
                        {localizeUtcDatesInAssistantText(String(c.excerpt))}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch' },
  paraBlock: { marginBottom: 10 },
  line: { fontSize: 16, lineHeight: 22 },
  listBlock: { marginBottom: 10, alignSelf: 'stretch' },
  listRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  bullet: { fontSize: 16, lineHeight: 22, width: 24 },
  listItemText: { flex: 1 },
  h1: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
    lineHeight: 24,
  },
  h2: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 8,
    lineHeight: 22,
  },
  h3: {
    fontSize: 15,
    fontWeight: '500',
    marginTop: 6,
    marginBottom: 4,
    lineHeight: 20,
  },
  codeBlock: {
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    overflow: 'hidden',
  },
  codeBlockText: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  referencesContainer: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  referencesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 8,
  },
  referencesTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  referencesList: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  referenceItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  referenceItemLast: {
    borderBottomWidth: 0,
  },
  referenceItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  referenceBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  referenceBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  referenceName: {
    flex: 1,
    fontSize: 14,
  },
  referenceExcerpt: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
});
