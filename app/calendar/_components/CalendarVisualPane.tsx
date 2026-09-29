import React, { Fragment, useMemo, useRef } from 'react';
import {
  FlatList,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Calendar } from 'react-native-calendars';
import type { CalendarSubView } from '../../../utils/calendarRange';
import { calendarFetchRange, toYMDLocal, weekRangeMonday } from '../../../utils/calendarRange';
import {
  calendarDisplayLocation,
  eventHasReachMeeting,
  formatEventWhen,
  parseUTC,
  sortCalendarEventsByStartAsc,
  sortCalendarEventsByStartDesc,
  type ListTabFilter,
} from '../../../utils/calendarTime';
import { openMapsForLocationLabel } from '../../../utils/openMapsQuery';
import { CalendarReachPill } from './CalendarReachIndicator';

export type CalendarVisualEvent = Record<string, any>;

type ThemeColors = {
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
  border: string;
};

type Props = {
  subView: CalendarSubView;
  cursor: Date;
  /** Highlighted day in month grid + events list under grid */
  monthSelectedDay: Date;
  onMonthSelectedDay: (d: Date) => void;
  /** Keeps fetch window / toolbar title in sync when changing month or week day */
  onCursorDateChange: (d: Date) => void;
  visibleEvents: CalendarVisualEvent[];
  /** Same sort order as List view for the selected stat tab (`past` = newest first). */
  listTab: ListTabFilter;
  colors: ThemeColors;
  onEventPress: (eventId: number) => void;
  /** Pull-to-refresh for week / day / agenda lists (month uses outer ScrollView). */
  listRefreshControl?: React.ReactElement<typeof RefreshControl>;
  /** Month grid lives inside a parent ScrollView; used to scroll events into view after day tap. */
  monthScrollRef?: React.RefObject<ScrollView | null>;
  /** Keyboard / search dropdown — dismiss when user interacts with calendar body or scrolls lists. */
  onDismissOverlays?: () => void;
  /** Tap Reach pill on an event row to join (same resolution as list view). */
  onReachMeetingPress?: (ev: CalendarVisualEvent) => void;
};

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Match `app/calendar/index.tsx` list: Past = newest first; other tabs = earliest first. */
function sortEventsLikeListTab<T extends { start_time?: string | null }>(events: T[], tab: ListTabFilter): T[] {
  return tab === 'past' ? sortCalendarEventsByStartDesc(events) : sortCalendarEventsByStartAsc(events);
}

function eventsForLocalDay(events: CalendarVisualEvent[], day: Date, listTab: ListTabFilter): CalendarVisualEvent[] {
  const y = day.getFullYear();
  const m = day.getMonth();
  const d = day.getDate();
  const startMs = new Date(y, m, d, 0, 0, 0, 0).getTime();
  const endMs = new Date(y, m, d, 23, 59, 59, 999).getTime();
  const inDay = events.filter((ev) => {
    const s = ev.start_time ? parseUTC(ev.start_time).getTime() : 0;
    const e = ev.end_time ? parseUTC(ev.end_time).getTime() : s;
    return s <= endMs && e >= startMs;
  });
  return sortEventsLikeListTab(inDay, listTab);
}

function eventsInRange(
  events: CalendarVisualEvent[],
  start: Date,
  end: Date,
  listTab: ListTabFilter
): CalendarVisualEvent[] {
  const sm = start.getTime();
  const em = end.getTime();
  const inRange = events.filter((ev) => {
    const s = ev.start_time ? parseUTC(ev.start_time).getTime() : 0;
    const e = ev.end_time ? parseUTC(ev.end_time).getTime() : s;
    return s <= em && e >= sm;
  });
  return sortEventsLikeListTab(inRange, listTab);
}

