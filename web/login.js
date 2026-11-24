const form = document.querySelector('#login-form')
const error = document.querySelector('#login-error')

function showError(message) {
  error.hidden = !message
  error.textContent = message || ''
}

/** 只接受站内相对路径，防止 ?next=//evil.com 这样的开放跳转。 */
function nextTarget() {
  const raw = new URLSearchParams(window.location.search).get('next') || '/'
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
}

fetch('/api/auth/me', { credentials: 'same-origin' })
  .then((response) => {
    if (response.ok) window.location.replace(nextTarget())
  })
  .catch(() => undefined)

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError('')
  const button = form.querySelector('button[type="submit"]')
  button.disabled = true
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.elements.namedItem('username').value,
        password: form.elements.namedItem('password').value,
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || `登录失败 ${response.status}`)
    window.location.replace(nextTarget())
  } catch (problem) {
    showError(problem.message || '登录失败')
    button.disabled = false
  }
})