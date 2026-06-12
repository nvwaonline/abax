import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { atomEquals, instantiateAtom, matchRule } from './predicate.js'

describe('predicate kernel', () => {
  it('compares atoms by predicate, negation, and sorted args', () => {
    assert.equal(
      atomEquals(
        { predicate: 'located_at', args: { object: 'car', place: 'shop' } },
        { predicate: 'located_at', args: { place: 'shop', object: 'car' } },
      ),
      true,
    )
    assert.equal(
      atomEquals(
        { predicate: 'located_at', args: { object: 'car', place: 'shop' }, negated: true },
        { predicate: 'located_at', args: { place: 'shop', object: 'car' } },
      ),
      false,
    )
  })

  it('binds variables consistently across multiple conditions', () => {
    const matches = matchRule(
      {
        id: 'R1',
        when: [
          { predicate: 'parent', args: { parent: '?x', child: '?y' } },
          { predicate: 'parent', args: { parent: '?y', child: '?z' } },
        ],
        then: [{ predicate: 'grandparent', args: { grandparent: '?x', child: '?z' } }],
      },
      [
        { id: 'F1', atom: { predicate: 'parent', args: { parent: 'alice', child: 'bob' } } },
        { id: 'F2', atom: { predicate: 'parent', args: { parent: 'bob', child: 'cara' } } },
        { id: 'F3', atom: { predicate: 'parent', args: { parent: 'alice', child: 'drew' } } },
      ],
    )

    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0].bindings, { x: 'alice', y: 'bob', z: 'cara' })
    assert.deepEqual(matches[0].factIds, ['F1', 'F2'])
  })

  it('treats naf conditions as absence checks under existing bindings', () => {
    const matches = matchRule(
      {
        id: 'R1',
        when: [
          { predicate: 'candidate', args: { item: '?item' } },
          { predicate: 'blocked', args: { item: '?item' }, naf: true },
        ],
        then: [{ predicate: 'eligible', args: { item: '?item' } }],
      },
      [
        { id: 'F1', atom: { predicate: 'candidate', args: { item: 'walk' } } },
        { id: 'F2', atom: { predicate: 'candidate', args: { item: 'drive' } } },
        { id: 'F3', atom: { predicate: 'blocked', args: { item: 'drive' } } },
      ],
    )

    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0].bindings, { item: 'walk' })
    assert.deepEqual(matches[0].factIds, ['F1'])
  })

  it('evaluates naf literals after positive literals regardless of written order', () => {
    const matches = matchRule(
      {
        id: 'R1',
        when: [
          { predicate: 'blocked', args: { item: '?item' }, naf: true },
          { predicate: 'candidate', args: { item: '?item' } },
        ],
        then: [{ predicate: 'eligible', args: { item: '?item' } }],
      },
      [
        { id: 'F1', atom: { predicate: 'candidate', args: { item: 'walk' } } },
        { id: 'F2', atom: { predicate: 'candidate', args: { item: 'drive' } } },
        { id: 'F3', atom: { predicate: 'blocked', args: { item: 'drive' } } },
      ],
    )

    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0].bindings, { item: 'walk' })
  })

  it('matches strong-negative body literals against explicit negative facts', () => {
    const matches = matchRule(
      {
        id: 'R1',
        when: [{ predicate: 'at', args: { object: '?o', location: 'home' }, negated: true }],
        then: [{ predicate: 'away', args: { object: '?o' } }],
      },
      [
        { id: 'F1', atom: { predicate: 'at', args: { object: 'car', location: 'home' } } },
        { id: 'F2', atom: { predicate: 'at', args: { object: 'user', location: 'home' }, negated: true } },
      ],
    )

    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0].bindings, { o: 'user' })
    assert.deepEqual(matches[0].factIds, ['F2'])
  })

  it('does not instantiate conclusions with unbound variables', () => {
    assert.equal(
      instantiateAtom({ predicate: 'answer', args: { value: '?missing' } }, {}),
      undefined,
    )
    assert.deepEqual(
      instantiateAtom({ predicate: 'answer', args: { value: '?known' } }, { known: 'walk' }),
      { predicate: 'answer', args: { value: 'walk' }, negated: undefined },
    )
  })
})
