import english from './messages.en.js'

const storageKey = 'dsh-note-to-learn:language'
const subscribers = new Set()
let language = 'zh-CN'
try {
  if (globalThis.window?.localStorage?.getItem(storageKey) === 'en') language = 'en'
} catch { /* The window can still use a language without persistent storage. */ }

export const getLanguage = () => language

export function subscribeLanguage(listener) {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

export function setLanguage(value) {
  if ((value !== 'en' && value !== 'zh-CN') || value === language) return
  language = value
  try { globalThis.window?.localStorage?.setItem(storageKey, value) } catch { /* Keep the current window usable. */ }
  for (const listener of subscribers) listener()
}

export function t(message, ...values) {
  const text = language === 'en' && Object.hasOwn(english, message) ? english[message] : message
  return values.length ? text.replace(/\{(\d+)\}/gu, (token, index) => values[index] ?? token) : text
}
