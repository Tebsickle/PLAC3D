import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  CHUNK_SIZE,
  PALETTE,
  STARTING_BATCH_LIMIT,
  WORLD_SIZE,
  chunkKey,
  paletteColor,
  type AuthUser,
  type PaletteId,
  type Placement,
  type ServerMessage,
  type Voxel,
} from '../shared/protocol'

type VoxelMode = PaletteId | 'erase'
const app = document.querySelector<HTMLDivElement>('#app')!
app.setAttribute('aria-busy', 'true')
app.innerHTML = `
  <div class="loading-screen" id="loading-screen">
    <div class="loading-mark">P3</div>
    <p>LOADING WORLD</p>
    <span class="loading-bar"><i></i></span>
  </div>
  <main class="app-shell">
    <section class="workspace">
      <div id="viewport">
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark">P3</span>
            <div><strong>PLAC3D</strong></div>
          </div>
          <div class="connection">
            <span class="status-dot"></span>
            <span id="connection-label">LOCAL PREVIEW</span>
          </div>
        </header>
        <div class="viewport-coordinates">
          <span id="cursor-position">X --- · Y --- · Z ---</span>
        </div>
        <div class="viewport-control-mode">
          <span class="camera-mode-label">CONTROL MODE</span>
          <div class="input-mode-toggle" id="input-mode-toggle" role="group" aria-label="Control mode">
            <span class="input-mode-highlight" aria-hidden="true"></span>
            <button class="input-mode-option is-active" type="button" data-input-mode="mouse" aria-pressed="true">
              MOUSE
            </button>
            <button class="input-mode-option" type="button" data-input-mode="touchpad" aria-pressed="false">
              TOUCHPAD
            </button>
            <button class="input-mode-option" type="button" data-input-mode="mobile" aria-label="Mobile/Phone" aria-pressed="false">
              MOBILE/PHONE
            </button>
          </div>
        </div>
      </div>
      <aside class="control-panel">
        <div class="control-panel-content" id="control-panel-content" aria-hidden="true">
          <div class="account-bar" id="account-bar" hidden>
            <div class="account-details">
              <span>LOGGED IN AS <strong id="account-username"></strong></span>
              <small id="account-progression"></small>
            </div>
            <button id="logout" type="button">LOG OUT</button>
          </div>
          <div class="panel-heading">
          <h1>PLAC3D</h1>
          <p>Click or drag to add voxels!</p>
        </div>
        <div class="rule"></div>
        <div class="control-section">
          <div class="section-label">
            <span>PALETTE</span>
            <span id="mode-label">WHITE</span>
          </div>
          <div class="palette" id="palette"></div>
        </div>
        <div class="control-section pending-section">
          <div class="section-label">
            <span>PENDING VOXELS</span>
            <span id="batch-count">0 / 100</span>
          </div>
          <div class="batch-scroll-frame">
            <div class="batch-list" id="batch-list">
              <span class="empty-state">Click the terrain to queue a voxel.</span>
            </div>
            <span class="scroll-hint">SCROLL ↕</span>
          </div>
        </div>
        <div class="batch-actions">
          <button class="clear-button" id="undo" type="button" disabled>
            UNDO LAST
          </button>
          <button class="clear-button" id="clear" type="button">
            CLEAR PENDING
          </button>
        </div>
        <button class="submit-button" id="submit" type="button" disabled>
          <span class="submit-button-copy">
            <span>SUBMIT BATCH</span>
            <small id="cooldown-value">AVAILABLE TO SUBMIT</small>
          </span>
          <span class="button-arrow">↗</span>
          </button>
        </div>
        <div class="auth-overlay" id="auth-overlay">
          <div class="auth-heading">
            <span class="auth-eyebrow">PLACEMENT ACCESS</span>
            <h2 id="auth-title">Log in to build.</h2>
            <p id="auth-copy">You can explore the world now. An account is required to queue or submit voxels.</p>
          </div>
          <div class="auth-tabs" id="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button class="auth-tab is-active" id="login-tab" type="button" role="tab" aria-selected="true">LOGIN</button>
            <button class="auth-tab" id="register-tab" type="button" role="tab" aria-selected="false">REGISTER</button>
          </div>
          <form class="auth-form" id="login-form">
            <label>
              <span>EMAIL OR USERNAME</span>
              <input name="identity" autocomplete="username" required />
            </label>
            <label>
              <span>PASSWORD</span>
              <input name="password" type="password" autocomplete="current-password" required />
            </label>
            <button class="auth-primary" type="submit">LOG IN <span>↗</span></button>
            <button class="auth-link" id="forgot-password" type="button">FORGOT PASSWORD?</button>
          </form>
          <form class="auth-form" id="register-form" hidden>
            <label>
              <span>EMAIL</span>
              <input name="email" type="email" autocomplete="email" required />
            </label>
            <label>
              <span>USERNAME</span>
              <input name="username" autocomplete="username" required />
            </label>
            <label>
              <span>PASSWORD</span>
              <input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required />
            </label>
            <label>
              <span>CONFIRM PASSWORD</span>
              <input name="confirmPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required />
            </label>
            <p class="auth-deadline">Your confirmation link expires after 30 minutes. If it expires, you will need to refill this form.</p>
            <button class="auth-primary" type="submit">CREATE ACCOUNT <span>↗</span></button>
          </form>
          <form class="auth-form" id="forgot-form" hidden>
            <label>
              <span>ACCOUNT EMAIL</span>
              <input name="email" type="email" autocomplete="email" required />
            </label>
            <p class="auth-deadline">If an account uses this email, its private reset link will expire after 30 minutes.</p>
            <button class="auth-primary" type="submit">SEND RESET LINK <span>↗</span></button>
            <button class="auth-link" type="button" data-back-to-login>← BACK TO LOGIN</button>
          </form>
          <form class="auth-form" id="reset-form" hidden>
            <label>
              <span>NEW PASSWORD</span>
              <input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required />
            </label>
            <label>
              <span>CONFIRM NEW PASSWORD</span>
              <input name="confirmPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required />
            </label>
            <p class="auth-deadline">Submitting a new password signs the account out everywhere.</p>
            <button class="auth-primary" type="submit">CHANGE PASSWORD <span>↗</span></button>
            <button class="auth-link" type="button" data-back-to-login>← CANCEL</button>
          </form>
          <p class="auth-feedback" id="auth-feedback" role="status" aria-live="polite"></p>
        </div>
      </aside>
    </section>
    <footer class="bottom-hint">
      <span data-desktop-hint>WASD MOVE</span>
      <span data-desktop-hint>Z UNDO LAST</span>
      <span data-desktop-hint>E TOGGLE ERASE</span>
      <span id="rotate-hint">RMB ROTATE</span>
      <span id="pan-hint">MMB PAN</span>
      <span id="zoom-hint">WHEEL ZOOM</span>
      <span id="paint-hint">LMB PAINT</span>
    </footer>
  </main>`

