import { test, expect, describe } from 'bun:test';
import {
  subjectTypeForms,
  classifyAggregateKind,
  kindsMixOrgWithPolitician,
  type SubjectTyping,
} from './subject-aggregate.js';

describe('subjectTypeForms', () => {
  test('synthetic _wins snake-case label yields the stripped person surface', () => {
    const f = subjectTypeForms(null, 'janet_mills_wins', 'janet_mills_wins');
    expect(f).toContain('janet mills wins'); // de-underscored full
    expect(f).toContain('janet mills');       // _wins-stripped → matches KB alias
  });
  test('clean org subject is normalized and present', () => {
    const f = subjectTypeForms('Democratic Party', 'democrat', 'democrat');
    expect(f).toContain('democratic party');
    expect(f).toContain('democrat');
  });
  test('deduped + empty/blank ignored', () => {
    const f = subjectTypeForms('', '  ', 'graham_platner_wins');
    expect(f).toContain('graham platner'); // stripped
    expect(new Set(f).size).toBe(f.length);
  });
});

describe('classifyAggregateKind', () => {
  const kb = (m: Record<string, SubjectTyping>) => (f: string) => m[f];
  test('organization/party surface -> org (wins over any person alias)', () => {
    expect(classifyAggregateKind(['democratic party'], kb({ 'democratic party': { type: 'organization', role: null } }))).toBe('org');
    expect(classifyAggregateKind(['reform uk'], kb({ 'reform uk': { type: 'party', role: null } }))).toBe('org');
  });
  test('person role politician -> politician; other role -> person', () => {
    expect(classifyAggregateKind(['janet mills wins', 'janet mills'], kb({ 'janet mills': { type: 'person', role: 'politician' } }))).toBe('politician');
    expect(classifyAggregateKind(['bad bunny'], kb({ 'bad bunny': { type: 'person', role: 'other' } }))).toBe('person');
    expect(classifyAggregateKind(['paddy pimblett'], kb({ 'paddy pimblett': { type: 'person', role: 'athlete' } }))).toBe('person');
  });
  test('no KB hit -> other', () => {
    expect(classifyAggregateKind(['ken block'], kb({}))).toBe('other');
  });
});

describe('kindsMixOrgWithPolitician', () => {
  test('the 1094 winner fragment (org + politician) -> TRUE', () => {
    expect(kindsMixOrgWithPolitician(['org', 'org', 'politician', 'politician'])).toBe(true);
  });
  test('band vs artists (org + person) -> FALSE', () => {
    expect(kindsMixOrgWithPolitician(['org', 'person', 'person'])).toBe(false);
  });
  test('all-person / all-org / org+other -> FALSE', () => {
    expect(kindsMixOrgWithPolitician(['politician', 'politician', 'person'])).toBe(false);
    expect(kindsMixOrgWithPolitician(['org', 'org'])).toBe(false);
    expect(kindsMixOrgWithPolitician(['org', 'other'])).toBe(false);
  });
});
