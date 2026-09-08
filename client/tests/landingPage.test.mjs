import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/landing/sections.js', import.meta.url), 'utf8');

test('landing source follows the approved narrative order', () => {
  const headings = [
    'Bring your Japanese learning together.',
    'Your Japanese study is already everywhere.',
    'Understand the Japanese you actually encounter.',
    'Less typing. More intentional tracking.',
    "Keep kanji connected to what you're learning.",
    "Review what you've actually collected.",
    'See your learning take shape.',
    'Start from where you are.',
    'Know what to do next.',
    'Keep the tools you already love.',
    'Your Japanese journey is already yours.',
    'Ready to bring your Japanese study together?'
  ];

  let previous = -1;
  for (const heading of headings) {
    const position = source.indexOf(heading);
    assert.ok(position > previous, 'missing or out-of-order heading: ' + heading);
    previous = position;
  }
});

test('landing demos remain presentation-only and make no application requests', () => {
  assert.ok(!source.includes('apiRequest('));
  assert.ok(!source.includes('supabase'));
  assert.ok(!source.includes('fetch('));
  assert.ok(!source.includes('<button class="demo-'));
});

test('Japanese examples declare their language', () => {
  for (const text of ['学校', 'がっこう', '学校に行った。', '殻', 'カク', 'から']) {
    assert.ok(source.includes('lang="ja">' + text), 'missing lang=ja for ' + text);
  }
});

test('navigation, hero, and final CTA use their frozen labels', () => {
  const navigation = source.slice(source.indexOf('landing-nav-actions'), source.indexOf('landing-menu-button'));
  assert.ok(navigation.indexOf('Log in') < navigation.indexOf('Get started'));
  assert.ok(source.includes('href="/app?auth=sign-up">Start free</a>'));
  assert.ok(source.includes('href="/app?auth=sign-up">Start with NippoTrack</a>'));
  assert.ok(source.includes('Already have an account? Log in'));
});