const viewport = document.querySelector<HTMLDivElement>('#viewport')!
const paletteElement = document.querySelector<HTMLDivElement>('#palette')!
const batchList = document.querySelector<HTMLDivElement>('#batch-list')!
const batchCount = document.querySelector<HTMLSpanElement>('#batch-count')!
const modeLabel = document.querySelector<HTMLSpanElement>('#mode-label')!
const submitButton = document.querySelector<HTMLButtonElement>('#submit')!
const undoButton = document.querySelector<HTMLButtonElement>('#undo')!
const clearButton = document.querySelector<HTMLButtonElement>('#clear')!
const cooldownValue = document.querySelector<HTMLElement>('#cooldown-value')!
const connectionLabel =
  document.querySelector<HTMLElement>('#connection-label')!
const inputModeToggle = document.querySelector<HTMLDivElement>('#input-mode-toggle')!
const inputModeButtons = inputModeToggle.querySelectorAll<HTMLButtonElement>(
  '.input-mode-option',
)
const rotateHint = document.querySelector<HTMLElement>('#rotate-hint')!
const panHint = document.querySelector<HTMLElement>('#pan-hint')!
const zoomHint = document.querySelector<HTMLElement>('#zoom-hint')!
const paintHint = document.querySelector<HTMLElement>('#paint-hint')!
const desktopHints = document.querySelectorAll<HTMLElement>(
  '[data-desktop-hint]',
)
const cursorPosition = document.querySelector<HTMLElement>('#cursor-position')!
const loadingScreen = document.querySelector<HTMLDivElement>('#loading-screen')!
const controlPanelContent =
  document.querySelector<HTMLDivElement>('#control-panel-content')!
const authOverlay = document.querySelector<HTMLDivElement>('#auth-overlay')!
const authTitle = document.querySelector<HTMLElement>('#auth-title')!
const authCopy = document.querySelector<HTMLElement>('#auth-copy')!
const authTabs = document.querySelector<HTMLDivElement>('#auth-tabs')!
const accountBar = document.querySelector<HTMLDivElement>('#account-bar')!
const accountUsername = document.querySelector<HTMLElement>('#account-username')!
const accountProgression =
  document.querySelector<HTMLElement>('#account-progression')!
const loginTab = document.querySelector<HTMLButtonElement>('#login-tab')!
const registerTab = document.querySelector<HTMLButtonElement>('#register-tab')!
const loginForm = document.querySelector<HTMLFormElement>('#login-form')!
const registerForm = document.querySelector<HTMLFormElement>('#register-form')!
const forgotForm = document.querySelector<HTMLFormElement>('#forgot-form')!
const resetForm = document.querySelector<HTMLFormElement>('#reset-form')!
const authFeedback = document.querySelector<HTMLElement>('#auth-feedback')!
const forgotPasswordButton =
  document.querySelector<HTMLButtonElement>('#forgot-password')!
const logoutButton = document.querySelector<HTMLButtonElement>('#logout')!
const finishLoading = () => {
  app.removeAttribute('aria-busy')
  loadingScreen.classList.add('is-loaded')
  window.setTimeout(() => loadingScreen.remove(), 350)
}

let mode: VoxelMode = 'white'
let lastColor: PaletteId = 'white'
let pending: Placement[] = []
let renderedEraseKey = ''
let cooldownUntil = 0
let socket: WebSocket | null = null
let activeSubmitRequestId: string | null = null
let subscribedChunkSignature = ''
let currentUser: AuthUser | null = null
let batchLimit = STARTING_BATCH_LIMIT
let activeResetToken: string | null = null
const createRequestId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}
const renderAuthState = (user: AuthUser | null) => {
  currentUser = activeResetToken ? null : user
  const isAuthenticated = currentUser !== null
  authOverlay.hidden = isAuthenticated
  controlPanelContent.inert = !isAuthenticated
  controlPanelContent.setAttribute('aria-hidden', String(!isAuthenticated))
  accountBar.hidden = !isAuthenticated
  accountUsername.textContent = currentUser?.username ?? ''
  batchLimit = currentUser?.batchLimit ?? STARTING_BATCH_LIMIT
  accountProgression.textContent = currentUser
    ? currentUser.isMaxLevel
      ? `LEVEL ${currentUser.level} · MAX LEVEL · BATCH ${currentUser.batchLimit}`
      : `LEVEL ${currentUser.level} · ${currentUser.voxelsIntoLevel}/${currentUser.voxelsForNextLevel} VOXELS · BATCH ${currentUser.batchLimit}`
    : ''
  if (!isAuthenticated && pending.length) pending = []
  paintHint.textContent = isAuthenticated
    ? inputMode === 'mobile'
      ? 'TAP PLACE'
      : 'LMB PAINT'
    : 'LOGIN TO PLACE'
  renderBatch()
}
modeLabel.style.color = paletteColor(mode)
const voxels = new Map<string, Voxel>()
const chunkMeshes = new Map<string, THREE.Group>()
const pendingPreviewGroup = new THREE.Group()
const scene = new THREE.Scene()
scene.background = new THREE.Color('#111719')
scene.fog = new THREE.Fog('#111719', 650, 1900)
const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 3000)
camera.position.set(230, 220, 300)
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
viewport.append(renderer.domElement)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, 0, 0)
controls.mouseButtons.LEFT = null
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
controls.touches.ONE = null
controls.touches.TWO = THREE.TOUCH.PAN
type InputMode = 'mouse' | 'touchpad' | 'mobile'
const inputModeStorageKey = 'plac3d-input-mode'
const savedInputMode = localStorage.getItem(inputModeStorageKey)
let inputMode: InputMode =
  savedInputMode === 'touchpad' || savedInputMode === 'mobile'
    ? savedInputMode
    : 'mouse'

