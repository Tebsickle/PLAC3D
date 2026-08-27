import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MAX_BATCH_SIZE, PALETTE, WORLD_SIZE, chunkKey, paletteColor, type PaletteId, type Placement, type ServerMessage, type Voxel } from '../shared/protocol'

type VoxelMode = PaletteId | 'erase'
const app = document.querySelector<HTMLDivElement>('#app')!
app.setAttribute('aria-busy', 'true')
app.innerHTML = `<div class="loading-screen" id="loading-screen"><div class="loading-mark">P3</div><p>LOADING WORLD</p><span class="loading-bar"><i></i></span></div><main class="app-shell">
  <header class="topbar"><div class="brand"><span class="brand-mark">P3</span><div><strong>PLAC3D</strong></div></div><div class="connection"><span class="status-dot"></span><span id="connection-label">LOCAL PREVIEW</span></div></header>
  <section class="workspace"><div id="viewport"></div><aside class="control-panel">
    <div class="panel-heading"><span class="eyebrow">BUILD MODE</span><h1>PLAC3D</h1><p>Click or drag to add voxels!</p></div>
    <div class="rule"></div><div class="control-section"><div class="section-label"><span>PALETTE</span><span id="mode-label">WHITE</span></div><div class="palette" id="palette"></div></div>
    <div class="control-section"><div class="section-label"><span>PENDING VOXELS</span><span id="batch-count">0 / 100</span></div><div class="batch-scroll-frame"><div class="batch-list" id="batch-list"><span class="empty-state">Click the terrain to queue a voxel.</span></div><span class="scroll-hint">SCROLL ↕</span></div></div>
    <button class="submit-button" id="submit" type="button" disabled><span>SUBMIT BATCH</span><span class="button-arrow">↗</span></button><div class="batch-actions"><button class="clear-button" id="undo" type="button" disabled>UNDO LAST</button><button class="clear-button" id="clear" type="button">CLEAR PENDING</button></div>
    <div class="cooldown" id="cooldown"><span class="cooldown-label">READY TO PLACE</span><strong id="cooldown-value">AVAILABLE TO SUBMIT</strong></div>
    <div class="panel-footer"><span id="cursor-position">X --- · Y --- · Z ---</span></div>
  </aside></section><footer class="bottom-hint"><span>WASD MOVE</span><span>Z UNDO LAST</span><span>E TOGGLE ERASE</span><span>RMB ROTATE</span><span>MMB PAN</span><span>WHEEL ZOOM</span><span>LMB PAINT</span></footer>
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
const connectionLabel = document.querySelector<HTMLElement>('#connection-label')!
const cursorPosition = document.querySelector<HTMLElement>('#cursor-position')!
const loadingScreen = document.querySelector<HTMLDivElement>('#loading-screen')!
const finishLoading = () => { app.removeAttribute('aria-busy'); loadingScreen.classList.add('is-loaded'); window.setTimeout(() => loadingScreen.remove(), 350) }

let mode: VoxelMode = 'white'
let lastColor: PaletteId = 'white'
let pending: Placement[] = []
let renderedEraseKey = ''
let cooldownUntil = 0
let socket: WebSocket | null = null
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
const movement = { forward: false, backward: false, left: false, right: false }
type MovementKey = 'w' | 's' | 'a' | 'd'
const movementKeys = new Map<MovementKey, keyof typeof movement>([['w', 'forward'], ['s', 'backward'], ['a', 'left'], ['d', 'right']])
window.addEventListener('keydown', (event) => { const direction = movementKeys.get(event.key.toLowerCase() as MovementKey); if (!direction) return; movement[direction] = true; event.preventDefault() })
window.addEventListener('keyup', (event) => { const direction = movementKeys.get(event.key.toLowerCase() as MovementKey); if (!direction) return; movement[direction] = false; event.preventDefault() })
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault())
scene.add(new THREE.HemisphereLight('#d7e2d1', '#172326', 2.2))
const sun = new THREE.DirectionalLight('#ffe0a3', 3.2)
sun.position.set(-200, 360, 160); sun.castShadow = true; scene.add(sun)
const grid = new THREE.GridHelper(1000, 50, '#52635b', '#263a38')
grid.position.y = -0.51; scene.add(grid)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshStandardMaterial({ color: '#172525', roughness: 1 }))
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.55; ground.receiveShadow = true; ground.name = 'ground'; scene.add(ground)
scene.add(pendingPreviewGroup)

const rebuildChunk = (key: string) => {
  const previous = chunkMeshes.get(key); if (previous) { scene.remove(previous); previous.traverse((object) => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose() } }) }
  const group = new THREE.Group(); const entries = [...voxels.values()].filter((voxel) => chunkKey(voxel.x, voxel.y, voxel.z) === key)
  const byColor = new Map<PaletteId, Voxel[]>()
  entries.forEach((voxel) => byColor.set(voxel.color, [...(byColor.get(voxel.color) ?? []), voxel]))
  const cube = new THREE.BoxGeometry(0.96, 0.96, 0.96)
  const erasedPositions = new Set(pending.filter((placement) => placement.color === 'erase').map((placement) => `${placement.x},${placement.y},${placement.z}`))
  for (const [color, items] of byColor) { const visibleItems = items.filter((voxel) => !erasedPositions.has(`${voxel.x},${voxel.y},${voxel.z}`)); if (!visibleItems.length) continue; const mesh = new THREE.InstancedMesh(cube, new THREE.MeshStandardMaterial({ color: paletteColor(color), roughness: 0.82 }), visibleItems.length); const matrix = new THREE.Matrix4(); visibleItems.forEach((voxel, index) => { matrix.setPosition(voxel.x - WORLD_SIZE / 2 + 0.5, voxel.y + 0.5, voxel.z - WORLD_SIZE / 2 + 0.5); mesh.setMatrixAt(index, matrix) }); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh) }
  scene.add(group); chunkMeshes.set(key, group)
}
const updateVoxel = (voxel: Voxel) => { voxels.set(`${voxel.x},${voxel.y},${voxel.z}`, voxel); rebuildChunk(chunkKey(voxel.x, voxel.y, voxel.z)) }
const removeVoxel = (position: { x: number; y: number; z: number }) => { voxels.delete(`${position.x},${position.y},${position.z}`); rebuildChunk(chunkKey(position.x, position.y, position.z)) }

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
  pending.forEach((placement) => byColor.set(placement.color, [...(byColor.get(placement.color) ?? []), placement]))
  const cube = new THREE.BoxGeometry(0.96, 0.96, 0.96)

  for (const [color, placements] of byColor) {
    const tint = color === 'erase' ? '#7b8c86' : paletteColor(color)
    const mesh = new THREE.InstancedMesh(cube, new THREE.MeshStandardMaterial({ color: tint, roughness: 0.2, metalness: 0.05, transparent: true, opacity: color === 'erase' ? 0.18 : 0.42, depthWrite: false }), placements.length)
    const matrix = new THREE.Matrix4()
    placements.forEach((placement, index) => {
      matrix.setPosition(placement.x - WORLD_SIZE / 2 + 0.5, placement.y + 0.5, placement.z - WORLD_SIZE / 2 + 0.5)
      mesh.setMatrixAt(index, matrix)
    })
    pendingPreviewGroup.add(mesh)
  }
}

const renderBatch = () => { batchCount.textContent = `${pending.length} / ${MAX_BATCH_SIZE}`; submitButton.disabled = pending.length === 0 || Date.now() < cooldownUntil; undoButton.disabled = pending.length === 0; batchList.innerHTML = pending.length ? pending.map((item, pendingIndex) => `<div class="batch-row"><i style="background:${item.color === 'erase' ? '#111719' : paletteColor(item.color)}"></i><span>${item.x}, ${item.y}, ${item.z}</span><b>${item.color.toUpperCase()}</b><button class="remove-pending" type="button" data-index="${pendingIndex}" aria-label="Remove voxel ${item.x}, ${item.y}, ${item.z}">×</button></div>`).join('') : '<span class="empty-state">Click the terrain to queue a voxel.</span>'; rebuildPendingPreview(); const eraseKey = pending.filter((placement) => placement.color === 'erase').map((placement) => `${placement.x},${placement.y},${placement.z}`).sort().join('|'); if (eraseKey !== renderedEraseKey) { renderedEraseKey = eraseKey; [...chunkMeshes.keys()].forEach(rebuildChunk) } }
const updateCooldown = () => { const remaining = Math.max(0, cooldownUntil - Date.now()); submitButton.disabled = pending.length === 0 || remaining > 0; cooldownValue.textContent = remaining ? `READY IN ${Math.ceil(remaining / 1000)}S` : 'AVAILABLE TO SUBMIT'; if (remaining) document.querySelector('#cooldown')!.classList.add('is-waiting'); else document.querySelector('#cooldown')!.classList.remove('is-waiting'); renderBatch() }
window.setInterval(updateCooldown, 1000)

const selectMode = (nextMode: VoxelMode) => { mode = nextMode; if (nextMode !== 'erase') lastColor = nextMode; modeLabel.textContent = nextMode === 'erase' ? 'ERASE' : nextMode.toUpperCase(); document.querySelectorAll('.swatch').forEach((item) => item.classList.remove('is-selected')); const selected = nextMode === 'erase' ? erase : [...paletteElement.children].find((item) => (item as HTMLButtonElement).title.toLowerCase().replace(' ', '') === nextMode.toLowerCase()); selected?.classList.add('is-selected') }
for (const color of PALETTE) { const button = document.createElement('button'); button.type = 'button'; button.className = `swatch ${color.id === mode ? 'is-selected' : ''}`; button.title = color.label; button.style.setProperty('--swatch', color.hex); button.addEventListener('click', () => selectMode(color.id)); paletteElement.append(button) }
const erase = document.createElement('button'); erase.type = 'button'; erase.className = 'swatch erase'; erase.title = 'Erase'; erase.innerHTML = '×'; erase.addEventListener('click', () => selectMode('erase')); paletteElement.append(erase)
window.addEventListener('keydown', (event) => { if (event.key.toLowerCase() !== 'e' || event.repeat) return; selectMode(mode === 'erase' ? lastColor : 'erase'); event.preventDefault() })
batchList.addEventListener('click', (event) => { const target = event.target; if (!(target instanceof HTMLButtonElement)) return; const index = Number(target.dataset.index); if (!Number.isInteger(index)) return; pending.splice(index, 1); renderBatch() })
undoButton.addEventListener('click', () => { pending.pop(); renderBatch() })
clearButton.addEventListener('click', () => { pending = []; renderBatch() })
window.addEventListener('keydown', (event) => { if (event.key.toLowerCase() !== 'z' || event.repeat) return; pending.pop(); renderBatch() })

const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2(); const pick = (event: PointerEvent, includePendingPreview = true, pickMode = mode, ignoredPendingEraseKeys = new Set<string>()) => { const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1); raycaster.setFromCamera(pointer, camera); const voxelTargets = includePendingPreview ? [...chunkMeshes.values(), pendingPreviewGroup] : [...chunkMeshes.values()]; const voxelHit = raycaster.intersectObjects(voxelTargets, true).find((intersection) => { if (pickMode !== 'erase' || !includePendingPreview || !ignoredPendingEraseKeys.size) return true; const point = intersection.point.clone().addScaledVector(intersection.normal!, -0.001); const x = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.x + WORLD_SIZE / 2))); const z = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.z + WORLD_SIZE / 2))); const y = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.y))); return !ignoredPendingEraseKeys.has(`${x},${y},${z}`) }); const hit = voxelHit ?? raycaster.intersectObject(ground)[0]; if (!hit) return; const point = voxelHit ? hit.point.clone().addScaledVector(hit.normal!, pickMode === 'erase' ? -0.001 : 0.05) : hit.point; const x = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.x + WORLD_SIZE / 2))); const z = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.z + WORLD_SIZE / 2))); const y = voxelHit ? Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(point.y))) : 0; cursorPosition.textContent = `X ${String(x).padStart(3, '0')} · Y ${String(y).padStart(3, '0')} · Z ${String(z).padStart(3, '0')}`; return { x, y, z } }
const queuePlacement = (position: { x: number; y: number; z: number }, color: VoxelMode) => { const key = `${position.x},${position.y},${position.z}`; const existingIndex = pending.findIndex((item) => item.x === position.x && item.y === position.y && item.z === position.z); if (color === 'erase') { if (existingIndex >= 0) { if (pending[existingIndex].color !== 'erase') { pending.splice(existingIndex, 1); renderBatch(); return true }; return false }; if (!voxels.has(key)) return false }; if (pending.length >= MAX_BATCH_SIZE || existingIndex >= 0) return false; pending.push({ ...position, color }); renderBatch(); return true }
const dragThreshold = 6; let activePointerId: number | null = null; let pointerDownPosition = { x: 0, y: 0 }; let dragMode: VoxelMode = mode; let isDragging = false; let suppressNextClick = false; let dragEraseKeys = new Set<string>()
const resetPointerGesture = () => { activePointerId = null; isDragging = false; dragMode = mode }
renderer.domElement.addEventListener('pointerdown', (event) => { if (event.button !== 0 || activePointerId !== null) return; activePointerId = event.pointerId; pointerDownPosition = { x: event.clientX, y: event.clientY }; dragMode = mode; isDragging = false; dragEraseKeys = new Set(); suppressNextClick = false; renderer.domElement.setPointerCapture(event.pointerId) })
renderer.domElement.addEventListener('pointermove', (event) => { if (activePointerId !== event.pointerId) { pick(event); return }; if (!isDragging && Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) >= dragThreshold) { isDragging = true; suppressNextClick = true }; if (isDragging) { const position = pick(event, dragMode === 'erase', dragMode, new Set(pending.filter((placement) => placement.color === 'erase' && !dragEraseKeys.has(`${placement.x},${placement.y},${placement.z}`)).map((placement) => `${placement.x},${placement.y},${placement.z}`))); if (position) { queuePlacement(position, dragMode); const key = `${position.x},${position.y},${position.z}`; if (dragMode === 'erase' && pending.some((placement) => `${placement.x},${placement.y},${placement.z}` === key && placement.color === 'erase')) dragEraseKeys.add(key) }; return }; pick(event) })
renderer.domElement.addEventListener('pointerup', (event) => { if (activePointerId !== event.pointerId) return; if (isDragging) { const position = pick(event, dragMode === 'erase', dragMode, new Set(pending.filter((placement) => placement.color === 'erase' && !dragEraseKeys.has(`${placement.x},${placement.y},${placement.z}`)).map((placement) => `${placement.x},${placement.y},${placement.z}`))); if (position) { queuePlacement(position, dragMode); const key = `${position.x},${position.y},${position.z}`; if (dragMode === 'erase' && pending.some((placement) => `${placement.x},${placement.y},${placement.z}` === key && placement.color === 'erase')) dragEraseKeys.add(key) } }; if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId); resetPointerGesture() })
renderer.domElement.addEventListener('pointercancel', resetPointerGesture)
renderer.domElement.addEventListener('lostpointercapture', resetPointerGesture)
renderer.domElement.addEventListener('click', (event) => { if (event.button !== 0 || suppressNextClick) { suppressNextClick = false; return }; const position = pick(event); if (position) queuePlacement(position, mode) })
submitButton.addEventListener('click', () => { if (!socket || socket.readyState !== WebSocket.OPEN || !pending.length) { cooldownValue.textContent = 'SERVER OFFLINE'; return }; socket.send(JSON.stringify({ type: 'place', requestId: crypto.randomUUID(), placements: pending })); submitButton.disabled = true })

const connect = () => { socket = new WebSocket(import.meta.env.VITE_WS_URL ?? 'ws://localhost:8787'); socket.addEventListener('open', () => { connectionLabel.textContent = 'LIVE WORLD'; document.querySelector('.status-dot')?.classList.add('is-live'); socket?.send(JSON.stringify({ type: 'hello', token: localStorage.getItem('plac3d-token') ?? undefined })) }); socket.addEventListener('message', (event) => { const message = JSON.parse(event.data) as ServerMessage; if (message.type === 'hello') { localStorage.setItem('plac3d-token', message.token); cooldownUntil = message.cooldownUntil; socket?.send(JSON.stringify({ type: 'subscribe', chunks: ['31,0,31', '30,0,31', '31,0,30', '30,0,30'] })) } if (message.type === 'chunks') { Object.values(message.chunks).flat().forEach(updateVoxel); finishLoading() } if (message.type === 'updates') { message.voxels.forEach(updateVoxel); message.erased.forEach(removeVoxel) } if (message.type === 'placed') { cooldownUntil = message.cooldownUntil; pending = []; renderBatch() } if (message.type === 'error') { cooldownUntil = message.cooldownUntil ?? cooldownUntil; cooldownValue.textContent = message.message.toUpperCase(); renderBatch() } }); socket.addEventListener('close', () => { connectionLabel.textContent = 'LOCAL PREVIEW'; document.querySelector('.status-dot')?.classList.remove('is-live') }) }
connect()

const resize = () => { const width = viewport.clientWidth; const height = viewport.clientHeight; camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false) }; window.addEventListener('resize', resize); resize()
const animate = () => { requestAnimationFrame(animate); const forward = new THREE.Vector3(); camera.getWorldDirection(forward); forward.y = 0; forward.normalize(); const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize(); const direction = new THREE.Vector3(); if (movement.forward) direction.add(forward); if (movement.backward) direction.sub(forward); if (movement.right) direction.add(right); if (movement.left) direction.sub(right); if (direction.lengthSq()) { const movementSpeed = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.01, 0.5, 12); direction.normalize().multiplyScalar(movementSpeed); camera.position.add(direction); controls.target.add(direction) }; controls.update(); renderer.render(scene, camera) }; animate(); renderBatch()
