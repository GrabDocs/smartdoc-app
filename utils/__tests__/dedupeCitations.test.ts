import { citationDedupeKey, dedupeCitations } from '../dedupeCitations';

describe('dedupeCitations', () => {
  test('keeps one entry per document for normal docs', () => {
    const out = dedupeCitations([
      { document_id: 10, filename: 'sheet.xlsx', excerpt: 'a' },
      { document_id: 10, filename: 'sheet.xlsx', excerpt: 'b' },
      { document_id: 11, filename: 'other.pdf', excerpt: 'c' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].excerpt).toBe('a');
    expect(out[1].document_id).toBe(11);
  });

  test('keeps separate entries for different paragraph ranges on any doc', () => {
    const out = dedupeCitations([
      { document_id: 5, filename: 'notes.pdf', paragraph_start: 1, paragraph_end: 3 },
      { document_id: 5, filename: 'notes.pdf', paragraph_start: 1, paragraph_end: 3 },
      { document_id: 5, filename: 'notes.pdf', paragraph_start: 10, paragraph_end: 12 },
      { document_id: 5, filename: 'notes.pdf', paragraph: '20' },
    ]);
    expect(out).toHaveLength(3);
    expect(citationDedupeKey(out[0])).toBe('id:5::para:1-3');
    expect(citationDedupeKey(out[1])).toBe('id:5::para:10-12');
    expect(citationDedupeKey(out[2])).toBe('id:5::para:20');
  });

  test('falls back to filename when ids are missing', () => {
    const out = dedupeCitations([
      { filename: 'Notes.txt', excerpt: '1' },
      { source_name: 'Notes.txt', excerpt: '2' },
      { filename: 'Other.txt', excerpt: '3' },
    ]);
    expect(out).toHaveLength(2);
  });
});