const setInputMode = (nextMode: InputMode) => {
  inputMode = nextMode
  localStorage.setItem(inputModeStorageKey, nextMode)
  inputModeToggle.dataset.mode = nextMode
  inputModeButtons.forEach((button) => {
    const isActive = button.dataset.inputMode === nextMode
    button.classList.toggle('is-active', isActive)
    button.setAttribute('aria-pressed', String(isActive))
  })
  controls.touches.ONE = nextMode === 'mouse' ? null : THREE.TOUCH.ROTATE
  controls.touches.TWO =
    nextMode === 'mobile'
      ? THREE.TOUCH.DOLLY_PAN
      : nextMode === 'touchpad'
        ? THREE.TOUCH.DOLLY_ROTATE
        : THREE.TOUCH.PAN
  controls.enableZoom = nextMode !== 'touchpad'
  const isTouchpadMode = nextMode === 'touchpad'
  const isMobileMode = nextMode === 'mobile'
  desktopHints.forEach((hint) => (hint.hidden = isMobileMode))
  rotateHint.textContent = isMobileMode
    ? 'SWIPE ROTATE'
    : isTouchpadMode
      ? 'SCROLL ROTATE'
      : 'RMB ROTATE'
  panHint.textContent = isMobileMode
    ? '2-FINGER PAN'
    : isTouchpadMode
      ? 'SHIFT + 2-FINGER PAN'
      : 'MMB PAN'
  zoomHint.textContent = isMobileMode
    ? 'PINCH ZOOM'
    : isTouchpadMode
      ? 'PINCH ZOOM'
      : 'WHEEL ZOOM'
  paintHint.textContent = currentUser
    ? isMobileMode
      ? 'TAP PLACE'
      : 'LMB PAINT'
    : 'LOGIN TO PLACE'
}
setInputMode(inputMode)
inputModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const nextMode = button.dataset.inputMode as InputMode
    if (nextMode === inputMode) return
    setInputMode(nextMode)
  })
})
type AuthMode = 'login' | 'register' | 'forgot' | 'reset'
const setAuthMode = (nextMode: AuthMode) => {
  const isLogin = nextMode === 'login'
  const isRegister = nextMode === 'register'
  loginTab.classList.toggle('is-active', isLogin)
  registerTab.classList.toggle('is-active', isRegister)
  loginTab.setAttribute('aria-selected', String(isLogin))
  registerTab.setAttribute('aria-selected', String(isRegister))
  authTabs.hidden = !isLogin && !isRegister
  loginForm.hidden = !isLogin
  registerForm.hidden = !isRegister
  forgotForm.hidden = nextMode !== 'forgot'
  resetForm.hidden = nextMode !== 'reset'
  const copy: Record<AuthMode, [string, string]> = {
    login: [
      'Log in to build.',
      'You can explore the world now. An account is required to queue or submit voxels.',
    ],
    register: [
      'Create an account.',
      'Confirm your email within 30 minutes, then return here to log in.',
    ],
    forgot: [
      'Reset your password.',
      'Enter the email attached to your account to request a private reset link.',
    ],
    reset: [
      'Choose a new password.',
      'This private link can be used once and expires after 30 minutes.',
    ],
  }
  ;[authTitle.textContent, authCopy.textContent] = copy[nextMode]
  authFeedback.textContent = ''
}
type SessionResponse = {
  user: AuthUser | null
  cooldownUntil: number
}
type LoginResponse = SessionResponse & { ok: true }
type RegistrationResponse = {
  ok: true
  message: string
  developmentVerificationUrl?: string
}
type ForgotPasswordResponse = {
  ok: true
  message: string
  developmentResetUrl?: string
}
class ApiError extends Error {}
const apiRequest = async <T>(path: string, init?: RequestInit) => {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
  }
  if (!response.ok)
    throw new ApiError(body.error ?? 'The server could not complete the request.')
  return body as T
}
const showAuthFeedback = (
  message: string,
  tone: 'neutral' | 'success' | 'error' = 'neutral',
) => {
  authFeedback.className = `auth-feedback is-${tone}`
  authFeedback.textContent = message
}
const appendDevelopmentLink = (url: string, label: string) => {
  const link = document.createElement('a')
  link.href = url
  link.textContent = label
  authFeedback.append(document.createElement('br'), link)
}
loginTab.addEventListener('click', () => setAuthMode('login'))
registerTab.addEventListener('click', () => setAuthMode('register'))
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = loginForm.querySelector<HTMLButtonElement>('[type="submit"]')!
  const data = new FormData(loginForm)
  submit.disabled = true
  showAuthFeedback('LOGGING IN…')
  try {
    const response = await apiRequest<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        identity: data.get('identity'),
        password: data.get('password'),
      }),
    })
    cooldownUntil = response.cooldownUntil
    renderAuthState(response.user)
    loginForm.reset()
    reconnect()
  } catch (error) {
    showAuthFeedback(
      error instanceof Error ? error.message.toUpperCase() : 'LOGIN FAILED.',
      'error',
    )
  } finally {
    submit.disabled = false
  }
})
registerForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const data = new FormData(registerForm)
  if (data.get('password') !== data.get('confirmPassword')) {
    showAuthFeedback('PASSWORDS DO NOT MATCH.', 'error')
    return
  }
  const submit =
    registerForm.querySelector<HTMLButtonElement>('[type="submit"]')!
  submit.disabled = true
  showAuthFeedback(
    'REGISTRATION RECEIVED. CHECK YOUR EMAIL TO FINISH WITHIN 30 MINUTES.',
    'success',
  )
  try {
    const response = await apiRequest<RegistrationResponse>(
      '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify({
          email: data.get('email'),
          username: data.get('username'),
          password: data.get('password'),
        }),
      },
    )
    registerForm.reset()
    showAuthFeedback(response.message.toUpperCase(), 'success')
    if (response.developmentVerificationUrl)
      appendDevelopmentLink(
        response.developmentVerificationUrl,
        'OPEN DEVELOPMENT CONFIRMATION LINK ↗',
      )
  } catch (error) {
    showAuthFeedback(
      error instanceof Error
        ? error.message.toUpperCase()
        : 'REGISTRATION FAILED.',
      'error',
    )
  } finally {
    submit.disabled = false
  }
})
forgotPasswordButton.addEventListener('click', () => {
  setAuthMode('forgot')
})
document.querySelectorAll<HTMLButtonElement>('[data-back-to-login]').forEach(
  (button) =>
    button.addEventListener('click', () => {
      const wasResetting = !resetForm.hidden
      activeResetToken = null
      setAuthMode('login')
      if (wasResetting) reconnect()
    }),
)
forgotForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = forgotForm.querySelector<HTMLButtonElement>('[type="submit"]')!
  const data = new FormData(forgotForm)
  submit.disabled = true
  showAuthFeedback(
    'IF AN ACCOUNT USES THAT EMAIL, ITS RESET LINK IS ON THE WAY.',
    'success',
  )
  try {
    const response = await apiRequest<ForgotPasswordResponse>(
      '/api/auth/forgot-password',
      {
        method: 'POST',
        body: JSON.stringify({ email: data.get('email') }),
      },
    )
    forgotForm.reset()
    showAuthFeedback(response.message.toUpperCase(), 'success')
    if (response.developmentResetUrl)
      appendDevelopmentLink(
        response.developmentResetUrl,
        'OPEN DEVELOPMENT PASSWORD-RESET LINK ↗',
      )
  } catch (error) {
    showAuthFeedback(
      error instanceof Error
        ? error.message.toUpperCase()
        : 'PASSWORD RECOVERY FAILED.',
      'error',
    )
  } finally {
    submit.disabled = false
  }
})
resetForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const data = new FormData(resetForm)
  if (data.get('password') !== data.get('confirmPassword')) {
    showAuthFeedback('PASSWORDS DO NOT MATCH.', 'error')
    return
  }
  if (!activeResetToken) {
    showAuthFeedback('THIS PASSWORD-RESET LINK IS INVALID.', 'error')
    return
  }
  const submit = resetForm.querySelector<HTMLButtonElement>('[type="submit"]')!
  submit.disabled = true
  showAuthFeedback('CHANGING PASSWORD…')
  try {
    const response = await apiRequest<{ ok: true; message: string }>(
      '/api/auth/reset-password',
      {
        method: 'POST',
        body: JSON.stringify({
          token: activeResetToken,
          password: data.get('password'),
        }),
      },
    )
    activeResetToken = null
    resetForm.reset()
    renderAuthState(null)
    setAuthMode('login')
    showAuthFeedback(response.message.toUpperCase(), 'success')
    reconnect()
  } catch (error) {
    showAuthFeedback(
      error instanceof Error
        ? error.message.toUpperCase()
        : 'PASSWORD RESET FAILED.',
      'error',
    )
  } finally {
    submit.disabled = false
  }
})
logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true
  try {
    await apiRequest<{ ok: true }>('/api/auth/logout', { method: 'POST' })
  } finally {
    logoutButton.disabled = false
    cooldownUntil = 0
    renderAuthState(null)
    reconnect()
  }
})
const authParameters = new URLSearchParams(window.location.search)
const resetTokenFromUrl = authParameters.get('resetToken')
const authResult = authParameters.get('auth')
if (resetTokenFromUrl) {
  activeResetToken = resetTokenFromUrl
  setAuthMode('reset')
  window.history.replaceState({}, '', window.location.pathname)
} else if (authResult) {
  setAuthMode('login')
  const messages: Record<string, [string, 'success' | 'error']> = {
    verified: ['EMAIL CONFIRMED. YOU CAN LOG IN NOW.', 'success'],
    expired: [
      'THAT CONFIRMATION LINK EXPIRED. PLEASE REGISTER AGAIN.',
      'error',
    ],
    invalid: ['THAT CONFIRMATION LINK IS INVALID OR ALREADY USED.', 'error'],
    conflict: [
      'THAT EMAIL OR USERNAME WAS CLAIMED. PLEASE REGISTER AGAIN.',
      'error',
    ],
  }
  const result = messages[authResult]
  if (result) showAuthFeedback(...result)
  window.history.replaceState({}, '', window.location.pathname)
}
renderer.domElement.addEventListener(
  'wheel',
  (event) => {
    if (inputMode !== 'touchpad') return

    event.preventDefault()
    if (event.ctrlKey) {
      const zoomScale = 1 + Math.min(Math.abs(event.deltaY), 100) * 0.01
      if (event.deltaY < 0) controls.dollyOut(zoomScale)
      if (event.deltaY > 0) controls.dollyIn(zoomScale)
      return
    }

    if (event.shiftKey) {
      const panScale = 0.8
      controls.pan(event.deltaX * panScale, event.deltaY * panScale)
      return
    }

    const rotationScale = 0.003
    controls.rotateLeft(event.deltaX * rotationScale)
    controls.rotateUp(event.deltaY * rotationScale)
  },
  { passive: false },
)
const movement = { forward: false, backward: false, left: false, right: false }
type MovementKey = 'w' | 's' | 'a' | 'd'
const movementKeys = new Map<MovementKey, keyof typeof movement>([
  ['w', 'forward'],
  ['s', 'backward'],
  ['a', 'left'],
  ['d', 'right'],
])
window.addEventListener('keydown', (event) => {
  const direction = movementKeys.get(event.key.toLowerCase() as MovementKey)
  if (!direction) return
  movement[direction] = true
  event.preventDefault()
})
window.addEventListener('keyup', (event) => {
  const direction = movementKeys.get(event.key.toLowerCase() as MovementKey)
  if (!direction) return
  movement[direction] = false
  event.preventDefault()
})
renderer.domElement.addEventListener('contextmenu', (event) =>
  event.preventDefault(),
)
scene.add(new THREE.HemisphereLight('#d7e2d1', '#172326', 2.2))
const sun = new THREE.DirectionalLight('#ffe0a3', 3.2)
sun.position.set(-200, 360, 160)
sun.castShadow = true
scene.add(sun)
const grid = new THREE.GridHelper(1000, 50, '#52635b', '#263a38')
grid.position.y = -0.51
scene.add(grid)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1000, 1000),
  new THREE.MeshStandardMaterial({ color: '#172525', roughness: 1 }),
)
ground.rotation.x = -Math.PI / 2
ground.position.y = -0.55
ground.receiveShadow = true
ground.name = 'ground'
scene.add(ground)
scene.add(pendingPreviewGroup)

