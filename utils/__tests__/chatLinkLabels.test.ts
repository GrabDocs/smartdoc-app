import {
  documentNameFromCitations,
  formatDocumentOpenLinkLabel,
  stripGenericDocumentLinkPrefix,
} from '../chatLinkLabels';

const FILE_URL = 'https://grabdocs.com/api/v1/web/files/42/view';

describe('chatLinkLabels', () => {
  test('strips Open / Open Document wrappers', () => {
    expect(stripGenericDocumentLinkPrefix('Open')).toBe('');
    expect(stripGenericDocumentLinkPrefix('Open Document')).toBe('');
    expect(stripGenericDocumentLinkPrefix('Open Document: Lease.pdf')).toBe('Lease.pdf');
    expect(stripGenericDocumentLinkPrefix('Open Lease.pdf')).toBe('Lease.pdf');
  });

  test('shows citation filename instead of Open Document', () => {
    expect(
      formatDocumentOpenLinkLabel('Open Document', FILE_URL, 'Lease.pdf')
    ).toBe('Lease.pdf');
    expect(
      formatDocumentOpenLinkLabel('Open', FILE_URL, 'Q3 Report.docx')
    ).toBe('Q3 Report.docx');
  });

  test('keeps a real name the model already used', () => {
    expect(formatDocumentOpenLinkLabel('Lease.pdf', FILE_URL)).toBe('Lease.pdf');
  });

  test('does not rewrite non-file links', () => {
    expect(
      formatDocumentOpenLinkLabel('Open', 'https://example.com/docs')
    ).toBe('Open');
  });

  test('resolves name from matching citation document_id', () => {
    expect(
      documentNameFromCitations(FILE_URL, [
        { document_id: 99, filename: 'Other.pdf' },
        { document_id: 42, source_name: 'Lease.pdf' },
      ])
    ).toBe('Lease.pdf');
  });
});
