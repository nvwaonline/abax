import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { atomEquals, atomKey, instantiateAtom, matchRule } from './predicate.js'

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


  it('atom identity is type-aware: true vs "true" and 1 vs "1" are different atoms', () => {
    // External review P1: String(value) keys collapsed types, so a goal
    // wanting p(x=true) was satisfied by asserting p(x="true").
    assert.equal(
      atomEquals(
        { predicate: 'p', args: { x: true } },
        { predicate: 'p', args: { x: 'true' } },
      ),
      false,
    )
    assert.notEqual(
      atomKey({ predicate: 'p', args: { x: 1 } }),
      atomKey({ predicate: 'p', args: { x: '1' } }),
    )
  })

  it('caps cross-product joins with a teaching error instead of exploding memory', () => {
    // Real incident (2026-06-12 mtp bench): a sum rule whose cost atoms
    // all used fresh variables - 8 atoms x 8 facts = 8^8 = 16.7M binding
    // objects, V8 heap death at 4GB. Here 9 facts x 6 fresh-var atoms
    // (9^6 = 531k) must trip the cap, not "succeed".
    const facts = Array.from({ length: 9 }, (_, k) => ({
      id: `F${k}`,
      atom: { predicate: 'cost', args: { item: `item_${k}`, total: k } },
    }))
    const when = Array.from({ length: 6 }, (_, j) => ({
      predicate: 'cost',
      args: { item: `?i${j}`, total: `?t${j}` },
    }))
    assert.throws(
      () =>
        matchRule(
          { id: 'ax_boom', when, then: [{ predicate: 'x', args: { a: '?t0' } }] },
          facts,
        ),
      /cross product|pin identifying|join explosion/i,
    )
  })

  it('pinned and variable-sharing joins stay under the cap', () => {
    const facts = Array.from({ length: 9 }, (_, k) => ({
      id: `F${k}`,
      atom: { predicate: 'cost', args: { item: `item_${k}`, total: k } },
    }))
    // Pinned: each atom names its item - exactly one path through the join.
    const pinned = Array.from({ length: 6 }, (_, j) => ({
      predicate: 'cost',
      args: { item: `item_${j}`, total: `?t${j}` },
    }))
    const matches = matchRule(
      { id: 'ax_ok', when: pinned, then: [{ predicate: 'x', args: { a: '?t0' } }] },
      facts,
    )
    assert.equal(matches.length, 1)

    // Shared variable: matches stay linked instead of multiplying.
    const linked = [
      { predicate: 'cost', args: { item: '?i', total: '?t' } },
      { predicate: 'cost', args: { item: '?i', total: '?t' } },
    ]
    assert.equal(
      matchRule({ id: 'ax_link', when: linked, then: [{ predicate: 'y', args: { v: '?t' } }] }, facts)
        .length,
      9,
    )
  })
})
