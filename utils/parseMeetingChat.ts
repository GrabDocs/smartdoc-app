export type MeetingChatMessage = {
  timestamp: string;
  sender: string;
  content: string;
};

export function parseMeetingChat(content?: string | null): MeetingChatMessage[] {
  const raw = (content || '').replace(/\r\n/g, '\n');
  if (!raw.trim()) return [];
  const messages: MeetingChatMessage[] = [];
  let current: MeetingChatMessage | null = null;
  for (const line of raw.split('\n')) {
    if (/^(Meeting Chat Export|Meeting:|Date:|Duration:|Total Messages:|=+)/.test(line)) continue;
    const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+(.+?):\s*(.*)$/);
    if (match) {
      if (current) messages.push(current);
      current = { timestamp: match[1], sender: match[2], content: match[3] };
    } else if (current && line.trim()) {
      current.content += `\n${line}`;
    }
  }
  if (current) messages.push(current);
  return messages;
}

export type MeetingChatSenderStat = {
  sender: string;
  messages: number;
  words: number;
  percent: number;
};

export type MeetingChatSummary = {
  messages: MeetingChatMessage[];
  messageCount: number;
  senderCount: number;
  wordCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  spanLabel: string | null;
  senders: MeetingChatSenderStat[];
};

function clockToSeconds(timestamp: string): number | null {
  const match = timestamp.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatSpan(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes} min`;
  return `${total}s`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function summarizeMeetingChat(content?: string | null): MeetingChatSummary {
  const messages = parseMeetingChat(content);
  const bySender = new Map<string, { messages: number; words: number }>();
  for (const message of messages) {
    const words = wordCount(message.content);
    const row = bySender.get(message.sender) || { messages: 0, words: 0 };
    row.messages += 1;
    row.words += words;
    bySender.set(message.sender, row);
  }
  const senders = Array.from(bySender.entries())
    .map(([sender, row]) => ({ sender, ...row, percent: 0 }))
    .sort((a, b) => b.messages - a.messages);
  const total = senders.reduce((sum, row) => sum + row.messages, 0);
  senders.forEach((row) => {
    row.percent = total ? Math.round((row.messages / total) * 100) : 0;
  });
  const firstTimestamp = messages[0]?.timestamp || null;
  const lastTimestamp = messages[messages.length - 1]?.timestamp || null;
  const start = firstTimestamp ? clockToSeconds(firstTimestamp) : null;
  const end = lastTimestamp ? clockToSeconds(lastTimestamp) : null;
  const spanLabel = start != null && end != null && end >= start ? formatSpan(end - start) : null;
  return {
    messages,
    messageCount: messages.length,
    senderCount: senders.length,
    wordCount: senders.reduce((sum, row) => sum + row.words, 0),
    firstTimestamp,
    lastTimestamp,
    spanLabel,
    senders,
  };
}
