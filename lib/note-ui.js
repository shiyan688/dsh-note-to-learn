import { t } from './i18n.js'
export function element(tag, options = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(options)) {
    if (value == null) continue
    if (key === 'className' || key === 'textContent' || key === 'value' || key === 'checked' || key === 'disabled') node[key] = value
    else node.setAttribute(key, value)
  }
  node.append(...children.filter(child => child != null))
  return node
}

export function button(text, action, options = {}) {
  const node = element('button', { type: 'button', ...options }, text)
  node.addEventListener('click', action)
  return node
}

export function pickFile(accept, multiple = false) {
  return new Promise(resolve => {
    const input = element('input', { type: 'file', accept })
    input.multiple = multiple
    input.hidden = true
    const finish = files => { input.remove(); resolve(files) }
    input.addEventListener('change', () => finish(Array.from(input.files)), { once: true })
    input.addEventListener('cancel', () => finish([]), { once: true })
    document.body.append(input)
    input.click()
  })
}

export function openDialog(title, render) {
  return new Promise(resolve => {
    const dialog = element('dialog', { className: 'ntl-dialog', 'aria-label': title })
    const body = element('div', { className: 'ntl-dialog-content' })
    const actions = element('div', { className: 'ntl-dialog-actions' })
    let value
    const leave = result => { value = result; dialog.close() }
    dialog.addEventListener('close', () => { dialog.remove(); resolve(value) }, { once: true })
    dialog.append(element('h2', {}, title), body, actions)
    render({ body, actions, leave })
    document.body.append(dialog)
    dialog.showModal()
  })
}

export function inputDialog(title, label, initial = '') {
  return openDialog(title, ({ body, actions, leave }) => {
    const input = element('input', { type: 'text', value: initial, maxlength: 160, autofocus: '' })
    const form = element('form', {}, element('label', {}, label, input))
    form.addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) leave(input.value.trim()) })
    body.append(form)
    actions.append(button(t('取消'), () => leave()), button(t('确定'), () => form.requestSubmit(), { className: 'ntl-primary' }))
  })
}

export function chooseDialog(title, label, options) {
  return openDialog(title, ({ body, actions, leave }) => {
    const select = element('select', { autofocus: '' }, ...options.map(([id, text]) => element('option', { value: id }, text)))
    body.append(element('label', {}, label, select))
    actions.append(button(t('取消'), () => leave()), button(t('确定'), () => leave(select.value), { className: 'ntl-primary' }))
  })
}

export function confirmDialog(title, description, confirmText) {
  return openDialog(title, ({ body, actions, leave }) => {
    body.append(element('p', {}, description))
    actions.append(button(t('取消'), () => leave(false)), button(confirmText, () => leave(true), { className: 'ntl-primary' }))
  })
}

export function toast(message, isError = false) {
  const item = element('div', { className: `ntl-toast${isError ? ' ntl-toast-error' : ''}`, role: isError ? 'alert' : 'status' }, message)
  document.body.append(item)
  setTimeout(() => item.remove(), 5000)
}
