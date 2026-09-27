export const HMS_FIVE_SECTION_SUMMARY = JSON.stringify({
  sections: [
    { title: 'Speakers', format: 'bullets', bullets: ['Francis', 'Ada'] },
    { title: 'Agenda', format: 'bullets', bullets: ['Kickoff', 'Budget'] },
    { title: 'Key Points', format: 'bullets', bullets: ['Ship recap v1'] },
    { title: 'Action Items', format: 'bullets', bullets: ['Francis: write parsers'] },
    { title: 'Short Summary', format: 'paragraph', paragraph: 'The team agreed to ship the recap viewer first.' },
  ],
});

export const VTT_SAMPLE = `WEBVTT

00:00:00.000 --> 00:00:04.000
Francis: Welcome everyone

00:00:04.000 --> 00:00:09.000
<v Ada>Thanks for joining
`;

export const SRT_SAMPLE = `1
00:00:00,000 --> 00:00:03,000
Francis: Hello

2
00:00:03,000 --> 00:00:07,000
Ada: Hi there
`;

export const PLAIN_SPEAKER_SAMPLE = `Francis: Let's start
Ada: Sounds good
more from Ada
`;
