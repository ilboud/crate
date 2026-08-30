import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MUTATING_TOOLS,
  filterAllowedTools,
  isMutatingTool,
  isToolAllowed,
} from '../../src/chat/tools.js';

/**
 * The allowlist is the safety boundary for a token that can modify a real
 * Discogs collection. These tests pin the policy: reads and two reversible
 * writes in, everything destructive out.
 */
describe('tool allowlist', () => {
  const READ_TOOLS = [
    'search',
    'get_release',
    'get_artist',
    'get_artist_releases',
    'get_label',
    'get_master_release',
    'get_master_release_versions',
    'get_user_collection_items',
    'get_user_collection_folders',
    'get_user_collection_value',
    'find_release_in_user_collection',
    'get_release_community_rating',
  ];

  const DESTRUCTIVE_TOOLS = [
    'add_release_to_user_collection_folder',
    'delete_release_from_user_collection_folder',
    'move_release_in_user_collection',
    'create_user_collection_folder',
    'delete_user_collection_folder',
    'edit_user_collection_folder',
    'delete_release_rating',
  ];

  it('permits every read tool', () => {
    for (const name of READ_TOOLS) {
      expect(isToolAllowed(name), `${name} should be allowed`).toBe(true);
    }
  });

  it('blocks every destructive tool', () => {
    for (const name of DESTRUCTIVE_TOOLS) {
      expect(isToolAllowed(name), `${name} must be blocked`).toBe(false);
    }
  });

  it('permits the two reversible writes', () => {
    expect(isToolAllowed('rate_release_in_user_collection')).toBe(true);
    expect(isToolAllowed('edit_user_collection_custom_field_value')).toBe(true);
    expect(ALLOWED_MUTATING_TOOLS.size).toBe(2);
  });

  it('blocks deletion even though it starts with an allowed-looking prefix', () => {
    // "edit_user_collection_custom_field_value" is allowed but
    // "edit_user_collection_folder" is not — the allowlist is exact, not prefix.
    expect(isToolAllowed('edit_user_collection_folder')).toBe(false);
  });

  it('treats an unknown mutating verb as blocked by default', () => {
    // A new tool added by a future server version must fail closed.
    expect(isMutatingTool('delete_everything')).toBe(true);
    expect(isToolAllowed('delete_everything')).toBe(false);
    expect(isToolAllowed('remove_release')).toBe(false);
    expect(isToolAllowed('update_collection')).toBe(false);
  });

  it('treats an unknown read-shaped tool as allowed', () => {
    expect(isToolAllowed('get_something_new')).toBe(true);
    expect(isToolAllowed('list_things')).toBe(true);
  });

  it('filters a tool list down to the permitted subset', () => {
    const tools = [
      { name: 'search' },
      { name: 'delete_release_from_user_collection_folder' },
      { name: 'rate_release_in_user_collection' },
      { name: 'add_release_to_user_collection_folder' },
    ];
    expect(filterAllowedTools(tools).map((t) => t.name)).toEqual([
      'search',
      'rate_release_in_user_collection',
    ]);
  });
});
