/** Locale namespace for the selection-driven quote reply overlay. */
export const QR_NS = 'settings.oac.quoteReply'

export const qrEn = {
  action: 'Quote this passage',
  chipLabelExcerpt: '“{excerpt}”',
  chipLabelFallback: 'Quoted passage',
  insertFailed: 'The draft changed — please try again.',
  source: 'Quoted {role} message{streaming}:',
  roleUser: 'user',
  roleBot: 'bot',
  streamingMark: ' · still being generated',
  truncatedNote: '(excerpt truncated; {omitted} characters omitted)',
}

export const qrZh = {
  action: '引用此段',
  chipLabelExcerpt: '「{excerpt}」',
  chipLabelFallback: '引文',
  insertFailed: '草稿已变，请重试',
  source: '引用{role}消息{streaming}：',
  roleUser: '用户',
  roleBot: 'bot',
  streamingMark: ' · 该条仍在生成中',
  truncatedNote: '（摘录已截断，省略 {omitted} 字）',
}

export type QuoteReplyLocaleKey = keyof typeof qrEn