const rebuildChunk = (key: string) => {
  const previous = chunkMeshes.get(key)
  if (previous) {
    scene.remove(previous)
    previous.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        ;(object.material as THREE.Material).dispose()
      }
    })
  }
  const entries = [...voxels.values()].filter(
    (voxel) => chunkKey(voxel.x, voxel.y, voxel.z) === key,
  )
  if (!entries.length) {
    chunkMeshes.delete(key)
    return
  }
  const group = new THREE.Group()
  const byColor = new Map<PaletteId, Voxel[]>()
  entries.forEach((voxel) =>
    byColor.set(voxel.color, [...(byColor.get(voxel.color) ?? []), voxel]),
  )
  const cube = new THREE.BoxGeometry(0.96, 0.96, 0.96)
  const erasedPositions = new Set(
    pending
      .filter((placement) => placement.color === 'erase')
      .map((placement) => `${placement.x},${placement.y},${placement.z}`),
  )
  for (const [color, items] of byColor) {
    const visibleItems = items.filter(
      (voxel) => !erasedPositions.has(`${voxel.x},${voxel.y},${voxel.z}`),
    )
    if (!visibleItems.length) continue
    const mesh = new THREE.InstancedMesh(
      cube,
      new THREE.MeshStandardMaterial({
        color: paletteColor(color),
        roughness: 0.82,
      }),
      visibleItems.length,
    )
    const matrix = new THREE.Matrix4()
    visibleItems.forEach((voxel, index) => {
      matrix.setPosition(
        voxel.x - WORLD_SIZE / 2 + 0.5,
        voxel.y + 0.5,
        voxel.z - WORLD_SIZE / 2 + 0.5,
      )
      mesh.setMatrixAt(index, matrix)
    })
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  scene.add(group)
  chunkMeshes.set(key, group)
}
const updateVoxel = (voxel: Voxel) => {
  voxels.set(`${voxel.x},${voxel.y},${voxel.z}`, voxel)
  rebuildChunk(chunkKey(voxel.x, voxel.y, voxel.z))
}
const removeVoxel = (position: { x: number; y: number; z: number }) => {
  voxels.delete(`${position.x},${position.y},${position.z}`)
  rebuildChunk(chunkKey(position.x, position.y, position.z))
}
const applyChunkSnapshots = (chunks: Record<string, Voxel[]>) => {
  const chunkEntries = Object.entries(chunks)
  if (!chunkEntries.length) return
  const refreshedKeys = new Set(chunkEntries.map(([key]) => key))
  for (const [key, voxel] of voxels) {
    if (refreshedKeys.has(chunkKey(voxel.x, voxel.y, voxel.z)))
      voxels.delete(key)
  }
  for (const [key, chunkVoxels] of chunkEntries) {
    for (const voxel of chunkVoxels)
      voxels.set(`${voxel.x},${voxel.y},${voxel.z}`, voxel)
    rebuildChunk(key)
  }
}

