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

  it('explains a workspace that does not exist or is not accessible', () => {
    // The documented 404 for an unknown workspace or one the key cannot reach.
    const out = explainBackendError('404 not_found_error: Workspace `wrkspc_01ABC` not found.');
    expect(out).toContain('not found');
    expect(out).toContain('Settings → Workspaces');
  });

  it('points at the ID column, which is where the Console actually shows it', () => {
    const out = explainBackendError('anthropic-workspace-id is required when authenticating');
    expect(out).toContain('ID column');
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
