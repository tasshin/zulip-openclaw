/**
 * Zulip Channel Plugin for OpenClaw
 * 
 * Provides bidirectional Zulip messaging with topic-aware routing,
 * reactions, and persona support.
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

// --- Plugin Runtime (set during registration) ---

let pluginRuntime = null;

function setPluginRuntime(runtime) {
  pluginRuntime = runtime;
}

function getPluginRuntime() {
  if (!pluginRuntime) throw new Error('Zulip plugin runtime not initialized');
  return pluginRuntime;
}

// --- Credentials ---

function loadCredentials() {
  const secretsPath = join(homedir(), '.openclaw', 'secrets', 'zulip.env');
  if (!existsSync(secretsPath)) return null;

  const content = readFileSync(secretsPath, 'utf-8');
  const creds = {};
  for (const line of content.split('\n')) {
    const [key, ...rest] = line.split('=');
    const value = rest.join('=').trim();
    if (key === 'ZULIP_EMAIL') creds.email = value;
    if (key === 'ZULIP_API_KEY') creds.apiKey = value;
    if (key === 'ZULIP_SITE') creds.site = value;
  }
  return (creds.email && creds.apiKey && creds.site) ? creds : null;
}

// --- Persona Routing (Optional) ---

function loadPersonasConfig() {
  const configPath = join(homedir(), '.openclaw', 'secrets', 'zulip-personas.json');
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn('[zulip] Failed to parse personas config:', err.message);
    return null;
  }
}

function resolvePersonaForMessage(config, streamName, messageText) {
  if (!config) return null;

  // Get available personas for this stream (or default)
  const streamPersonas = config.streams[streamName] ?? config.streams['*'] ?? [];
  if (streamPersonas.length === 0) return null;

  // If only one persona for stream, use it
  if (streamPersonas.length === 1) {
    return streamPersonas[0];
  }

  // Check message for persona triggers
  const messageStart = messageText.slice(0, 50).toLowerCase();
  for (const personaId of streamPersonas) {
    const persona = config.personas[personaId];
    if (!persona) continue;

    for (const trigger of persona.triggers) {
      if (messageStart.includes(trigger.toLowerCase())) {
        return personaId;
      }
    }
  }

  // Default to Ember if no match
  return 'ember';
}

function loadPersonaContent(config, personaId) {
  if (!config || !personaId) return null;

  const persona = config.personas[personaId];
  if (!persona) return null;

  // Expand ~ in personasDir
  const personasDir = config.personasDir.replace(/^~/, homedir());
  const filePath = join(personasDir, persona.file);

  if (!existsSync(filePath)) {
    console.warn(`[zulip] Persona file not found: ${filePath}`);
    return null;
  }

  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[zulip] Failed to read persona file: ${err.message}`);
    return null;
  }
}

// --- API Client ---

class RateLimitError extends Error {
  constructor(retryAfterSecs) {
    super(`Rate limited, retry after ${retryAfterSecs}s`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterSecs * 1000;
  }
}

async function zulipApi(creds, endpoint, method = 'GET', data, opts = {}) {
  const url = new URL(`/api/v1${endpoint}`, creds.site);
  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}` };

  let body;
  if (data && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(data).toString();
  }

  const fetchOpts = { method, headers, body };
  if (opts.timeoutMs) {
    fetchOpts.signal = AbortSignal.timeout(opts.timeoutMs);
  }

  const response = await fetch(url.toString(), fetchOpts);

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
    throw new RateLimitError(retryAfter);
  }

  return response.json();
}

// --- Channel Plugin Definition ---

const zulipPlugin = {
  id: 'zulip-openclaw',

  meta: {
    id: 'zulip-openclaw',
    label: 'Zulip',
    selectionLabel: 'Zulip (Bot API)',
    docsPath: '/channels/zulip',
    blurb: 'Zulip team chat with topic-aware routing.',
    aliases: ['zulip'],
  },

  capabilities: {
    chatTypes: ['direct', 'channel', 'thread'],
    reactions: true,
    threads: true,   // Zulip topics = threads
    media: true,
    nativeCommands: false,
  },

  config: {
    listAccountIds: (_cfg) => {
      const creds = loadCredentials();
      return creds ? ['default'] : [];
    },

    resolveAccount: (_cfg, accountId) => {
      const creds = loadCredentials();
      if (!creds) return null;
      return {
        accountId: accountId ?? 'default',
        name: 'Zulip Bot',
        email: creds.email,
        apiKey: creds.apiKey,
        site: creds.site,
        enabled: true,
        config: {},
      };
    },

    defaultAccountId: (_cfg) => 'default',

    isConfigured: (account) => Boolean(account?.email && account?.apiKey && account?.site),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.email && account.apiKey),
    }),
  },

  messaging: {
    normalizeTarget: (target) => {
      if (!target) return target;
      // Support formats: "stream:general", "private:user@email.com", raw stream name
      if (target.startsWith('stream:') || target.startsWith('private:')) return target;
      return `stream:${target}`;
    },
    targetResolver: {
      looksLikeId: (input) => input.startsWith('stream:') || input.startsWith('private:') || input.includes('@'),
      hint: '<stream:name|private:email>',
    },
  },

  outbound: {
    deliveryMode: 'direct',
    chunker: null,
    textChunkLimit: 10000, // Zulip supports long messages

    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const account = zulipPlugin.config.resolveAccount(cfg, accountId);
      if (!account) return { ok: false, error: 'No Zulip account configured' };

      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };

      let type = 'private';
      let target = to;
      let topic = replyToId ?? 'chat';

      if (to.startsWith('stream:')) {
        type = 'stream';
        target = to.slice(7);
      } else if (to.startsWith('private:')) {
        target = to.slice(8);
      }

      const data = { type, to: target, content: text };
      if (type === 'stream') data.topic = topic;

      const result = await zulipApi(creds, '/messages', 'POST', data);

      if (result.result === 'success') {
        return { channel: 'zulip-openclaw', ok: true, messageId: String(result.id) };
      }
      return { channel: 'zulip-openclaw', ok: false, error: result.msg };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, replyToId }) => {
      // TODO: Upload file to Zulip, then send message with attachment link
      // For now, send text with media URL
      const content = text ? `${text}\n${mediaUrl}` : mediaUrl;
      return zulipPlugin.outbound.sendText({ to, text: content, accountId, cfg, replyToId });
    },
  },

  actions: {
    listActions: ({ cfg }) => {
      const accounts = zulipPlugin.config.listAccountIds(cfg);
      if (accounts.length === 0) return [];
      return ['send', 'react', 'reactions', 'read', 'edit', 'delete'];
    },

    handleAction: async ({ action, params, cfg, accountId }) => {
      const account = zulipPlugin.config.resolveAccount(cfg, accountId);
      if (!account) return { error: 'No Zulip account configured' };

      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };

      if (action === 'send') {
        const to = params.to ?? params.target;
        const message = params.message ?? params.content ?? '';
        const topic = params.threadId ?? params.topic ?? 'chat';

        let type = 'private';
        let target = to;
        if (to?.startsWith('stream:')) {
          type = 'stream';
          target = to.slice(7);
        } else if (to?.startsWith('private:')) {
          target = to.slice(8);
        }

        const data = { type, to: target, content: message };
        if (type === 'stream') data.topic = topic;

        const result = await zulipApi(creds, '/messages', 'POST', data);
        return result.result === 'success'
          ? { ok: true, messageId: String(result.id) }
          : { ok: false, error: result.msg };
      }

      if (action === 'react') {
        const messageId = params.messageId;
        const emoji = params.emoji;
        const remove = params.remove ?? false;

        const method = remove ? 'DELETE' : 'POST';
        const result = await zulipApi(creds, `/messages/${messageId}/reactions`, method, { emoji_name: emoji });
        return { ok: result.result === 'success', error: result.msg };
      }

      if (action === 'reactions') {
        const messageId = params.messageId;
        const result = await zulipApi(creds, `/messages/${messageId}`);
        if (result.result === 'success') {
          const reactions = (result.message?.reactions ?? []).map(r => ({
            emoji: r.emoji_name,
            user: r.user?.full_name ?? 'unknown',
          }));
          return { ok: true, messageId, reactions };
        }
        return { ok: false, error: result.msg };
      }

      if (action === 'read') {
        const stream = params.channelId ?? params.stream;
        const topic = params.topic ?? params.threadId;
        const limit = params.limit ?? 10;

        const narrow = [];
        if (stream) {
          const streamName = stream.startsWith('stream:') ? stream.slice(7) : stream;
          narrow.push({ operator: 'stream', operand: streamName });
        }
        if (topic) narrow.push({ operator: 'topic', operand: topic });

        const queryParams = {
          narrow: JSON.stringify(narrow),
          num_before: String(limit),
          num_after: '0',
          anchor: 'newest',
        };
        const qs = new URLSearchParams(queryParams).toString();
        const result = await zulipApi(creds, `/messages?${qs}`);
        
        if (result.result === 'success') {
          const messages = (result.messages ?? []).reverse().map(m => ({
            id: String(m.id),
            sender: m.sender_full_name,
            senderEmail: m.sender_email,
            content: m.content.replace(/<[^>]*>/g, ''), // strip HTML
            topic: m.subject,
            timestamp: m.timestamp,
            reactions: (m.reactions ?? []).map(r => ({ emoji: r.emoji_name, user: r.user.full_name })),
          }));
          return { ok: true, messages };
        }
        return { ok: false, error: result.msg };
      }

      if (action === 'edit') {
        const messageId = params.messageId;
        const content = params.message ?? params.content;
        const result = await zulipApi(creds, `/messages/${messageId}`, 'PATCH', { content });
        return { ok: result.result === 'success', error: result.msg };
      }

      if (action === 'delete') {
        const messageId = params.messageId;
        const result = await zulipApi(creds, `/messages/${messageId}`, 'DELETE');
        return { ok: result.result === 'success', error: result.msg };
      }

      return { error: `Unsupported action: ${action}` };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };

      ctx.log?.info?.(`[zulip] Starting event poller for ${account.email}`);

      // Register event queue
      const registerResult = await zulipApi(creds, '/register', 'POST', {
        event_types: JSON.stringify(['message', 'reaction']),
      });

      if (registerResult.result !== 'success') {
        ctx.log?.error?.(`[zulip] Failed to register event queue: ${registerResult.msg}`);
        return;
      }

      let queueId = registerResult.queue_id;
      let lastEventId = registerResult.last_event_id;

      // Get our own user ID to filter self-messages
      const meResult = await zulipApi(creds, '/users/me');
      const myUserId = meResult.user_id;

      // Poll loop with 90s timeout (Zulip long-poll typically returns within 60s)
      const POLL_TIMEOUT_MS = 90_000;
      let consecutiveErrors = 0;

      const backoff = (errors) => {
        // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
        const ms = Math.min(5000 * Math.pow(2, errors - 1), 60_000);
        ctx.log?.info?.(`[zulip] Backing off for ${ms / 1000}s`);
        return new Promise(r => setTimeout(r, ms));
      };

      const reRegister = async () => {
        const reReg = await zulipApi(creds, '/register', 'POST', {
          event_types: JSON.stringify(['message', 'reaction']),
        });
        if (reReg.result === 'success') {
          queueId = reReg.queue_id;
          lastEventId = reReg.last_event_id;
          ctx.log?.info?.('[zulip] Re-registered event queue');
          return true;
        }
        ctx.log?.error?.(`[zulip] Re-registration failed: ${reReg.msg}`);
        return false;
      };

      const poll = async () => {
        while (!ctx.abortSignal?.aborted) {
          try {
            const qs = `queue_id=${encodeURIComponent(queueId)}&last_event_id=${lastEventId}`;
            const result = await zulipApi(creds, `/events?${qs}`, 'GET', undefined, { timeoutMs: POLL_TIMEOUT_MS });

            if (result.result !== 'success') {
              consecutiveErrors++;
              if (String(result.msg).includes('BAD_EVENT_QUEUE_ID')) {
                ctx.log?.warn?.('[zulip] Queue expired, re-registering...');
                if (!await reRegister()) {
                  await backoff(consecutiveErrors);
                }
              } else {
                ctx.log?.error?.(`[zulip] Poll failed: ${result.msg}`);
                await backoff(consecutiveErrors);
              }
              continue;
            }

            consecutiveErrors = 0;

            for (const event of result.events) {
              lastEventId = event.id;

              if (event.type === 'message') {
                const msg = event.message;
                if (msg.sender_id === myUserId) continue;

                const isStream = msg.type === 'stream';
                const chatId = isStream
                  ? `stream:${msg.display_recipient}`
                  : `private:${msg.sender_email}`;
                const from = isStream
                  ? `zulip:${msg.display_recipient}`
                  : `zulip:${msg.sender_id}`;
                const text = msg.content.replace(/<[^>]*>/g, '');

                ctx.log?.info?.(`[zulip] Received message from ${msg.sender_full_name} in ${chatId}`);

                // Fetch recent topic/DM context for ThreadStarterBody
                let threadStarterBody;
                try {
                  const contextNarrow = [];
                  if (isStream) {
                    contextNarrow.push({ operator: 'stream', operand: msg.display_recipient });
                    contextNarrow.push({ operator: 'topic', operand: msg.subject });
                  } else {
                    contextNarrow.push({ operator: 'dm', operand: [creds.email, msg.sender_email] });
                  }

                  const CONTEXT_LIMIT = 15;
                  const contextQs = new URLSearchParams({
                    narrow: JSON.stringify(contextNarrow),
                    num_before: String(CONTEXT_LIMIT),
                    num_after: '0',
                    anchor: String(msg.id),
                  }).toString();

                  const contextResult = await zulipApi(creds, `/messages?${contextQs}`);
                  if (contextResult.result === 'success' && contextResult.messages?.length > 0) {
                    const formatted = contextResult.messages.map(m => {
                      const name = m.sender_id === myUserId ? '(bot)' : m.sender_full_name;
                      const content = m.content.replace(/<[^>]*>/g, '');
                      const reactions = (m.reactions ?? []).map(r => r.emoji_name);
                      const reactStr = reactions.length > 0 ? ` [reacts: ${reactions.join(', ')}]` : '';
                      return `[${name}] (id:${m.id}) ${content}${reactStr}`;
                    }).join('\n');
                    const label = isStream
                      ? `Recent messages in #${msg.display_recipient} > ${msg.subject}`
                      : `Recent DM history`;
                    threadStarterBody = `${label}:\n${formatted}`;
                  }
                } catch (err) {
                  if (err instanceof RateLimitError) {
                    ctx.log?.warn?.(`[zulip] Rate limited fetching context, waiting ${err.retryAfterMs / 1000}s`);
                    await new Promise(r => setTimeout(r, err.retryAfterMs));
                  } else {
                    ctx.log?.warn?.(`[zulip] Failed to fetch context: ${err.message}`);
                  }
                }

                // Resolve persona for this message (if config exists)
                let personaContent = null;
                let personaDisplayName = null;
                const personasConfig = loadPersonasConfig();
                if (personasConfig && isStream) {
                  const personaId = resolvePersonaForMessage(personasConfig, msg.display_recipient, text);
                  if (personaId) {
                    personaContent = loadPersonaContent(personasConfig, personaId);
                    if (personaContent) {
                      // Get display name from first trigger (capitalized)
                      const persona = personasConfig.personas[personaId];
                      personaDisplayName = persona?.triggers?.[0] ?? personaId;
                      ctx.log?.info?.(`[zulip] Using persona: ${personaDisplayName}`);
                    }
                  }
                }

                // Dispatch through OpenClaw's inbound message system
                try {
                  const runtime = getPluginRuntime();
                  const cfg = runtime.config.loadConfig();

                  // Resolve agent route for this message
                  const peer = isStream
                    ? { kind: 'channel', id: `${msg.display_recipient}:${msg.subject}` }
                    : { kind: 'direct', id: String(msg.sender_id) };
                  const route = runtime.channel.routing.resolveAgentRoute({
                    channel: 'zulip-openclaw',
                    accountId: account.accountId,
                    peer,
                    cfg,
                  });

                  // Build inbound context (matching OpenClaw's expected shape)
                  // Prepend persona content to thread starter body if available
                  let fullThreadStarterBody = threadStarterBody;
                  if (personaContent) {
                    const personaSection = `You are responding as this persona:\n---\n${personaContent}\n---\n\nDo not prefix your response with your name — the system will add it automatically.\n\n`;
                    fullThreadStarterBody = personaSection + (threadStarterBody ?? '');
                  }

                  const inboundCtx = runtime.channel.reply.finalizeInboundContext({
                    Body: text,
                    RawBody: text,
                    From: from,
                    To: `zulip:${account.email}`,
                    SessionKey: route.sessionKey,
                    AccountId: route.accountId,
                    ChatType: isStream ? 'group' : 'direct',
                    SenderName: msg.sender_full_name,
                    SenderId: String(msg.sender_id),
                    SenderUsername: msg.sender_email,
                    Provider: 'zulip-openclaw',
                    Surface: 'zulip',
                    MessageSid: String(msg.id),
                    Timestamp: msg.timestamp * 1000,
                    ThreadId: isStream ? msg.subject : undefined,
                    GroupSubject: isStream ? msg.display_recipient : undefined,
                    CommandAuthorized: true,
                    ThreadStarterBody: fullThreadStarterBody,
                  });

                  // Send reply back to Zulip
                  const replyTarget = isStream ? msg.display_recipient : msg.sender_email;
                  const replyType = isStream ? 'stream' : 'private';
                  const replyTopic = isStream ? msg.subject : undefined;

                  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                    ctx: inboundCtx,
                    cfg,
                    dispatcherOptions: {
                      deliver: async (payload) => {
                        let replyText = typeof payload === 'string' ? payload : (payload.body ?? payload.text ?? '');
                        if (!replyText) return;

                        // Prefix with persona name if available
                        if (personaDisplayName) {
                          replyText = `[${personaDisplayName}] ${replyText}`;
                        }

                        const data = { type: replyType, to: replyTarget, content: replyText };
                        if (replyTopic) data.topic = replyTopic;

                        const sendResult = await zulipApi(creds, '/messages', 'POST', data);
                        if (sendResult.result !== 'success') {
                          ctx.log?.error?.(`[zulip] Failed to send reply: ${sendResult.msg}`);
                        }
                      },
                      onError: (err) => {
                        ctx.log?.error?.(`[zulip] Dispatch error: ${String(err)}`);
                      },
                    },
                  });
                } catch (dispatchErr) {
                  if (dispatchErr instanceof RateLimitError) {
                    ctx.log?.warn?.(`[zulip] Rate limited during dispatch, waiting ${dispatchErr.retryAfterMs / 1000}s`);
                    await new Promise(r => setTimeout(r, dispatchErr.retryAfterMs));
                  } else {
                    ctx.log?.error?.(`[zulip] Failed to dispatch message: ${dispatchErr.message}`);
                  }
                }
              }
            }
          } catch (err) {
            if (err.name === 'TimeoutError') {
              // Normal — long-poll timed out with no events, just retry
              continue;
            }
            if (err instanceof RateLimitError) {
              ctx.log?.warn?.(`[zulip] Rate limited, waiting ${err.retryAfterMs / 1000}s`);
              await new Promise(r => setTimeout(r, err.retryAfterMs));
              continue;
            }
            consecutiveErrors++;
            ctx.log?.error?.(`[zulip] Poll error: ${err.message}`);
            await backoff(consecutiveErrors);
          }
        }
      };

      poll();
    },
  },

  status: {
    probeAccount: async ({ account, timeoutMs }) => {
      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };
      try {
        const result = await zulipApi(creds, '/users/me');
        return result.user_id
          ? { ok: true, name: result.full_name }
          : { ok: false, error: result.msg };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
};

// --- Export & Registration ---

module.exports = { zulipPlugin, zulipApi, loadCredentials, setPluginRuntime, RateLimitError };