const rebuildPendingPreview = () => {
  while (pendingPreviewGroup.children.length) {
    const child = pendingPreviewGroup.children.pop()!
    pendingPreviewGroup.remove(child)
    if (child instanceof THREE.InstancedMesh) {
      child.geometry.dispose()
      ;(child.material as THREE.Material).dispose()
    }
  }
  if (!pending.length) return

  const byColor = new Map<Placement['color'], Placement[]>()
  pending.forEach((placement) =>
    byColor.set(placement.color, [
      ...(byColor.get(placement.color) ?? []),
      placement,
    ]),
  )
  const cube = new THREE.BoxGeometry(0.96, 0.96, 0.96)

  for (const [color, placements] of byColor) {
    const tint = color === 'erase' ? '#7b8c86' : paletteColor(color)
    const mesh = new THREE.InstancedMesh(
      cube,
      new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.2,
        metalness: 0.05,
        transparent: true,
        opacity: color === 'erase' ? 0.18 : 0.42,
        depthWrite: false,
      }),
      placements.length,
    )
    const matrix = new THREE.Matrix4()
    placements.forEach((placement, index) => {
      matrix.setPosition(
        placement.x - WORLD_SIZE / 2 + 0.5,
        placement.y + 0.5,
        placement.z - WORLD_SIZE / 2 + 0.5,
      )
      mesh.setMatrixAt(index, matrix)
    })
    pendingPreviewGroup.add(mesh)
  }
}

