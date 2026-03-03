/**
 * Tests for zulip-openclaw plugin
 *
 * Run with: npm test
 */

const { zulipPlugin, zulipApi } = require('../plugin');

// ============================================
// UNIT TESTS - Pure functions, no network
// ============================================

describe('Unit Tests', () => {
  describe('messaging.normalizeTarget', () => {
    const normalize = zulipPlugin.messaging.normalizeTarget;

    test('returns null/undefined unchanged', () => {
      expect(normalize(null)).toBe(null);
      expect(normalize(undefined)).toBe(undefined);
    });

    test('passes through stream: prefix unchanged', () => {
      expect(normalize('stream:general')).toBe('stream:general');
    });

    test('passes through private: prefix unchanged', () => {
      expect(normalize('private:user@example.com')).toBe('private:user@example.com');
    });

    test('adds stream: prefix to bare stream names', () => {
      expect(normalize('general')).toBe('stream:general');
      expect(normalize('engineering')).toBe('stream:engineering');
    });
  });

  describe('messaging.targetResolver.looksLikeId', () => {
    const looksLikeId = zulipPlugin.messaging.targetResolver.looksLikeId;

    test('recognizes stream: prefix', () => {
      expect(looksLikeId('stream:general')).toBe(true);
    });

    test('recognizes private: prefix', () => {
      expect(looksLikeId('private:user@example.com')).toBe(true);
    });

    test('recognizes email addresses', () => {
      expect(looksLikeId('user@example.com')).toBe(true);
    });

    test('rejects bare stream names without @', () => {
      expect(looksLikeId('general')).toBe(false);
    });
  });

  describe('config.isConfigured', () => {
    const isConfigured = zulipPlugin.config.isConfigured;

    test('returns true when all fields present', () => {
      expect(isConfigured({
        email: 'bot@example.com',
        apiKey: 'secret123',
        site: 'https://example.zulipchat.com'
      })).toBe(true);
    });

    test('returns false when email missing', () => {
      expect(isConfigured({
        apiKey: 'secret123',
        site: 'https://example.zulipchat.com'
      })).toBe(false);
    });

    test('returns false when apiKey missing', () => {
      expect(isConfigured({
        email: 'bot@example.com',
        site: 'https://example.zulipchat.com'
      })).toBe(false);
    });

    test('returns false for null/undefined', () => {
      expect(isConfigured(null)).toBe(false);
      expect(isConfigured(undefined)).toBe(false);
    });
  });

  describe('HTML stripping (used in message parsing)', () => {
    // The plugin uses this regex: content.replace(/<[^>]*>/g, '')
    const stripHtml = (content) => content.replace(/<[^>]*>/g, '');

    test('removes simple tags', () => {
      expect(stripHtml('<p>Hello</p>')).toBe('Hello');
    });

    test('removes nested tags', () => {
      expect(stripHtml('<div><span>Hello</span></div>')).toBe('Hello');
    });

    test('removes tags with attributes', () => {
      expect(stripHtml('<a href="http://example.com">link</a>')).toBe('link');
    });

    test('handles Zulip-style formatted messages', () => {
      expect(stripHtml('<p>Hello <strong>world</strong>!</p>')).toBe('Hello world!');
    });

    test('leaves plain text unchanged', () => {
      expect(stripHtml('Hello world')).toBe('Hello world');
    });
  });
});

// ============================================
// MOCK TESTS - Fake network responses
// ============================================

describe('Mock Tests', () => {
  // Save original fetch
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset fetch mock before each test
    global.fetch = jest.fn();
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe('zulipApi', () => {
    const creds = {
      email: 'bot@example.com',
      apiKey: 'test-api-key',
      site: 'https://example.zulipchat.com'
    };

    test('makes GET request with correct auth header', async () => {
      global.fetch.mockResolvedValue({
        json: () => Promise.resolve({ result: 'success', user_id: 123 })
      });

      await zulipApi(creds, '/users/me');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];

      expect(url).toBe('https://example.zulipchat.com/api/v1/users/me');
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toMatch(/^Basic /);
    });

    test('makes POST request with form-encoded body', async () => {
      global.fetch.mockResolvedValue({
        json: () => Promise.resolve({ result: 'success', id: 456 })
      });

      await zulipApi(creds, '/messages', 'POST', {
        type: 'stream',
        to: 'general',
        content: 'Hello!'
      });

      const [url, opts] = global.fetch.mock.calls[0];

      expect(url).toBe('https://example.zulipchat.com/api/v1/messages');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(opts.body).toContain('type=stream');
      expect(opts.body).toContain('to=general');
    });

    test('returns parsed JSON response', async () => {
      const mockResponse = { result: 'success', messages: [{ id: 1 }] };
      global.fetch.mockResolvedValue({
        json: () => Promise.resolve(mockResponse)
      });

      const result = await zulipApi(creds, '/messages');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('actions.handleAction', () => {
    const mockAccount = {
      accountId: 'default',
      email: 'bot@example.com',
      apiKey: 'test-key',
      site: 'https://example.zulipchat.com'
    };

    // Mock resolveAccount to return our test account
    let originalResolveAccount;

    beforeEach(() => {
      originalResolveAccount = zulipPlugin.config.resolveAccount;
      zulipPlugin.config.resolveAccount = jest.fn(() => mockAccount);
    });

    afterEach(() => {
      zulipPlugin.config.resolveAccount = originalResolveAccount;
    });

    test('send action posts message to stream', async () => {
      global.fetch.mockResolvedValue({
        json: () => Promise.resolve({ result: 'success', id: 789 })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'send',
        params: { to: 'stream:general', message: 'Hello!', topic: 'greetings' },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe('789');
    });

    test('send action returns error on failure', async () => {
      global.fetch.mockResolvedValue({
        json: () => Promise.resolve({ result: 'error', msg: 'Stream not found' })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'send',
        params: { to: 'stream:nonexistent', message: 'Hello!' },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Stream not found');
    });

    test('react action adds reaction to message', async () => {
      global.fetch.mockResolvedValue({
        json: () => Promise.resolve({ result: 'success' })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'react',
        params: { messageId: '123', emoji: 'thumbs_up' },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(true);

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toContain('/messages/123/reactions');
      expect(opts.method).toBe('POST');
    });

    test('read action fetches messages', async () => {
      global.fetch.mockResolvedValue({
        json: () => Promise.resolve({
          result: 'success',
          messages: [
            { id: 1, sender_full_name: 'Alice', sender_email: 'alice@example.com',
              content: '<p>Hello</p>', subject: 'test', timestamp: 1234567890, reactions: [] }
          ]
        })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'read',
        params: { stream: 'general', topic: 'test', limit: 5 },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].sender).toBe('Alice');
      expect(result.messages[0].content).toBe('Hello'); // HTML stripped
    });

    test('returns error for unknown action', async () => {
      const result = await zulipPlugin.actions.handleAction({
        action: 'unknown_action',
        params: {},
        cfg: {},
        accountId: 'default'
      });

      expect(result.error).toContain('Unsupported action');
    });
  });
});
