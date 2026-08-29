export const WORLD_SIZE = 1000
export const CHUNK_SIZE = 16
export const MAX_LEVEL = 50
export const STARTING_BATCH_LIMIT = 50
export const MAX_BATCH_SIZE = 500
export const COOLDOWN_MS = 60_000

export const STARTING_LEVEL_REQUIREMENT = 100
export const LEVEL_REQUIREMENT_GROWTH = 1.2
const TOTAL_BATCH_LEVEL_WEIGHT = (MAX_LEVEL * (MAX_LEVEL + 1)) / 2 - 1

export const batchLimitForLevel = (level: number) => {
  const normalizedLevel = Math.min(
    MAX_LEVEL,
    Math.max(1, Math.floor(Number.isFinite(level) ? level : 1)),
  )
  const earnedLevelWeight =
    (normalizedLevel * (normalizedLevel + 1)) / 2 - 1
  return (
    STARTING_BATCH_LIMIT +
    Math.round(
      ((MAX_BATCH_SIZE - STARTING_BATCH_LIMIT) * earnedLevelWeight) /
        TOTAL_BATCH_LEVEL_WEIGHT,
    )
  )
}

export type UserProgression = {
  level: number
  batchLimit: number
  voxelsIntoLevel: number
  voxelsForNextLevel: number | null
  nextLevelAt: number | null
  isMaxLevel: boolean
}

export const progressionForVoxelCount = (
  voxelCount: number,
): UserProgression => {
  const normalizedCount = Number.isFinite(voxelCount)
    ? Math.max(0, Math.floor(voxelCount))
    : 0
  let level = 1
  let levelStart = 0
  let levelRequirement = STARTING_LEVEL_REQUIREMENT

  while (
    level < MAX_LEVEL &&
    normalizedCount >= levelStart + levelRequirement
  ) {
    levelStart += levelRequirement
    level += 1
    if (level < MAX_LEVEL)
      levelRequirement = Math.ceil(
        levelRequirement * LEVEL_REQUIREMENT_GROWTH,
      )
  }

  const isMaxLevel = level === MAX_LEVEL
  return {
    level,
    batchLimit: batchLimitForLevel(level),
    voxelsIntoLevel: normalizedCount - levelStart,
    voxelsForNextLevel: isMaxLevel ? null : levelRequirement,
    nextLevelAt: isMaxLevel ? null : levelStart + levelRequirement,
    isMaxLevel,
  }
}

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
export type AuthUser = {
  username: string
  voxelCount: number
} & UserProgression

export type ClientMessage =
  | { type: 'hello'; token?: string }
  | { type: 'subscribe'; chunks: string[] }
  | { type: 'place'; requestId: string; placements: Placement[] }

export type ServerMessage =
  | {
      type: 'hello'
      token: string
      cooldownUntil: number
      user: AuthUser | null
    }
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