const renderBatch = () => {
  batchCount.textContent = `${pending.length} / ${batchLimit}`
  submitButton.disabled =
    !currentUser ||
    pending.length === 0 ||
    Date.now() < cooldownUntil ||
    activeSubmitRequestId !== null
  undoButton.disabled = pending.length === 0
  batchList.innerHTML = pending.length
    ? pending
        .map(
          (item, pendingIndex) =>
            `<div class="batch-row">
              <i style="background:${item.color === 'erase' ? '#111719' : paletteColor(item.color)}"></i>
              <span>${item.x}, ${item.y}, ${item.z}</span>
              <b>${item.color.toUpperCase()}</b>
              <button
                class="remove-pending"
                type="button"
                data-index="${pendingIndex}"
                aria-label="Remove voxel ${item.x}, ${item.y}, ${item.z}"
              >×</button>
            </div>`,
        )
        .join('')
    : '<span class="empty-state">Click the terrain to queue a voxel.</span>'
  rebuildPendingPreview()
  const eraseKey = pending
    .filter((placement) => placement.color === 'erase')
    .map((placement) => `${placement.x},${placement.y},${placement.z}`)
    .sort()
    .join('|')
  if (eraseKey !== renderedEraseKey) {
    renderedEraseKey = eraseKey
    ;[...chunkMeshes.keys()].forEach(rebuildChunk)
  }
}
const updateCooldown = () => {
  const remaining = Math.max(0, cooldownUntil - Date.now())
  submitButton.disabled =
    !currentUser ||
    pending.length === 0 ||
    remaining > 0 ||
    activeSubmitRequestId !== null
  cooldownValue.textContent = remaining
    ? `READY IN ${Math.ceil(remaining / 1000)}S`
    : 'AVAILABLE TO SUBMIT'
  submitButton.classList.toggle('is-waiting', remaining > 0)
  renderBatch()
}
window.setInterval(updateCooldown, 1000)

