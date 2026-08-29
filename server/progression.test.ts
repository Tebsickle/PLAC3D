import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_BATCH_SIZE,
  MAX_LEVEL,
  STARTING_BATCH_LIMIT,
  batchLimitForLevel,
  progressionForVoxelCount,
} from '../shared/protocol.js'

test('progression starts at level one with the existing batch limit', () => {
  assert.deepEqual(progressionForVoxelCount(0), {
    level: 1,
    batchLimit: STARTING_BATCH_LIMIT,
    voxelsIntoLevel: 0,
    voxelsForNextLevel: 100,
    nextLevelAt: 100,
    isMaxLevel: false,
  })
  assert.equal(progressionForVoxelCount(99).level, 1)
})

test('each requirement and batch limit grows from the previous level', () => {
  assert.deepEqual(progressionForVoxelCount(100), {
    level: 2,
    batchLimit: 51,
    voxelsIntoLevel: 0,
    voxelsForNextLevel: 120,
    nextLevelAt: 220,
    isMaxLevel: false,
  })
  assert.deepEqual(progressionForVoxelCount(220), {
    level: 3,
    batchLimit: 52,
    voxelsIntoLevel: 0,
    voxelsForNextLevel: 144,
    nextLevelAt: 364,
    isMaxLevel: false,
  })
})

test('all 50 levels increase the batch limit and hit both exact endpoints', () => {
  let previousLimit = STARTING_BATCH_LIMIT - 1
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const batchLimit = batchLimitForLevel(level)
    assert.ok(batchLimit > previousLimit)
    assert.ok(batchLimit <= MAX_BATCH_SIZE)
    previousLimit = batchLimit
  }
  assert.equal(batchLimitForLevel(1), STARTING_BATCH_LIMIT)
  assert.equal(previousLimit, MAX_BATCH_SIZE)
})

test('progression stops at level 50 with no further requirement', () => {
  assert.equal(progressionForVoxelCount(3_826_562).level, 49)
  assert.equal(progressionForVoxelCount(3_826_563).level, MAX_LEVEL)
  const progression = progressionForVoxelCount(Number.MAX_SAFE_INTEGER)
  assert.equal(progression.level, MAX_LEVEL)
  assert.equal(progression.batchLimit, MAX_BATCH_SIZE)
  assert.equal(progression.isMaxLevel, true)
  assert.equal(progression.voxelsForNextLevel, null)
  assert.equal(progression.nextLevelAt, null)
})
