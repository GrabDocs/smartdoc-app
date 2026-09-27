import { computeTalkTime, parseMeetingTranscript } from '../parseMeetingTranscript';
import { PLAIN_SPEAKER_SAMPLE, SRT_SAMPLE, VTT_SAMPLE } from '../meetingRecap.fixtures';

describe('parseMeetingTranscript', () => {
  test('parses VTT speakers and timestamps', () => {
    const parsed = parseMeetingTranscript(VTT_SAMPLE);
    expect(parsed.speakers).toEqual(['Francis', 'Ada']);
    expect(parsed.turns[0].startSeconds).toBe(0);
    expect(parsed.turns[1].speaker).toBe('Ada');
  });

  test('parses SRT cues', () => {
    const parsed = parseMeetingTranscript(SRT_SAMPLE);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[1].startSeconds).toBe(3);
  });

  test('parses plain speaker lines without timestamps', () => {
    const parsed = parseMeetingTranscript(PLAIN_SPEAKER_SAMPLE);
    expect(parsed.turns[0].startSeconds).toBeNull();
    expect(parsed.turns[1].text).toMatch(/more from Ada/);
  });

  test('garbage input becomes one Transcript turn', () => {
    const parsed = parseMeetingTranscript('??? ###');
    expect(parsed.speakers).toEqual(['Transcript']);
    expect(parsed.turns[0].text).toBe('??? ###');
  });

  test('talk time uses meeting duration for the last turn', () => {
    const parsed = parseMeetingTranscript(VTT_SAMPLE);
    const talk = computeTalkTime(parsed.turns, 12);
    expect(talk.find((row) => row.speaker === 'Francis')?.seconds).toBe(4);
    expect(talk.find((row) => row.speaker === 'Ada')?.seconds).toBe(8);
    expect(talk.reduce((sum, row) => sum + row.percent, 0)).toBe(100);
  });
});