const selectMode = (nextMode: VoxelMode) => {
  mode = nextMode
  if (nextMode !== 'erase') lastColor = nextMode
  modeLabel.textContent =
    nextMode === 'erase' ? 'ERASE' : nextMode.toUpperCase()
  modeLabel.style.color =
    nextMode === 'erase' ? '#dfe7dc' : paletteColor(nextMode)
  document
    .querySelectorAll('.swatch')
    .forEach((item) => item.classList.remove('is-selected'))
  const selected =
    nextMode === 'erase'
      ? erase
      : [...paletteElement.children].find(
          (item) =>
            (item as HTMLButtonElement).title.toLowerCase().replace(' ', '') ===
            nextMode.toLowerCase(),
        )
  selected?.classList.add('is-selected')
}
for (const color of PALETTE) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `swatch ${color.id === mode ? 'is-selected' : ''}`
  button.title = color.label
  button.style.setProperty('--swatch', color.hex)
  button.addEventListener('click', () => selectMode(color.id))
  paletteElement.append(button)
}
const erase = document.createElement('button')
erase.type = 'button'
erase.className = 'swatch erase'
erase.title = 'Erase'
erase.innerHTML = '×'
erase.addEventListener('click', () => selectMode('erase'))
paletteElement.append(erase)
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'e' || event.repeat) return
  selectMode(mode === 'erase' ? lastColor : 'erase')
  event.preventDefault()
})
batchList.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLButtonElement)) return
  const index = Number(target.dataset.index)
  if (!Number.isInteger(index)) return
  pending.splice(index, 1)
  renderBatch()
})
undoButton.addEventListener('click', () => {
  pending.pop()
  renderBatch()
})
clearButton.addEventListener('click', () => {
  pending = []
  renderBatch()
})
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'z') return
  pending.pop()
  renderBatch()
})

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const pick = (
  event: PointerEvent,
  includePendingPreview = true,
  pickMode = mode,
  ignoredPendingKeys = new Set<string>(),
  pendingEraseKeysAtDragStart = new Set<string>(),
  currentDragPlacementKeys = new Set<string>(),
) => {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    (-(event.clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(pointer, camera)
  const voxelTargets = includePendingPreview
    ? [...chunkMeshes.values(), pendingPreviewGroup]
    : [...chunkMeshes.values()]
  let passedFurthestPendingErase = false
  let blockedByCurrentDragErase = false
  const voxelHit = raycaster
    .intersectObjects(voxelTargets, true)
    .find((intersection) => {
      if (
        !includePendingPreview ||
        !ignoredPendingKeys.size
      )
        return true
      const point = intersection.point
        .clone()
        .addScaledVector(intersection.normal!, -0.001)
      const x = Math.max(
        0,
        Math.min(WORLD_SIZE - 1, Math.floor(point.x + WORLD_SIZE / 2)),
      )
      const z = Math.max(
        0,
        Math.min(WORLD_SIZE - 1, Math.floor(point.z + WORLD_SIZE / 2)),
      )
      const y = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.y)))
      const key = `${x},${y},${z}`
      if (!ignoredPendingKeys.has(key)) return !blockedByCurrentDragErase
      if (pendingEraseKeysAtDragStart.has(key))
        passedFurthestPendingErase = true
      else if (
        pickMode === 'erase' &&
        currentDragPlacementKeys.has(key) &&
        (pendingEraseKeysAtDragStart.size === 0 || passedFurthestPendingErase)
      ) {
        blockedByCurrentDragErase = true
      }
      return false
    })
  const hit = voxelHit ?? raycaster.intersectObject(ground)[0]
  if (!hit) return
  const point = voxelHit
    ? hit.point
        .clone()
        .addScaledVector(hit.normal!, pickMode === 'erase' ? -0.001 : 0.05)
    : hit.point
  const x = Math.max(
    0,
    Math.min(WORLD_SIZE - 1, Math.floor(point.x + WORLD_SIZE / 2)),
  )
  const z = Math.max(
    0,
    Math.min(WORLD_SIZE - 1, Math.floor(point.z + WORLD_SIZE / 2)),
  )
  const y = voxelHit
    ? Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.y)))
    : 0
  cursorPosition.textContent = `X ${String(x).padStart(3, '0')} · Y ${String(y).padStart(3, '0')} · Z ${String(z).padStart(3, '0')}`
  return { x, y, z }
}
const queuePlacement = (
  position: { x: number; y: number; z: number },
  color: VoxelMode,
) => {
  if (!currentUser) return false
  const key = `${position.x},${position.y},${position.z}`
  const existingIndex = pending.findIndex(
    (item) =>
      item.x === position.x && item.y === position.y && item.z === position.z,
  )
  if (color === 'erase') {
    if (existingIndex >= 0) {
      if (pending[existingIndex].color !== 'erase') {
        pending.splice(existingIndex, 1)
        renderBatch()
        return true
      }
      return false
    }
    if (!voxels.has(key)) return false
  }
  if (pending.length >= batchLimit || existingIndex >= 0) return false
  pending.push({ ...position, color })
  renderBatch()
  return true
}
const dragThreshold = 6
let activePointerId: number | null = null
let pointerDownPosition = { x: 0, y: 0 }
let dragMode: VoxelMode = mode
let isDragging = false
let suppressNextClick = false
let dragPlacementKeys = new Set<string>()
let pendingEraseKeysAtDragStart = new Set<string>()
const mobileTouchPointers = new Map<number, { x: number; y: number }>()
let mobileTouchGestureMoved = false
const queuePlacementAtPointer = (event: PointerEvent) => {
  if (!currentUser) return
  const ignoredPendingKeys =
    mode === 'erase'
      ? new Set(
          pending.map(
            (placement) => `${placement.x},${placement.y},${placement.z}`,
          ),
        )
      : undefined
  const position = pick(event, true, mode, ignoredPendingKeys)
  if (position) queuePlacement(position, mode)
}
const resetPointerGesture = () => {
  activePointerId = null
  isDragging = false
  dragMode = mode
  pendingEraseKeysAtDragStart = new Set()
}
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (inputMode === 'mobile' && event.pointerType === 'touch') {
    if (mobileTouchPointers.size === 0) {
      mobileTouchGestureMoved = false
      suppressNextClick = false
    }
    mobileTouchPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    })
    if (mobileTouchPointers.size > 1) mobileTouchGestureMoved = true
    return
  }
  if (event.button !== 0 || activePointerId !== null) return
  activePointerId = event.pointerId
  pointerDownPosition = { x: event.clientX, y: event.clientY }
  dragMode = mode
  isDragging = false
  dragPlacementKeys = new Set()
  pendingEraseKeysAtDragStart = new Set(
    pending
      .filter((placement) => placement.color === 'erase')
      .map((placement) => `${placement.x},${placement.y},${placement.z}`),
  )
  suppressNextClick = false
  renderer.domElement.setPointerCapture(event.pointerId)
})
renderer.domElement.addEventListener('pointermove', (event) => {
  if (inputMode === 'mobile' && event.pointerType === 'touch') {
    const start = mobileTouchPointers.get(event.pointerId)
    if (
      start &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >=
        dragThreshold
    )
      mobileTouchGestureMoved = true
    return
  }
  if (activePointerId !== event.pointerId) {
    pick(event)
    return
  }
  if (
    !isDragging &&
    Math.hypot(
      event.clientX - pointerDownPosition.x,
      event.clientY - pointerDownPosition.y,
    ) >= dragThreshold
  ) {
    isDragging = true
    suppressNextClick = true
  }
  if (isDragging) {
    const position = pick(
      event,
      true,
      dragMode,
      new Set(
        pending
          .filter(
            (placement) =>
              (dragMode === 'erase' && placement.color === 'erase') ||
              dragPlacementKeys.has(
                `${placement.x},${placement.y},${placement.z}`,
              ),
          )
          .map((placement) => `${placement.x},${placement.y},${placement.z}`),
      ),
        pendingEraseKeysAtDragStart,
        dragPlacementKeys,
    )
    if (position) {
      if (queuePlacement(position, dragMode))
        dragPlacementKeys.add(`${position.x},${position.y},${position.z}`)
    }
    return
  }
  pick(event)
})
renderer.domElement.addEventListener('pointerup', (event) => {
  if (inputMode === 'mobile' && event.pointerType === 'touch') {
    const start = mobileTouchPointers.get(event.pointerId)
    if (
      start &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >=
        dragThreshold
    )
      mobileTouchGestureMoved = true
    mobileTouchPointers.delete(event.pointerId)
    if (mobileTouchPointers.size === 0) {
      suppressNextClick = true
      if (!mobileTouchGestureMoved) queuePlacementAtPointer(event)
    }
    return
  }
  if (activePointerId !== event.pointerId) return
  if (isDragging) {
    const position = pick(
      event,
      true,
      dragMode,
      new Set(
        pending
          .filter(
            (placement) =>
              (dragMode === 'erase' && placement.color === 'erase') ||
              dragPlacementKeys.has(
                `${placement.x},${placement.y},${placement.z}`,
              ),
          )
          .map((placement) => `${placement.x},${placement.y},${placement.z}`),
      ),
        pendingEraseKeysAtDragStart,
        dragPlacementKeys,
    )
    if (position) {
      if (queuePlacement(position, dragMode))
        dragPlacementKeys.add(`${position.x},${position.y},${position.z}`)
    }
  }
  if (renderer.domElement.hasPointerCapture(event.pointerId))
    renderer.domElement.releasePointerCapture(event.pointerId)
  resetPointerGesture()
})
renderer.domElement.addEventListener('pointercancel', (event) => {
  if (inputMode === 'mobile' && event.pointerType === 'touch') {
    mobileTouchPointers.delete(event.pointerId)
    mobileTouchGestureMoved = true
    suppressNextClick = true
    return
  }
  resetPointerGesture()
})
renderer.domElement.addEventListener('lostpointercapture', (event) => {
  if (inputMode !== 'mobile' || event.pointerType !== 'touch')
    resetPointerGesture()
})
renderer.domElement.addEventListener('click', (event) => {
  if (event.button !== 0 || suppressNextClick) {
    suppressNextClick = false
    return
  }
  queuePlacementAtPointer(event)
})
submitButton.addEventListener('click', () => {
  if (
    !currentUser ||
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    !pending.length ||
    activeSubmitRequestId !== null
  ) {
    cooldownValue.textContent = 'SERVER OFFLINE'
    return
  }
  const requestId = createRequestId()
  activeSubmitRequestId = requestId
  socket.send(
    JSON.stringify({
      type: 'place',
      requestId,
      placements: pending,
    }),
  )
  submitButton.disabled = true
})

