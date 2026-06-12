import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectPredicateConflicts } from './conflict.js'

describe('conflict kernel', () => {
  it('detects positive and explicit negative facts with the same atom', () => {
    const conflicts = detectPredicateConflicts([
      { id: 'F1', atom: { predicate: 'at', args: { object: 'car', location: 'home' } } },
      { id: 'F2', atom: { predicate: 'at', args: { location: 'home', object: 'car' }, negated: true } },
      { id: 'F3', atom: { predicate: 'at', args: { object: 'car', location: 'shop' }, negated: true } },
    ])

    assert.deepEqual(conflicts, [
      {
        atom: { predicate: 'at', args: { object: 'car', location: 'home' } },
        positiveFactId: 'F1',
        negativeFactId: 'F2',
      },
    ])
  })
})