export function CalendarVisualPane({
  subView,
  cursor,
  monthSelectedDay,
  onMonthSelectedDay,
  onCursorDateChange,
  visibleEvents,
  listTab,
  colors,
  onEventPress,
  listRefreshControl,
  monthScrollRef,
  onDismissOverlays,
  onReachMeetingPress,
}: Props) {
  const range = useMemo(() => calendarFetchRange(cursor, subView), [cursor, subView]);
  const monthCalCardHeightRef = useRef(0);

  const markedDates = useMemo(() => {
    const personal = '#2563EB';
    const company = '#EA580C';
    const cancelled = '#9CA3AF';
    const sel = toYMDLocal(monthSelectedDay);

    const map: Record<
      string,
      { dots?: { color: string }[]; marked?: boolean; selected?: boolean; selectedColor?: string }
    > = {};

    for (const ev of visibleEvents) {
      const isCancelled = String(ev.status ?? '').toLowerCase() === 'cancelled';
      const dotColor = isCancelled ? cancelled : ev.event_type === 'company' ? company : personal;
      const s = ev.start_time ? parseUTC(ev.start_time) : null;
      const e = ev.end_time ? parseUTC(ev.end_time) : s;
      if (!s) continue;
      const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      const last = new Date(e!.getFullYear(), e!.getMonth(), e!.getDate());
      while (cur.getTime() <= last.getTime()) {
        if (cur.getTime() >= range.start.getTime() && cur.getTime() <= range.end.getTime()) {
          const ymd = toYMDLocal(cur);
          const prev = map[ymd];
          const dots = [...(prev?.dots ?? [])];
          if (dots.length < 4) dots.push({ color: dotColor });
          map[ymd] = { ...prev, dots, marked: true };
        }
        cur.setDate(cur.getDate() + 1);
      }
    }

    map[sel] = {
      ...map[sel],
      selected: true,
      selectedColor: '#007AFF',
      dots: map[sel]?.dots,
      marked: true,
    };

    return map;
  }, [visibleEvents, range.start, range.end, monthSelectedDay]);

  const calendarTheme = useMemo(
    () => ({
      backgroundColor: colors.background,
      calendarBackground: colors.surface,
      textSectionTitleColor: colors.textSecondary,
      monthTextColor: colors.text,
      dayTextColor: colors.text,
      textDisabledColor: colors.textSecondary,
      selectedDayBackgroundColor: '#007AFF',
      selectedDayTextColor: '#ffffff',
      todayTextColor: '#007AFF',
      dotColor: '#007AFF',
      arrowColor: '#007AFF',
      indicatorColor: '#007AFF',
    }),
    [colors]
  );

  const weekDays = useMemo(() => {
    const { start } = weekRangeMonday(cursor);
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    return days;
  }, [cursor]);

  const eventsWeek = useMemo(() => {
    const { start, end } = weekRangeMonday(cursor);
    return eventsInRange(visibleEvents, start, end, listTab);
  }, [visibleEvents, cursor, listTab]);

  const eventsDay = useMemo(() => eventsForLocalDay(visibleEvents, cursor, listTab), [visibleEvents, cursor, listTab]);

  const agendaSections = useMemo(() => {
    const { start, end } = range;
    const byDay = new Map<string, CalendarVisualEvent[]>();
    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cur.getTime() <= end.getTime()) {
      byDay.set(toYMDLocal(new Date(cur)), []);
      cur.setDate(cur.getDate() + 1);
    }
    for (const ev of visibleEvents) {
      const s = ev.start_time ? parseUTC(ev.start_time) : null;
      if (!s) continue;
      const k = toYMDLocal(new Date(s.getFullYear(), s.getMonth(), s.getDate()));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(ev);
    }
    const keys = [...byDay.keys()].sort().reverse();
    return keys
      .map((k) => {
        const parts = k.split('-').map(Number);
        const yy = parts[0];
        const mm = parts[1];
        const dd = parts[2];
        const dt = new Date(yy, mm - 1, dd);
        const title = dt.toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
        const data = sortEventsLikeListTab(byDay.get(k) ?? [], listTab);
        return { title, key: k, data };
      })
      .filter((s) => s.data.length > 0);
  }, [visibleEvents, range, listTab]);

  const monthDayEvents = useMemo(
    () => eventsForLocalDay(visibleEvents, monthSelectedDay, listTab),
    [visibleEvents, monthSelectedDay, listTab]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { flex: 1 },
        calCard: {
          borderRadius: 12,
          overflow: 'hidden',
          marginHorizontal: 12,
          marginBottom: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        sectionHdr: {
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: colors.surface,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        sectionHdrText: { fontSize: 14, fontWeight: '700', color: colors.text },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          backgroundColor: colors.background,
        },
        rowTitle: { fontSize: 15, fontWeight: '600', color: colors.text, flex: 1 },
        rowMeta: { fontSize: 13, color: colors.textSecondary },
        rowLocationLink: { fontSize: 13, color: '#007AFF', marginTop: 4 },
        weekStrip: {
          flexDirection: 'row',
          marginHorizontal: 12,
          marginBottom: 8,
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          overflow: 'hidden',
          backgroundColor: colors.surface,
        },
        weekCell: { flex: 1, paddingVertical: 10, alignItems: 'center' },
        weekCellOn: { backgroundColor: '#007AFF22' },
        weekDow: { fontSize: 11, color: colors.textSecondary, marginBottom: 4 },
        weekDom: { fontSize: 16, fontWeight: '700', color: colors.text },
        subheading: {
          fontSize: 13,
          fontWeight: '600',
          color: colors.textSecondary,
          paddingHorizontal: 16,
          paddingVertical: 8,
        },
        empty: { padding: 24, textAlign: 'center', color: colors.textSecondary },
        metaRow: {
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'nowrap',
          gap: 8,
          marginTop: 4,
        },
        metaRowRight: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          marginLeft: 'auto',
        },
      }),
    [colors]
  );

  const renderEventRow = (ev: CalendarVisualEvent) => {
    const reach = eventHasReachMeeting(ev);
    const cancelled = String(ev.status ?? '').toLowerCase() === 'cancelled';
    const company = String(ev.event_type ?? '').toLowerCase() === 'company';
    const locationLabel = calendarDisplayLocation(ev.location);
    return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => {
        onDismissOverlays?.();
        onEventPress(Number(ev.id));
      }}
      accessibilityRole="button"
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {String(ev.status ?? '').toLowerCase() === 'cancelled' ? 'Cancelled · ' : ''}
          {ev.title || 'Untitled'}
        </Text>
        <View style={styles.metaRow}>
          <Text style={[styles.rowMeta, { flex: 1, minWidth: 0 }]} numberOfLines={2}>
            {formatEventWhen(ev)}
            {company ? ' · Company' : ''}
          </Text>
          {reach ? (
            <View style={styles.metaRowRight}>
              <CalendarReachPill
                onPress={
                  cancelled || !onReachMeetingPress
                    ? undefined
                    : () => {
                        onDismissOverlays?.();
                        onReachMeetingPress(ev);
                      }
                }
              />
            </View>
          ) : null}
        </View>
        {locationLabel ? (
          <Text
            style={styles.rowLocationLink}
            selectable
            onPress={() => {
              onDismissOverlays?.();
              void openMapsForLocationLabel(locationLabel);
            }}
            accessibilityRole="link"
            accessibilityLabel={`Map options for ${locationLabel}`}
          >
            📍 {locationLabel}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
    );
  };

  if (subView === 'month') {
    const curYmd = toYMDLocal(cursor);

    const scrollParentToDayEvents = () => {
      const scroll = monthScrollRef?.current;
      if (!scroll) return;
      const calH = monthCalCardHeightRef.current;
      if (calH <= 0) return;
      const calCardMarginBottom = 8;
      const y = Math.max(0, calH + calCardMarginBottom);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scroll.scrollTo({ y, animated: true });
        });
      });
    };

    return (
      <View style={styles.wrap}>
        <View
          style={styles.calCard}
          onLayout={(e) => {
            monthCalCardHeightRef.current = e.nativeEvent.layout.height;
          }}
        >
          <Calendar
            current={curYmd}
            markedDates={markedDates}
            markingType="multi-dot"
            theme={calendarTheme}
            enableSwipeMonths
            onDayPress={(day) => {
              onDismissOverlays?.();
              onMonthSelectedDay(new Date(day.year, day.month - 1, day.day));
              scrollParentToDayEvents();
            }}
            onMonthChange={(m) => {
              onDismissOverlays?.();
              const lastDay = new Date(m.year, m.month, 0).getDate();
              const day = Math.min(monthSelectedDay.getDate(), lastDay);
              const next = new Date(m.year, m.month - 1, day);
              onCursorDateChange(next);
              onMonthSelectedDay(next);
            }}
          />
        </View>
        <Text style={styles.subheading}>
          {monthSelectedDay.toLocaleString(undefined, {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          })}
        </Text>
        {monthDayEvents.length === 0 ? (
          <Text style={styles.empty}>No events this day</Text>
        ) : (
          monthDayEvents.map((ev) => <Fragment key={String(ev.id)}>{renderEventRow(ev)}</Fragment>)
        )}
      </View>
    );
  }

  if (subView === 'week') {
    const today = new Date();
    return (
      <View style={styles.wrap}>
        <View style={styles.weekStrip}>
          {weekDays.map((d) => {
            const on = sameLocalDay(d, cursor);
            const isToday = sameLocalDay(d, today);
            return (
              <TouchableOpacity
                key={toYMDLocal(d)}
                style={[styles.weekCell, on && styles.weekCellOn]}
                onPress={() => {
                  onCursorDateChange(d);
                  onMonthSelectedDay(d);
                }}
                accessibilityRole="button"
              >
                <Text style={styles.weekDow}>{d.toLocaleString(undefined, { weekday: 'narrow' })}</Text>
                <Text style={[styles.weekDom, isToday && { color: '#007AFF' }]}>{d.getDate()}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {eventsWeek.length === 0 ? (
          <Text style={styles.empty}>No events this week</Text>
        ) : (
          <FlatList
            data={eventsWeek}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => renderEventRow(item)}
            refreshControl={listRefreshControl}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={() => onDismissOverlays?.()}
          />
        )}
      </View>
    );
  }

  if (subView === 'day') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.subheading}>
          {cursor.toLocaleString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </Text>
        {eventsDay.length === 0 ? (
          <Text style={styles.empty}>No events this day</Text>
        ) : (
          <FlatList
            data={eventsDay}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => renderEventRow(item)}
            refreshControl={listRefreshControl}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <SectionList
        sections={agendaSections}
        keyExtractor={(item) => String(item.id)}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHdr}>
            <Text style={styles.sectionHdrText}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }) => renderEventRow(item)}
        ListEmptyComponent={<Text style={styles.empty}>No events in this range</Text>}
        stickySectionHeadersEnabled
        refreshControl={listRefreshControl}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => onDismissOverlays?.()}
      />
    </View>
  );
}
