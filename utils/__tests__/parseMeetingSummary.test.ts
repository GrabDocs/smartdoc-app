import { classifySummaryTitle, parseMeetingSummary } from '../parseMeetingSummary';
import { HMS_FIVE_SECTION_SUMMARY } from '../meetingRecap.fixtures';

describe('parseMeetingSummary', () => {
  test('maps the real 100ms five-section fixture', () => {
    const parsed = parseMeetingSummary(HMS_FIVE_SECTION_SUMMARY);
    expect(parsed.sections.map((s) => s.kind)).toEqual([
      'speakers',
      'agenda',
      'key_points',
      'action_items',
      'overview',
    ]);
    expect(parsed.sections[4].format).toBe('paragraph');
  });

  test('keeps unknown titles as generic cards', () => {
    const parsed = parseMeetingSummary(
      JSON.stringify({ sections: [{ title: 'Parking Lot', content: ['Hold'] }] })
    );
    expect(parsed.sections[0].kind).toBe('generic');
    expect(parsed.sections[0].bullets).toEqual(['Hold']);
  });

  test('aliases short summary', () => {
    expect(classifySummaryTitle('Short Summary')).toBe('overview');
  });

  test('aliases follow-up', () => {
    expect(classifySummaryTitle('Follow-up')).toBe('follow_up');
    expect(classifySummaryTitle('Followup')).toBe('follow_up');
  });
});
