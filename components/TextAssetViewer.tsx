import React, { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../hooks/useThemeColors';
import MeetingAssetTabs from './meeting/MeetingAssetTabs';

// Helper function to render structured summary content
const renderStructuredContent = (data: any, themeColors: any, depth: number = 0): React.ReactNode[] => {
  const elements: React.ReactNode[] = [];
  
  if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data)) {
      // Render array items - check if they're section objects or simple items
      data.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          // Check if this is a section object with a title/heading and content
          const itemKeys = Object.keys(item);
          const hasTitle = itemKeys.some(k => ['title', 'heading', 'name', 'section', 'label', 'key'].includes(k.toLowerCase()));
          const hasContent = itemKeys.some(k => ['items', 'content', 'bullets', 'points', 'list', 'data', 'values'].includes(k.toLowerCase()));
          
          if (hasTitle && hasContent) {
            // This is a section object - extract title and content
            const titleKey = itemKeys.find(k => ['title', 'heading', 'name', 'section', 'label', 'key'].includes(k.toLowerCase()));
            const contentKey = itemKeys.find(k => ['items', 'content', 'bullets', 'points', 'list', 'data', 'values'].includes(k.toLowerCase()));
            
            const sectionTitle = titleKey ? String(item[titleKey]) : `Section ${index + 1}`;
            const sectionContent = contentKey ? item[contentKey] : null;
            
            // Format title as heading
            const heading = sectionTitle.split('_').map(word => 
              word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
            ).join(' ');
            
            elements.push(
              <View key={index} style={{ marginTop: index === 0 ? 0 : 16, marginBottom: 12 }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', color: themeColors.text, marginBottom: 8 }}>
                  {heading}
                </Text>
                {sectionContent && (
                  <View>
                    {Array.isArray(sectionContent) ? (
                      // Render array of items as bullets
                      sectionContent.map((subItem, subIndex) => {
                        if (typeof subItem === 'object' && subItem !== null) {
                          // Extract text from object
                          const subKeys = Object.keys(subItem);
                          const textKey = subKeys.find(k => ['text', 'content', 'item', 'value', 'description', 'name'].includes(k.toLowerCase()));
                          const text = textKey ? String(subItem[textKey]) : (subKeys.length > 0 ? String(subItem[subKeys[0]]) : String(subItem));
                          return (
                            <Text key={subIndex} style={{ marginLeft: 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                              • {text}
                            </Text>
                          );
                        } else {
                          return (
                            <Text key={subIndex} style={{ marginLeft: 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                              • {String(subItem)}
                            </Text>
                          );
                        }
                      })
                    ) : typeof sectionContent === 'object' ? (
                      // Render object content
                      <View>{renderStructuredContent(sectionContent, themeColors, depth + 1)}</View>
                    ) : (
                      // Simple text content
                      <Text style={{ marginLeft: 16, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                        {String(sectionContent)}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          } else if (Array.isArray(item)) {
            // Nested array
            elements.push(
              <View key={index} style={{ marginLeft: depth * 16, marginBottom: 8 }}>
                {renderStructuredContent(item, themeColors, depth + 1)}
              </View>
            );
          } else {
            // Object with properties - render as key-value pairs or single value
            const entries = Object.entries(item);
            if (entries.length === 1 && typeof entries[0][1] !== 'object') {
              // Single property object - show just the value
              elements.push(
                <Text key={index} style={{ marginLeft: depth * 16 + 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                  • {String(entries[0][1])}
                </Text>
              );
            } else {
              // Multiple properties - render each
              entries.forEach(([objKey, objValue]) => {
                if (typeof objValue === 'object' && objValue !== null && !Array.isArray(objValue)) {
                  elements.push(
                    <View key={`${index}-${objKey}`} style={{ marginLeft: depth * 16 + 16, marginBottom: 8 }}>
                      <Text style={{ fontSize: 16, fontWeight: '600', color: themeColors.text, marginBottom: 4 }}>
                        {objKey.charAt(0).toUpperCase() + objKey.slice(1).replace(/_/g, ' ')}:
                      </Text>
                      {renderStructuredContent(objValue, themeColors, depth + 1)}
                    </View>
                  );
                } else {
                  elements.push(
                    <Text key={`${index}-${objKey}`} style={{ marginLeft: depth * 16 + 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                      • {String(objValue)}
                    </Text>
                  );
                }
              });
            }
          }
        } else {
          elements.push(
            <Text key={index} style={{ marginLeft: depth * 16 + 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
              • {String(item)}
            </Text>
          );
        }
      });
    } else {
      // Render object properties with headings
      // Skip metadata fields that shouldn't be displayed as headings
      const metadataFields = ['title', 'format', 'bullets', 'paragraph', 'content_type', 'version', 'metadata', 'created_at', 'updated_at', 'id'];
      
      // Filter out metadata fields first
      const contentEntries = Object.entries(data).filter(([key]) => 
        !metadataFields.includes(key.toLowerCase())
      );
      
      contentEntries.forEach(([key, value], index) => {
        const isFirst = index === 0;
        const marginTop = isFirst ? 0 : 16;
        
        // Format the key as a proper heading (capitalize first letter, replace underscores)
        const heading = key.split('_').map(word => 
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        ).join(' ');
        
        if (Array.isArray(value)) {
          // Section with heading and bullet list
          elements.push(
            <View key={key} style={{ marginTop, marginBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: 'bold', color: themeColors.text, marginBottom: 8 }}>
                {heading}
              </Text>
              {value.map((item, itemIndex) => {
                if (typeof item === 'object' && item !== null) {
                  // Object in array - try to extract meaningful content
                  const itemEntries = Object.entries(item);
                  if (itemEntries.length === 1) {
                    // Single property - show the value
                    const [objKey, objValue] = itemEntries[0];
                    // Skip if it's a metadata key
                    if (!metadataFields.includes(objKey.toLowerCase())) {
                      return (
                        <Text key={itemIndex} style={{ marginLeft: 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                          • {String(objValue)}
                        </Text>
                      );
                    }
                  } else {
                    // Multiple properties - show as text or render structure
                    // Try to find a text/description/content field
                    const textField = itemEntries.find(([k]) => 
                      ['text', 'content', 'description', 'value', 'item'].includes(k.toLowerCase())
                    );
                    if (textField) {
                      return (
                        <Text key={itemIndex} style={{ marginLeft: 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                          • {String(textField[1])}
                        </Text>
                      );
                    } else {
                      // Render the first non-metadata value
                      const firstValue = itemEntries.find(([k]) => 
                        !metadataFields.includes(k.toLowerCase())
                      );
                      if (firstValue) {
                        return (
                          <Text key={itemIndex} style={{ marginLeft: 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                            • {String(firstValue[1])}
                          </Text>
                        );
                      }
                    }
                  }
                  return null;
                } else {
                  // Simple value - show as bullet
                  return (
                    <Text key={itemIndex} style={{ marginLeft: 16, marginBottom: 4, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                      • {String(item)}
                    </Text>
                  );
                }
              })}
            </View>
          );
        } else if (typeof value === 'object' && value !== null) {
          // Nested object - render as section
          elements.push(
            <View key={key} style={{ marginTop, marginBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: 'bold', color: themeColors.text, marginBottom: 8 }}>
                {heading}
              </Text>
              {renderStructuredContent(value, themeColors, depth + 1)}
            </View>
          );
        } else {
          // Simple key-value pair - only show if value is meaningful
          if (value !== null && value !== undefined && String(value).trim() !== '') {
            elements.push(
              <View key={key} style={{ marginTop, marginBottom: 8 }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', color: themeColors.text, marginBottom: 4 }}>
                  {heading}
                </Text>
                <Text style={{ marginLeft: 16, fontSize: 16, lineHeight: 24, color: themeColors.text }}>
                  {String(value)}
                </Text>
              </View>
            );
          }
        }
      });
    }
  }
  
  return elements;
};

interface TextAssetViewerProps {
  visible: boolean;
  title: string;
  content: string;
  loading?: boolean;
  assetType?: string;
  onClose: () => void;
}

export default function TextAssetViewer({
  visible,
  title,
  content,
  loading = false,
  onClose,
  assetType
}: TextAssetViewerProps) {
  const themeColors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [truncatedTitle, setTruncatedTitle] = useState('');
  const [parsedContent, setParsedContent] = useState<any>(null);
  const [isJson, setIsJson] = useState(false);
  const [isCsv, setIsCsv] = useState(false);
  const [csvData, setCsvData] = useState<string[][]>([]);
  const fixedColumnScrollRef = useRef<ScrollView>(null);
  const scrollableColumnsScrollRef = useRef<ScrollView>(null);
  const horizontalScrollRef = useRef<ScrollView>(null);
  const isScrollingRef = useRef(false);
  const isHorizontalScrollingRef = useRef(false);

  useEffect(() => {
    // Truncate title to 40 characters
    const truncated = title.length > 40 ? title.substring(0, 40) + '...' : title;
    setTruncatedTitle(truncated);
  }, [title]);

  useEffect(() => {
    // Parse content - check if it's CSV first, then JSON, then plain text
    if (content) {
      // For transcripts, always render as plain text (no CSV/JSON parsing)
      if (assetType === 'transcript' || assetType === 'call_transcript') {
        setParsedContent(null);
        setIsJson(false);
        setIsCsv(false);
        return;
      }

      // Check if content looks like CSV (has commas and newlines, or tab-separated)
      const lines = content.trim().split('\n');
      const hasCommas = content.includes(',');
      const hasTabs = content.includes('\t');
      const hasMultipleLines = lines.length > 1;
      const firstLineHasCommas = lines[0]?.includes(',') || lines[0]?.includes('\t');
      
      // Only parse as CSV if it's a report type or if it's clearly structured data
      // For reports, allow CSV parsing; for other types, be more strict
      const isReportType = assetType === 'report' || assetType === 'meeting_report';
      
      // If it looks like CSV (multiple lines with delimiters), parse as CSV
      // But only for reports, or if it's clearly structured (consistent column count)
      if (hasMultipleLines && (hasCommas || hasTabs) && firstLineHasCommas) {
        const delimiter = hasTabs ? '\t' : ',';
        
        // For non-reports, check if it's actually structured (consistent column count)
        if (!isReportType) {
          const delimiterRegex = delimiter === '\t' ? /\t/g : /,/g;
          const firstLineCols = (lines[0].match(delimiterRegex) || []).length + 1;
          const consistentColumns = lines.slice(1, Math.min(5, lines.length)).every(line => {
            const cols = (line.match(delimiterRegex) || []).length + 1;
            return cols === firstLineCols;
          });
          if (!consistentColumns) {
            // Not structured CSV, treat as plain text
            setParsedContent(null);
            setIsJson(false);
            setIsCsv(false);
            return;
          }
        }
        try {
          const parsedCsv: string[][] = [];
          
          lines.forEach((line, index) => {
            if (line.trim()) {
              // Simple CSV parsing - handle quoted fields
              const fields: string[] = [];
              let currentField = '';
              let inQuotes = false;
              
              for (let i = 0; i < line.length; i++) {
                const char = line[i];
                const nextChar = line[i + 1];
                
                if (char === '"') {
                  if (inQuotes && nextChar === '"') {
                    // Escaped quote
                    currentField += '"';
                    i++; // Skip next quote
                  } else {
                    // Toggle quote state
                    inQuotes = !inQuotes;
                  }
                } else if (char === delimiter && !inQuotes) {
                  // End of field
                  fields.push(currentField.trim());
                  currentField = '';
                } else {
                  currentField += char;
                }
              }
              // Add last field
              fields.push(currentField.trim());
              
              parsedCsv.push(fields);
            }
          });
          
          if (parsedCsv.length > 0 && parsedCsv[0].length > 1) {
            setIsCsv(true);
            setCsvData(parsedCsv);
            setIsJson(false);
            setParsedContent(null);
            return;
          }
        } catch (e) {
          // Not valid CSV, continue to JSON check
        }
      }
      
      // Not CSV, try JSON
      try {
        // Try to parse as JSON
        const parsed = JSON.parse(content);
        
        // Check if content is wrapped in metadata - look for actual content sections
        // Common patterns: "sections", "content", or direct structure with meaningful keys
        let contentToRender = parsed;
        
        // Metadata fields to skip
        const metadataFields = ['title', 'format', 'bullets', 'paragraph', 'content_type', 'version', 'metadata', 'created_at', 'updated_at', 'id'];
        
        // Check for nested content structures
        if (parsed.sections && typeof parsed.sections === 'object') {
          contentToRender = parsed.sections;
        } else if (parsed.content && typeof parsed.content === 'object') {
          contentToRender = parsed.content;
        } else if (parsed.summary && typeof parsed.summary === 'object') {
          contentToRender = parsed.summary;
        } else if (parsed.data && typeof parsed.data === 'object') {
          contentToRender = parsed.data;
        } else {
          // Check if it's an array or object with numeric keys (array-like structure)
          const keys = Object.keys(parsed);
          const isArrayLike = keys.length > 0 && keys.every(key => /^\d+$/.test(key));
          
          if (isArrayLike) {
            // Convert array-like object to actual array for easier processing
            const arrayData = keys.map(key => parsed[key]).filter(item => item !== null && item !== undefined);
            contentToRender = arrayData;
          } else {
            // Filter out metadata fields from top level
            const filtered: any = {};
            Object.entries(parsed).forEach(([key, value]) => {
              if (!metadataFields.includes(key.toLowerCase())) {
                filtered[key] = value;
              }
            });
            // Only use filtered if it has meaningful content
            if (Object.keys(filtered).length > 0) {
              contentToRender = filtered;
            } else {
              // If all fields were metadata, use original but will be filtered in render
              contentToRender = parsed;
            }
          }
        }
        
        console.log('📄 Parsed summary structure:', Array.isArray(contentToRender) ? `Array[${contentToRender.length}]` : Object.keys(contentToRender));
        setParsedContent(contentToRender);
        setIsJson(true);
        setIsCsv(false);
      } catch (e) {
        // Not JSON, use content as-is
        setParsedContent(null);
        setIsJson(false);
        setIsCsv(false);
      }
    } else {
      setParsedContent(null);
      setIsJson(false);
      setIsCsv(false);
    }
  }, [content, assetType]);

  const dynamicStyles = StyleSheet.create({
    modalContainer: {
      flex: 1,
      backgroundColor: themeColors.background,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 12,
      backgroundColor: themeColors.headerBackground || themeColors.card,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    modalCloseButton: {
      fontSize: 16,
      color: themeColors.tint || '#007AFF',
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
    },
    contentContainer: {
      flex: 1,
      backgroundColor: themeColors.background,
      padding: 16,
    },
    textContent: {
      fontSize: 16,
      lineHeight: 24,
      color: themeColors.text,
      fontFamily: 'monospace',
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      marginTop: 16,
      fontSize: 16,
      color: themeColors.textSecondary,
    },
  });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={dynamicStyles.modalContainer} edges={['bottom', 'left', 'right']}>
        <View style={[dynamicStyles.modalHeader, { paddingTop: Math.max(insets.top, 8) }]}>
          <TouchableOpacity onPress={onClose}>
            <Text style={dynamicStyles.modalCloseButton}>Close</Text>
          </TouchableOpacity>
          <Text style={[dynamicStyles.modalTitle, { flex: 1, textAlign: 'center', marginHorizontal: 16 }]} numberOfLines={1} ellipsizeMode="tail">
            {truncatedTitle}
          </Text>
          <View style={{ width: 60 }} />
        </View>
        
        {loading ? (
          <View style={dynamicStyles.loadingContainer}>
            <ActivityIndicator size="large" color={themeColors.tint || '#007AFF'} />
            <Text style={dynamicStyles.loadingText}>Loading content...</Text>
          </View>
        ) : assetType === 'transcript' || assetType === 'call_transcript' || assetType === 'meeting_summary' || assetType === 'summary' || assetType === 'meeting_recap' ? (
          <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
            <MeetingAssetTabs
              initialTab={assetType === 'transcript' || assetType === 'call_transcript' ? 'transcript' : 'recap'}
              summaryContent={assetType === 'transcript' || assetType === 'call_transcript' ? '' : content}
              transcriptContent={assetType === 'transcript' || assetType === 'call_transcript' ? content : ''}
              hero={{ title }}
              showHeaderActions={false}
            />
          </View>
        ) : (
          isCsv && csvData.length > 0 ? (
            // CSV Table with sticky first column and fixed header
            <View style={{ flex: 1, flexDirection: 'row' }}>
              {/* Sticky First Column */}
              <View style={{ width: 150, borderRightWidth: 2, borderRightColor: themeColors.border }}>
                {/* Fixed Header for first column */}
                <View style={{ 
                  paddingVertical: 8,
                  paddingHorizontal: 8, 
                  backgroundColor: themeColors.card || themeColors.background,
                  borderBottomWidth: 2,
                  borderBottomColor: themeColors.border,
                  height: 50,
                  justifyContent: 'center',
                  alignItems: 'flex-start',
                }}>
                  <Text style={{ fontWeight: 'bold', fontSize: 14, color: themeColors.text }} numberOfLines={2}>
                    {csvData[0]?.[0] || ''}
                  </Text>
                </View>
                {/* Scrollable rows for first column */}
                <ScrollView 
                  ref={fixedColumnScrollRef}
                  style={{ flex: 1 }}
                  scrollEventThrottle={16}
                  onScroll={(event) => {
                    if (!isScrollingRef.current) {
                      isScrollingRef.current = true;
                      const offsetY = event.nativeEvent.contentOffset.y;
                      scrollableColumnsScrollRef.current?.scrollTo({ y: offsetY, animated: false });
                      setTimeout(() => { isScrollingRef.current = false; }, 50);
                    }
                  }}
                  showsVerticalScrollIndicator={false}
                >
                  {/* Rows for first column */}
                  {csvData.slice(1).map((row, rowIndex) => (
                    <View 
                      key={rowIndex} 
                      style={{ 
                        paddingVertical: 8,
                        paddingHorizontal: 8, 
                        borderBottomWidth: 1, 
                        borderBottomColor: themeColors.border,
                        backgroundColor: rowIndex % 2 === 0 ? themeColors.background : (themeColors.card || themeColors.background),
                        height: 50,
                        justifyContent: 'center',
                        alignItems: 'flex-start',
                      }}
                    >
                      <Text style={{ fontSize: 14, color: themeColors.text }} selectable numberOfLines={2}>
                        {row[0] || ''}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              </View>
              
              {/* Scrollable Columns */}
              <View style={{ flex: 1 }}>
                {/* Fixed Header row - scrolls horizontally but stays fixed vertically */}
                <View style={{ 
                  borderBottomWidth: 2, 
                  borderBottomColor: themeColors.border,
                  backgroundColor: themeColors.card || themeColors.background,
                  height: 50,
                }}>
                  <ScrollView 
                    ref={horizontalScrollRef}
                    horizontal={true}
                    showsHorizontalScrollIndicator={true}
                    nestedScrollEnabled={true}
                    onScroll={(event) => {
                      // Sync horizontal scroll with data rows if needed
                    }}
                  >
                    <View style={{ flexDirection: 'row' }}>
                      {csvData[0]?.slice(1).map((header, colIndex) => (
                        <View 
                          key={colIndex} 
                          style={{ 
                            width: 120, 
                            paddingVertical: 8,
                            paddingHorizontal: 8, 
                            borderRightWidth: colIndex < csvData[0].length - 2 ? 1 : 0,
                            borderRightColor: themeColors.border,
                            height: 50,
                            justifyContent: 'center',
                            alignItems: 'flex-start',
                          }}
                        >
                          <Text style={{ fontWeight: 'bold', fontSize: 14, color: themeColors.text }} numberOfLines={2}>
                            {header}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </View>
                {/* Scrollable data rows */}
                <ScrollView 
                  ref={scrollableColumnsScrollRef}
                  style={{ flex: 1 }}
                  scrollEventThrottle={16}
                  onScroll={(event) => {
                    if (!isScrollingRef.current) {
                      isScrollingRef.current = true;
                      const offsetY = event.nativeEvent.contentOffset.y;
                      fixedColumnScrollRef.current?.scrollTo({ y: offsetY, animated: false });
                      setTimeout(() => { isScrollingRef.current = false; }, 50);
                    }
                  }}
                  showsVerticalScrollIndicator={true}
                >
                  {/* Horizontal scroll container for data rows */}
                  <ScrollView 
                    horizontal={true}
                    showsHorizontalScrollIndicator={true}
                    nestedScrollEnabled={true}
                    scrollEventThrottle={16}
                    onScroll={(event) => {
                      if (!isHorizontalScrollingRef.current) {
                        isHorizontalScrollingRef.current = true;
                        const offsetX = event.nativeEvent.contentOffset.x;
                        horizontalScrollRef.current?.scrollTo({ x: offsetX, animated: false });
                        setTimeout(() => { isHorizontalScrollingRef.current = false; }, 50);
                      }
                    }}
                  >
                    <View>
                      {/* Data rows - aligned with header */}
                      {csvData.slice(1).map((row, rowIndex) => (
                        <View 
                          key={rowIndex} 
                          style={{ 
                            flexDirection: 'row', 
                            borderBottomWidth: 1, 
                            borderBottomColor: themeColors.border,
                            backgroundColor: rowIndex % 2 === 0 ? themeColors.background : (themeColors.card || themeColors.background),
                            height: 50,
                          }}
                        >
                          {row.slice(1).map((cell, colIndex) => (
                            <View 
                              key={colIndex} 
                              style={{ 
                                width: 120, 
                                paddingVertical: 8,
                                paddingHorizontal: 8, 
                                borderRightWidth: colIndex < row.length - 2 ? 1 : 0,
                                borderRightColor: themeColors.border,
                                height: 50,
                                justifyContent: 'center',
                                alignItems: 'flex-start',
                              }}
                            >
                              <Text style={{ fontSize: 14, color: themeColors.text }} selectable numberOfLines={2}>
                                {cell}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </ScrollView>
              </View>
            </View>
          ) : (
            <ScrollView 
              style={dynamicStyles.contentContainer}
              contentContainerStyle={{ paddingBottom: 20 }}
            >
              {isJson && parsedContent ? (
                <View>
                  {renderStructuredContent(parsedContent, themeColors)}
                </View>
              ) : (
                <Text 
                  style={dynamicStyles.textContent}
                  selectable={true}
                >
                  {content || 'No content available'}
                </Text>
              )}
            </ScrollView>
          )
        )}
      </SafeAreaView>
    </Modal>
  );
}
