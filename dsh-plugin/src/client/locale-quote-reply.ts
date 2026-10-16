/** Locale namespace for the selection-driven quote reply overlay. */
export const QR_NS = 'settings.oac.quoteReply'

export const qrEn = {
  action: 'Quote this passage',
  barTitle: 'Quote',
  cancel: 'Cancel',
  retry: 'Retry',
  insertFailed: 'The draft changed — please try again.',
  source: 'Quoted {role} message (#{position}{streaming}):',
  roleUser: 'user',
  roleAssistant: 'assistant',
  streamingMark: ' · still being generated',
  truncatedNote: '(excerpt truncated; {omitted} characters omitted)',
}

export const qrZh = {
  action: '引用此段',
  barTitle: '引用',
  cancel: '取消',
  retry: '重试',
  insertFailed: '草稿已变，请重试',
  source: '引用{role}消息（第 {position} 条{streaming}）：',
  roleUser: '用户',
  roleAssistant: '助手',
  streamingMark: ' · 该条仍在生成中',
  truncatedNote: '（摘录已截断，省略 {omitted} 字）',
}

export type QuoteReplyLocaleKey = keyof typeof qrEn