const subscribeAroundCameraTarget = () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  const chunkCount = Math.ceil(WORLD_SIZE / CHUNK_SIZE)
  const horizontalSpan = 8
  const verticalSpan = 4
  const targetChunkX = Math.floor(
    THREE.MathUtils.clamp(
      controls.target.x + WORLD_SIZE / 2,
      0,
      WORLD_SIZE - 1,
    ) / CHUNK_SIZE,
  )
  const targetChunkY = Math.floor(
    THREE.MathUtils.clamp(controls.target.y, 0, WORLD_SIZE - 1) / CHUNK_SIZE,
  )
  const targetChunkZ = Math.floor(
    THREE.MathUtils.clamp(
      controls.target.z + WORLD_SIZE / 2,
      0,
      WORLD_SIZE - 1,
    ) / CHUNK_SIZE,
  )
  const startX = THREE.MathUtils.clamp(
    targetChunkX - Math.floor(horizontalSpan / 2),
    0,
    chunkCount - horizontalSpan,
  )
  const startY = THREE.MathUtils.clamp(
    targetChunkY - 1,
    0,
    chunkCount - verticalSpan,
  )
  const startZ = THREE.MathUtils.clamp(
    targetChunkZ - Math.floor(horizontalSpan / 2),
    0,
    chunkCount - horizontalSpan,
  )
  const signature = `${startX},${startY},${startZ}`
  if (signature === subscribedChunkSignature) return
  subscribedChunkSignature = signature
  const chunks: string[] = []
  for (let x = startX; x < startX + horizontalSpan; x += 1)
    for (let y = startY; y < startY + verticalSpan; y += 1)
      for (let z = startZ; z < startZ + horizontalSpan; z += 1)
        chunks.push(`${x},${y},${z}`)
  socket.send(JSON.stringify({ type: 'subscribe', chunks }))
}

let connectionVersion = 0
const refreshSessionFromServer = async () => {
  const session = await apiRequest<SessionResponse>('/api/auth/session')
  cooldownUntil = session.cooldownUntil
  renderAuthState(session.user)
  return session
}
const connect = async () => {
  const version = ++connectionVersion
  try {
    await refreshSessionFromServer()
  } catch {
    renderAuthState(null)
  }
  if (version !== connectionVersion) return
  const websocketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const defaultWebsocketUrl = `${websocketProtocol}//${window.location.host}/ws`
  const websocketUrl = import.meta.env.VITE_WS_URL ?? defaultWebsocketUrl
  const connection = new WebSocket(websocketUrl)
  socket = connection
  connection.addEventListener('open', () => {
    if (socket !== connection) return
    connectionLabel.textContent = 'LIVE WORLD'
    document.querySelector('.status-dot')?.classList.add('is-live')
    connection.send(
      JSON.stringify({
        type: 'hello',
        token: localStorage.getItem('plac3d-token') ?? undefined,
      }),
    )
  })
  connection.addEventListener('message', (event) => {
    if (socket !== connection) return
    const message = JSON.parse(event.data) as ServerMessage
    if (message.type === 'hello') {
      localStorage.setItem('plac3d-token', message.token)
      cooldownUntil = message.cooldownUntil
      renderAuthState(message.user)
      subscribedChunkSignature = ''
      subscribeAroundCameraTarget()
    }
    if (message.type === 'chunks') {
      applyChunkSnapshots(message.chunks)
      finishLoading()
    }
    if (message.type === 'updates') {
      message.voxels.forEach(updateVoxel)
      message.erased.forEach(removeVoxel)
    }
    if (message.type === 'placed') {
      if (message.requestId !== activeSubmitRequestId) return
      message.voxels.forEach(updateVoxel)
      message.erased.forEach(removeVoxel)
      cooldownUntil = message.cooldownUntil
      activeSubmitRequestId = null
      pending = []
      renderBatch()
      void refreshSessionFromServer().catch(() => undefined)
    }
    if (message.type === 'error') {
      if (
        message.requestId &&
        activeSubmitRequestId &&
        message.requestId !== activeSubmitRequestId
      )
        return
      if (message.requestId === activeSubmitRequestId)
        activeSubmitRequestId = null
      cooldownUntil = message.cooldownUntil ?? cooldownUntil
      if (message.code === 'AUTH_REQUIRED') renderAuthState(null)
      cooldownValue.textContent = message.message.toUpperCase()
      renderBatch()
    }
  })
  connection.addEventListener('close', () => {
    if (socket !== connection) return
    activeSubmitRequestId = null
    subscribedChunkSignature = ''
    connectionLabel.textContent = 'LOCAL PREVIEW'
    document.querySelector('.status-dot')?.classList.remove('is-live')
  })
}
const reconnect = () => {
  connectionVersion += 1
  const previous = socket
  socket = null
  previous?.close()
  void connect()
}
void connect()

const resize = () => {
  const width = viewport.clientWidth
  const height = viewport.clientHeight
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height, false)
}
window.addEventListener('resize', resize)
resize()
const animate = () => {
  requestAnimationFrame(animate)
  const forward = new THREE.Vector3()
  camera.getWorldDirection(forward)
  forward.y = 0
  forward.normalize()
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
  const direction = new THREE.Vector3()
  if (movement.forward) direction.add(forward)
  if (movement.backward) direction.sub(forward)
  if (movement.right) direction.add(right)
  if (movement.left) direction.sub(right)
  if (direction.lengthSq()) {
    const movementSpeed = THREE.MathUtils.clamp(
      camera.position.distanceTo(controls.target) * 0.01,
      0.5,
      12,
    )
    direction.normalize().multiplyScalar(movementSpeed)
    camera.position.add(direction)
    controls.target.add(direction)
  }
  controls.update()
  subscribeAroundCameraTarget()
  renderer.render(scene, camera)
}
animate()
renderAuthState(null)
