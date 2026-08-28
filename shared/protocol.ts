export const WORLD_SIZE = 1000
export const CHUNK_SIZE = 16
export const MAX_BATCH_SIZE = 100
export const COOLDOWN_MS = 60_000

export const PALETTE = [
  { id: 'white', label: 'White', hex: '#FFFFFF' },
  { id: 'lightGray', label: 'Light Gray', hex: '#E4E4E4' },
  { id: 'mediumGray', label: 'Medium Gray', hex: '#888888' },
  { id: 'darkGray', label: 'Dark Gray', hex: '#222222' },
  { id: 'hotPink', label: 'Hot Pink', hex: '#FFA7D1' },
  { id: 'red', label: 'Red', hex: '#E50000' },
  { id: 'orange', label: 'Orange', hex: '#E59500' },
  { id: 'brown', label: 'Brown', hex: '#A06A42' },
  { id: 'yellow', label: 'Yellow', hex: '#E5D900' },
  { id: 'lightGreen', label: 'Light Green', hex: '#94E044' },
  { id: 'green', label: 'Green', hex: '#02BE01' },
  { id: 'teal', label: 'Teal', hex: '#00D3DD' },
  { id: 'cyan', label: 'Cyan', hex: '#0083C7' },
  { id: 'blue', label: 'Blue', hex: '#0000EA' },
  { id: 'purple', label: 'Purple', hex: '#CF6EE4' },
  { id: 'deepPurple', label: 'Deep Purple', hex: '#820080' },
] as const

export type PaletteId = (typeof PALETTE)[number]['id']
export type Voxel = { x: number; y: number; z: number; color: PaletteId }
export type Placement = Omit<Voxel, 'color'> & { color: PaletteId | 'erase' }

export type ClientMessage =
  | { type: 'hello'; token?: string }
  | { type: 'subscribe'; chunks: string[] }
  | { type: 'place'; requestId: string; placements: Placement[] }

export type ServerMessage =
  | { type: 'hello'; token: string; cooldownUntil: number }
  | { type: 'chunks'; chunks: Record<string, Voxel[]> }
  | { type: 'updates'; voxels: Voxel[]; erased: Array<{ x: number; y: number; z: number }> }
  | {
      type: 'placed'
      requestId: string
      cooldownUntil: number
      count: number
      voxels: Voxel[]
      erased: Array<{ x: number; y: number; z: number }>
    }
  | { type: 'error'; requestId?: string; code: string; message: string; cooldownUntil?: number }

export const paletteColor = (id: PaletteId) => PALETTE.find((entry) => entry.id === id)?.hex ?? '#ffffff'
export const isPaletteId = (value: unknown): value is PaletteId => PALETTE.some((entry) => entry.id === value)

export const isInBounds = (value: number) => Number.isInteger(value) && value >= 0 && value < WORLD_SIZE
export const chunkKey = (x: number, y: number, z: number) => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`
