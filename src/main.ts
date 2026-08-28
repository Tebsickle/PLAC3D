import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  CHUNK_SIZE,
  MAX_BATCH_SIZE,
  PALETTE,
  WORLD_SIZE,
  chunkKey,
  paletteColor,
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
      </div>
      <aside class="control-panel">
        <div class="panel-heading">
          <span class="camera-mode-label">CONTROL MODE</span>
          <div class="input-mode-toggle" id="input-mode-toggle" role="group" aria-label="Input mode">
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
        <div class="control-section">
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
        <button class="submit-button" id="submit" type="button" disabled>
          <span>SUBMIT BATCH</span>
          <span class="button-arrow">↗</span>
        </button>
        <div class="batch-actions">
          <button class="clear-button" id="undo" type="button" disabled>
            UNDO LAST
          </button>
          <button class="clear-button" id="clear" type="button">
            CLEAR PENDING
          </button>
        </div>
        <div class="cooldown" id="cooldown">
          <span class="cooldown-label">READY TO PLACE</span>
          <strong id="cooldown-value">AVAILABLE TO SUBMIT</strong>
        </div>
        <div class="panel-footer">
          <span id="cursor-position">X --- · Y --- · Z ---</span>
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
const createRequestId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
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
  paintHint.textContent = isMobileMode ? 'TAP PLACE' : 'LMB PAINT'
}
setInputMode(inputMode)
inputModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const nextMode = button.dataset.inputMode as InputMode
    if (nextMode === inputMode) return
    setInputMode(nextMode)
  })
})
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
  batchCount.textContent = `${pending.length} / ${MAX_BATCH_SIZE}`
  submitButton.disabled =
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
    pending.length === 0 || remaining > 0 || activeSubmitRequestId !== null
  cooldownValue.textContent = remaining
    ? `READY IN ${Math.ceil(remaining / 1000)}S`
    : 'AVAILABLE TO SUBMIT'
  if (remaining)
    document.querySelector('#cooldown')!.classList.add('is-waiting')
  else document.querySelector('#cooldown')!.classList.remove('is-waiting')
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
  if (pending.length >= MAX_BATCH_SIZE || existingIndex >= 0) return false
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

const connect = () => {
  const websocketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const defaultWebsocketUrl = `${websocketProtocol}//${window.location.host}/ws`
  const websocketUrl = import.meta.env.VITE_WS_URL ?? defaultWebsocketUrl
  socket = new WebSocket(websocketUrl)
  socket.addEventListener('open', () => {
    connectionLabel.textContent = 'LIVE WORLD'
    document.querySelector('.status-dot')?.classList.add('is-live')
    socket?.send(
      JSON.stringify({
        type: 'hello',
        token: localStorage.getItem('plac3d-token') ?? undefined,
      }),
    )
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data) as ServerMessage
    if (message.type === 'hello') {
      localStorage.setItem('plac3d-token', message.token)
      cooldownUntil = message.cooldownUntil
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
      cooldownValue.textContent = message.message.toUpperCase()
      renderBatch()
    }
  })
  socket.addEventListener('close', () => {
    activeSubmitRequestId = null
    subscribedChunkSignature = ''
    connectionLabel.textContent = 'LOCAL PREVIEW'
    document.querySelector('.status-dot')?.classList.remove('is-live')
  })
}
connect()

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
renderBatch()
