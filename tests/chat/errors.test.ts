import { describe, it, expect } from 'vitest';
import { explainBackendError } from '../../src/chat/backend.js';

describe('explainBackendError', () => {
  it('explains the all-workspaces key rejection and names the screen to fix it', () => {
    // The exact error an "All workspaces" Anthropic key returns.
    const raw =
      'Anthropic request failed: 400 {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"anthropic-workspace-id is required when authenticating with an ' +
      'identity-linked API key; send the id of the workspace this request acts in."}}';
    const out = explainBackendError(raw);
    expect(out).toContain('Settings');
    expect(out).toContain('wrkspc_');
    expect(out).not.toContain('invalid_request_error');
  });

  it('explains a rejected workspace id differently from a missing one', () => {
    const out = explainBackendError('anthropic-workspace-id header must be a valid workspace ID.');
    expect(out).toContain('not accepted');
    expect(out).toContain('Settings');
  });

  it('explains a bad key', () => {
    expect(explainBackendError('401 authentication_error: invalid x-api-key'))
      .toContain('API key was rejected');
  });

  it('explains rate limiting', () => {
    expect(explainBackendError('429 rate_limit_error')).toContain('rate limiting');
  });

  it('explains an exhausted balance', () => {
    expect(explainBackendError('Your credit balance is too low')).toContain('credit');
  });

  it('passes an unrecognised error through unchanged rather than inventing advice', () => {
    const raw = 'something entirely unexpected happened';
    expect(explainBackendError(raw)).toBe(raw);
  });
});
