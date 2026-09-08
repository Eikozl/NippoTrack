import test from 'node:test';
import assert from 'node:assert/strict';

import { authViewFromSearch, resolveExperience } from '../src/landing/routing.js';

test('the root path resolves to the public landing without auth initialization', () => {
  assert.equal(resolveExperience({ pathname: '/', hash: '', search: '' }), 'landing');
});

test('the app path and existing product hashes resolve to the private application', () => {
  assert.equal(resolveExperience({ pathname: '/app', hash: '', search: '' }), 'app');
  assert.equal(resolveExperience({ pathname: '/', hash: '#review', search: '' }), 'app');
  assert.equal(resolveExperience({ pathname: '/', hash: '#kanji-reference/%E6%AE%BB', search: '' }), 'app');
});

test('marketing anchors do not accidentally initialize the application', () => {
  assert.equal(resolveExperience({ pathname: '/', hash: '#features', search: '' }), 'landing');
  assert.equal(resolveExperience({ pathname: '/', hash: '#how-it-works', search: '' }), 'landing');
});

test('only the real sign-up query selects account creation', () => {
  assert.equal(authViewFromSearch('?auth=sign-up'), 'sign-up');
  assert.equal(authViewFromSearch('?auth=sign-in'), 'sign-in');
  assert.equal(authViewFromSearch('?auth=anything-else'), 'sign-in');
});
