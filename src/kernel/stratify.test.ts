import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateStratifiedClosure,
  StratificationError,
  stratifyRules,
} from './stratify.js'

describe('stratifyRules', () => {
  it('places negated dependencies in strictly lower strata', () => {
    const strata = stratifyRules([
      {
        id: 'R_BAN',
        when: [{ predicate: 'person', args: { item: '?x' } }, { predicate: 'suspicious', args: { item: '?x' } }],
        then: [{ predicate: 'banned', args: { item: '?x' } }],
      },
      {
        id: 'R_ALLOW',
        when: [
          { predicate: 'person', args: { item: '?x' } },
          { predicate: 'banned', args: { item: '?x' }, naf: true },
        ],
        then: [{ predicate: 'allowed', args: { item: '?x' } }],
      },
    ])

    assert.equal(strata.get('R_BAN'), 0)
    assert.equal(strata.get('R_ALLOW'), 1)
  })

  it('rejects programs with a negative dependency cycle', () => {
    assert.throws(
      () =>
        stratifyRules([
          {
            id: 'R1',
            when: [
              { predicate: 'seed', args: { item: '?x' } },
              { predicate: 'p', args: { item: '?x' }, naf: true },
            ],
            then: [{ predicate: 'q', args: { item: '?x' } }],
          },
          {
            id: 'R2',
            when: [{ predicate: 'q', args: { item: '?x' } }],
            then: [{ predicate: 'p', args: { item: '?x' } }],
          },
        ]),
      StratificationError,
    )
  })
})

describe('evaluateStratifiedClosure', () => {
  it('evaluates negation soundly: lower strata complete before negation is checked', () => {
    // Naive single-pass evaluation would fire R_ALLOW before R_BAN derives
    // banned(a), leaving a stale allowed(a). Stratified evaluation must not.
    const result = evaluateStratifiedClosure({
      rules: [
        {
          id: 'R_ALLOW',
          when: [
            { predicate: 'person', args: { item: '?x' } },
            { predicate: 'banned', args: { item: '?x' }, naf: true },
          ],
          then: [{ predicate: 'allowed', args: { item: '?x' } }],
        },
        {
          id: 'R_BAN',
          when: [
            { predicate: 'person', args: { item: '?x' } },
            { predicate: 'suspicious', args: { item: '?x' } },
          ],
          then: [{ predicate: 'banned', args: { item: '?x' } }],
        },
      ],
      facts: [
        { id: 'F1', atom: { predicate: 'person', args: { item: 'a' } } },
        { id: 'F2', atom: { predicate: 'suspicious', args: { item: 'a' } } },
        { id: 'F3', atom: { predicate: 'person', args: { item: 'b' } } },
      ],
    })

    const derived = result.derivations.map((derivation) => ({
      predicate: derivation.atom.predicate,
      item: derivation.atom.args?.item,
    }))

    assert.deepEqual(
      derived.sort((l, r) => `${l.predicate}${l.item}`.localeCompare(`${r.predicate}${r.item}`)),
      [
        { predicate: 'allowed', item: 'b' },
        { predicate: 'banned', item: 'a' },
      ],
    )
  })

  it('chains rules to fixpoint with provenance', () => {
    const result = evaluateStratifiedClosure({
      rules: [
        {
          id: 'AX1',
          when: [{ predicate: 'a', args: { item: '?x' } }],
          then: [{ predicate: 'b', args: { item: '?x' } }],
        },
        {
          id: 'AX2',
          when: [{ predicate: 'b', args: { item: '?x' } }],
          then: [{ predicate: 'c', args: { item: '?x' } }],
        },
      ],
      facts: [{ id: 'F1', atom: { predicate: 'a', args: { item: 'thing' } } }],
    })

    assert.equal(result.derivations.length, 2)
    const last = result.derivations.find((derivation) => derivation.atom.predicate === 'c')
    assert.equal(last?.ruleId, 'AX2')
    assert.deepEqual(last?.sourceFactIds, ['derived:b|item:"thing"'])
  })
})

describe('rule safety at closure time', () => {
  it('rejects rules whose head variables are not bound by positive body literals', () => {
    assert.throws(
      () =>
        evaluateStratifiedClosure({
          rules: [
            {
              id: 'R_UNSAFE',
              when: [{ predicate: 'seen', args: { item: '?x' } }],
              then: [{ predicate: 'paired', args: { left: '?x', right: '?y' } }],
            },
          ],
          facts: [],
        }),
      /unsafe/,
    )
  })

  it('rejects naf literals with variables not bound by positive body literals', () => {
    assert.throws(
      () =>
        evaluateStratifiedClosure({
          rules: [
            {
              id: 'R_UNSAFE_NAF',
              when: [{ predicate: 'blocked', args: { item: '?x' }, naf: true }],
              then: [{ predicate: 'free', args: { item: 'all' } }],
            },
          ],
          facts: [],
        }),
      /unsafe/,
    )
  })
})
