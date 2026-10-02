import { WebSocketServer } from 'ws';
import { mongoDb, redisClient, firebaseAdmin, supabase, supabaseAdmin } from '../config/db.js';
import jwt from 'jsonwebtoken';
import logger from '../middleware/logger.js';
import crypto from 'crypto';
import { createLocationEventBus } from './locationEventBus.js';
import telemetryBuffer from './telemetryBuffer.js';
import GpsLog from '../models/GpsLog.js';
import { scheduleEtaRecalculationOnLocationUpdate } from '../services/order/etaService.js';
import DeliveryDelayService from '../services/order/deliveryDelayService.js';
import { calculateAdaptiveInterval, getQueueDepth } from './adaptivePoller.js';

const TELEMETRY_SCHEMA = {
  lat: { type: 'number', required: false, min: -90, max: 90 },
  lng: { type: 'number', required: false, min: -180, max: 180 },
  latitude: { type: 'number', required: false, min: -90, max: 90 },
  longitude: { type: 'number', required: false, min: -180, max: 180 },
  driver_id: { type: 'string', required: false, minLen: 1, maxLen: 64 },
  speed: { type: 'number', required: false, min: 0, max: 200 },
  bearing: { type: 'number', required: false, min: 0, max: 360 },
  device_timestamp: { type: 'string', required: false, maxLen: 64 },
  order_id: { type: 'string', required: false, maxLen: 64 },
  orderId: { type: 'string', required: false, maxLen: 64 },
  order_display_id: { type: 'string', required: false, maxLen: 64 },
};

function validateTelemetryPayload(data) {
  const errors = [];

  const hasLatLng = data.lat !== undefined && data.lat !== null && data.lng !== undefined && data.lng !== null;
  const hasLatLong = data.latitude !== undefined && data.latitude !== null && data.longitude !== undefined && data.longitude !== null;
  
  if (!hasLatLng && !hasLatLong) {
    errors.push('At least one coordinate pair (lat/lng or latitude/longitude) is required');
  }

  for (const [field, rules] of Object.entries(TELEMETRY_SCHEMA)) {
    const value = data[field];
    if (rules.required && (value === undefined || value === null)) {
      errors.push(`${field} is required`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (rules.type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
      errors.push(`${field} must be a valid number`);
    }
    if (rules.type === 'string' && typeof value !== 'string') {
      errors.push(`${field} must be a string`);
    }
    if (rules.min !== undefined && value < rules.min) errors.push(`${field} must be >= ${rules.min}`);
    if (rules.max !== undefined && value > rules.max) errors.push(`${field} must be <= ${rules.max}`);
    if (rules.minLen !== undefined && String(value).length < rules.minLen) errors.push(`${field} is too short`);
    if (rules.maxLen !== undefined && String(value).length > rules.maxLen) errors.push(`${field} exceeds max length ${rules.maxLen}`);
  }
  return errors.length > 0 ? errors : null;
}

function sanitizeTelemetryData(data) {
  const sanitized = {};
  for (const [field, rules] of Object.entries(TELEMETRY_SCHEMA)) {
    const value = data[field];
    if (value !== undefined && value !== null) {
      sanitized[field] = rules.type === 'number' ? Number(value) : String(value);
    }
  }
  return sanitized;
}

let _orderRepository = null;
let _deliveryDelayService = null;

let trackingSubscriptions = new Map();
let redisSubClient = null;
const TRACKER_CHANNELS = {
  LOCATION: 'tracker:location_updates',
  MILESTONE: 'tracker:milestone_updates',
  ETA: 'tracker:eta_updates',
};

function deliverToLocalSubscribers(targetId, payload) {
  if (!targetId || !trackingSubscriptions.has(targetId)) return;
  const clients = trackingSubscriptions.get(targetId);
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

function initRedisTrackerPubSub() {
  if (!redisClient || redisSubClient) return;

  try {
    redisSubClient = redisClient.duplicate();
    redisSubClient.subscribe(TRACKER_CHANNELS.LOCATION, TRACKER_CHANNELS.MILESTONE, TRACKER_CHANNELS.ETA, (err) => {
      if (err) {
        logger.error({ err }, '[Tracker] Failed to subscribe to Redis tracker channels');
      } else {
        logger.info('[Tracker] Subscribed to Redis Pub/Sub tracker channels for multi-replica broadcasting');
      }
    });

    redisSubClient.on('message', (channel, message) => {
      try {
        const parsed = JSON.parse(message);
        if (channel === TRACKER_CHANNELS.LOCATION) {
          const { orderDisplayId, driver_id, payload } = parsed;
          if (orderDisplayId) deliverToLocalSubscribers(orderDisplayId, payload);
          if (driver_id) deliverToLocalSubscribers(driver_id, payload);
        } else if (channel === TRACKER_CHANNELS.MILESTONE) {
          const { orderDisplayId, payload } = parsed;
          if (orderDisplayId) deliverToLocalSubscribers(orderDisplayId, payload);
        } else if (channel === TRACKER_CHANNELS.ETA) {
          const { orderDisplayId, payload } = parsed;
          if (orderDisplayId) deliverToLocalSubscribers(orderDisplayId, payload);
        }
      } catch (err) {
        logger.error({ err }, '[Tracker] Error handling Pub/Sub message');
      }
    });
  } catch (err) {
    logger.error({ err }, '[Tracker] Redis Pub/Sub initialization error');
  }
}

const locationChannels = new Map();
const displayIdToLocationChannelKeys = new Map();
const driverToLocationChannels = new Map();
let locationEventBus = null;

export const CLOCK_SKEW_TOLERANCE_MS = parseInt(process.env.CLOCK_SKEW_TOLERANCE_MS, 10) || 300000;
const MAX_CONSECUTIVE_DROPS = 10;
const consecutiveDropCount = new Map();

const TRACKER_DRIVER_STATE_TTL_MS = parseInt(process.env.TRACKER_DRIVER_STATE_TTL_MS, 10) || 900000;
const DRIVER_STATE_SWEEP_INTERVAL_MS = parseInt(process.env.DRIVER_STATE_SWEEP_INTERVAL_MS, 10) || 60000;
let lastDriverStateSweep = 0;

function sweepStaleDriverState(now) {
  if (now - lastDriverStateSweep < DRIVER_STATE_SWEEP_INTERVAL_MS) return;
  lastDriverStateSweep = now;
  for (const [driverId, entry] of consecutiveDropCount) {
    if (now - entry.lastUpdated > TRACKER_DRIVER_STATE_TTL_MS) {
      consecutiveDropCount.delete(driverId);
    }
  }
}

let isSchedulerActive = false;
let telemetryFlushTimeout = null;
let wsServer = null;
let wsHeartbeatInterval = null;
let telemetryMonitorInterval = null;
let driverStateSweepInterval = null;
let wsUpgradeLimitsCleanupInterval = null;
let messageRateTrackerCleanupInterval = null;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS, 10) || 180000;

const WS_UPGRADE_RATE_LIMIT = 5;
const WS_UPGRADE_RATE_WINDOW_SECONDS = 60;
const MAX_MSG_PER_SECOND = 10;
const WS_MAX_PAYLOAD_BYTES = 4096;
const messageRateTracker = new Map();
const WS_AUTH_TIMEOUT_MS = 10000;

const GPS_LOG_RETRY_DELAYS_MS = [100, 200, 400];
const GPS_LOG_MAX_RETRIES = 5;
const GPS_LOG_DLQ_KEY = 'gps_log_dlq';

const DRIVER_ORDER_CACHE_TTL_SECONDS = 60;
const DRIVER_ORDER_CACHE_KEY_PREFIX = 'driver:active-order:';

async function getCachedDriverOrder(driverId) {
  if (!driverId) return null;
  if (!redisClient) return null;
  try {
    const cached = await redisClient.get(`${DRIVER_ORDER_CACHE_KEY_PREFIX}${driverId}`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.error({ err, driverId }, 'Redis driver order cache get error');
  }
  return null;
}

async function setCachedDriverOrder(driverId, orderId, orderDisplayId) {
  if (!driverId) return;
  if (!redisClient || !orderId) return;
  try {
    await redisClient.set(
      `${DRIVER_ORDER_CACHE_KEY_PREFIX}${driverId}`,
      JSON.stringify({ orderId, orderDisplayId }),
      'EX',
      DRIVER_ORDER_CACHE_TTL_SECONDS,
    );
  } catch (err) {
    logger.error({ err, driverId }, 'Redis driver order cache set error');
  }
}

async function invalidateDriverOrderCache(driverId) {
  if (!driverId) return;
  if (!redisClient) return;
  try {
    await redisClient.del(`${DRIVER_ORDER_CACHE_KEY_PREFIX}${driverId}`);
  } catch (err) {
    logger.error({ err, driverId }, 'Redis driver order cache invalidate error');
  }
}

function getClientIp(request) {
  return request.socket?.remoteAddress || request.connection?.remoteAddress || 'unknown';
}

export { getClientIp };

const wsUpgradeMemoryLimits = new Map();

function enforceWsUpgradeMemoryLimit(ipAddress) {
  const now = Date.now();
  const windowMs = WS_UPGRADE_RATE_WINDOW_SECONDS * 1000;
  let entry = wsUpgradeMemoryLimits.get(ipAddress);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    wsUpgradeMemoryLimits.set(ipAddress, entry);
  }
  entry.count++;
  if (wsUpgradeMemoryLimits.size > 10000) {
    for (const [key, e] of wsUpgradeMemoryLimits) {
      if (now >= e.resetAt) wsUpgradeMemoryLimits.delete(key);
    }
  }
  return entry.count <= WS_UPGRADE_RATE_LIMIT;
}

const WS_UPGRADE_LIMITS_SWEEP_INTERVAL_MS = 30000;

function sweepWsUpgradeMemoryLimits() {
  const now = Date.now();
  for (const [key, e] of wsUpgradeMemoryLimits) {
    if (now >= e.resetAt) wsUpgradeMemoryLimits.delete(key);
  }
}

export async function isWebSocketUpgradeAllowed(request) {
  const ipAddress = getClientIp(request);
  const key = `ws:upgrade:${ipAddress}`;

  if (!redisClient) {
    return enforceWsUpgradeMemoryLimit(ipAddress);
  }

  try {
    const attempts = await redisClient.incr(key);

    if (attempts === 1) {
      await redisClient.expire(key, WS_UPGRADE_RATE_WINDOW_SECONDS);
    } else {
      const ttl = await redisClient.ttl(key);
      if (ttl === -1) {
        await redisClient.expire(key, WS_UPGRADE_RATE_WINDOW_SECONDS);
      }
    }

    return attempts <= WS_UPGRADE_RATE_LIMIT;
  } catch (err) {
    logger.error({ err: err?.message }, 'Redis WebSocket upgrade rate limit error');
    return enforceWsUpgradeMemoryLimit(ipAddress);
  }
}

export function rejectWebSocketUpgrade(socket) {
  socket.write(
    'HTTP/1.1 429 Too Many Requests\r\n' +
    'Connection: close\r\n' +
    '\r\n'
  );
  socket.destroy();
}

export function rejectConnectionWithTokenInUrl(ws, reqUrl) {
  const urlToken = reqUrl.searchParams.get('token');
  if (!urlToken) return false;
  logger.warn(
    { event: 'WS_TOKEN_IN_URL' },
    'WebSocket auth token present in URL query string; refusing connection',
  );
  ws.send(JSON.stringify({
    error: 'Unauthorized: auth token must not be sent in the URL query string',
    code: 4001,
  }));
  ws.close(4001, 'Auth token must not be sent in the URL query string');
  return true;
}

async function authenticateWs(ws, token) {
  if (!token) {
    ws.send(JSON.stringify({ error: 'Unauthorized: No token provided', code: 4001 }));
    ws.close(4001, 'Unauthorized: No token provided');
    return;
  }

  try {
    let decoded = null;
    try {
      decoded = jwt.decode(token);
    } catch (err) {
      logger.warn({ err: err?.message || err }, '[Tracker] Failed to decode JWT token structure');
    }

    const isSupabaseToken = decoded &&
      typeof decoded === 'object' &&
      typeof decoded.iss === 'string' &&
      (decoded.iss.includes('supabase') || decoded.iss.includes('supabase.co'));
    let profile = null;

    if (isSupabaseToken) {
      if (!supabase) {
        ws.send(JSON.stringify({ error: 'Unauthorized: Supabase client is not configured', code: 4001 }));
        ws.close(4001, 'Unauthorized: Supabase client is not configured');
        return;
      }
      const response = await supabase.auth.getUser(token);
      const user = response?.data?.user;
      const authError = response?.error;
      if (authError || !user) {
        ws.send(JSON.stringify({ error: 'Unauthorized: Invalid or expired Supabase token', code: 4001 }));
        ws.close(4001, 'Unauthorized: Invalid or expired Supabase token');
        return;
      }

      const { data: userProfile, error } = await supabase
        .from('profiles')
        .select('id, firebase_uid, role')
        .eq('id', user.id)
        .eq('is_active', true)
        .maybeSingle();

      if (error || !userProfile) {
        ws.send(JSON.stringify({ error: 'Unauthorized: User profile not found', code: 4001 }));
        ws.close(4001, 'Unauthorized: User profile not found');
        return;
      }
      profile = userProfile;
    } else {
      if (!firebaseAdmin) {
        ws.send(JSON.stringify({ error: 'Unauthorized: Firebase Auth is not configured', code: 4001 }));
        ws.close(4001, 'Unauthorized: Firebase Auth is not configured');
        return;
      }
      const decodedToken = await firebaseAdmin.auth().verifyIdToken(token, true);
      if (!supabase) {
        ws.send(JSON.stringify({ error: 'Unauthorized: Profile lookup is not configured', code: 4001 }));
        ws.close(4001, 'Unauthorized: Profile lookup is not configured');
        return;
      }

      const { data: userProfile, error } = await supabase
        .from('profiles')
        .select('id, firebase_uid, role')
        .eq('firebase_uid', decodedToken.uid)
        .eq('is_active', true)
        .maybeSingle();

      if (error || !userProfile) {
        ws.send(JSON.stringify({ error: 'Unauthorized: User profile not found', code: 4001 }));
        ws.close(4001, 'Unauthorized: User profile not found');
        return;
      }
      profile = userProfile;
    }

    ws.user = {
      id: profile.id,
      uid: profile.firebase_uid,
      role: profile.role,
    };
    if (profile.role === 'driver') {
      ws.driverId = profile.id;
    }
    ws.authenticated = true;
    await restoreSubscriptions(ws);
    logger.info({ userId: ws.user.id }, 'WS Authenticated user');
  } catch (err) {
    logger.error({ err }, 'WS Auth failed');
    ws.send(JSON.stringify({ error: 'Unauthorized: Invalid token', code: 4001 }));
    ws.close(4001, 'Unauthorized: Invalid token');
  }
}

function buildClientLocationPayload({ driverId, orderDisplayId, lat, lng, speed, bearing, timestampIso }) {
  return JSON.stringify({
    event: 'location_update',
    data: {
      driver_id: driverId,
      order_display_id: orderDisplayId,
      latitude: lat,
      longitude: lng,
      speed,
      bearing,
      timestamp: timestampIso,
    },
  });
}

function buildClientPayloadFromInternalEvent(event) {
  return buildClientLocationPayload({
    driverId: event.driverId,
    orderDisplayId: event.orderDisplayId,
    lat: event.location.lat,
    lng: event.location.lng,
    speed: event.location.speed,
    bearing: event.location.bearing,
    timestampIso: event.timestamp,
  });
}

function deliverLocationToLocalSubscribers(subscriptionMap, payload, orderDisplayId, driverId, metricsBus) {
  const bus = metricsBus || locationEventBus;
  const deliveredSockets = new Set();
  let delivered = 0;

  if (orderDisplayId && subscriptionMap.has(orderDisplayId)) {
    for (const client of subscriptionMap.get(orderDisplayId)) {
      if (client.readyState === 1 && !deliveredSockets.has(client)) {
        deliveredSockets.add(client);
        client.send(payload);
        delivered++;
      }
    }
  }

  if (driverId && subscriptionMap.has(driverId)) {
    for (const client of subscriptionMap.get(driverId)) {
      if (client.readyState === 1 && !deliveredSockets.has(client)) {
        deliveredSockets.add(client);
        client.send(payload);
        delivered++;
      }
    }
  }

  bus?.recordDelivery(delivered);
  return delivered;
}

function createLocationEventHandler(targetBus, subscriptionMap) {
  return (event) => {
    const bus = targetBus || locationEventBus;
    if (!bus) return;
    if (event.sourceInstanceId === bus.getInstanceId()) return;

    const payload = buildClientPayloadFromInternalEvent(event);
    const map = subscriptionMap || trackingSubscriptions;
    const delivered = deliverLocationToLocalSubscribers(map, payload, event.orderDisplayId, event.driverId, bus);
    if (delivered === 0) {
      bus.recordNoSubscribers();
    }
  };
}

export function initWebSocketServer(server, orderRepository) {
  if (wsServer) {
    logger.warn('[initWebSocketServer] Already initialized — skipping duplicate call to prevent connection leaks.');
    return;
  }

  _orderRepository = orderRepository;
  _deliveryDelayService = orderRepository ? new DeliveryDelayService({ orderRepository }) : null;
  const MAX_WS_PAYLOAD_BYTES = parseInt(process.env.WS_MAX_PAYLOAD_BYTES, 10) || 4096;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  wsServer = wss;

  if (!locationEventBus) {
    locationEventBus = createLocationEventBus();
    locationEventBus.init(redisClient);
    locationEventBus.subscribe(createLocationEventHandler());
  }

  server.on('upgrade', async (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (pathname === '/ws/tracking') {
      const allowed = await isWebSocketUpgradeAllowed(request);

      if (!allowed) {
        rejectWebSocketUpgrade(socket);
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws, req) => {
    ws._request = req;
    ws.socketId = ws.socketId || crypto.randomUUID();
    const reqUrl = new URL(req.url, 'http://localhost');
    const bypassAuth = process.env.BYPASS_AUTH === 'true';

    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (message) => {
      handleTrackingMessage(ws, message, req);
    });

    ws.on('close', () => {
      logger.info({ event: 'WS_CONNECTION_CLOSED', socketId: ws.socketId }, 'WebSocket connection closed');
      ws.pendingAuthQueue = [];
      ws.isAuthenticating = false;
      void (async () => {
        await removeClientFromAllSubscriptions(ws);
        if (ws.driverId) await removeDriverLocationChannels(ws.driverId);
      })();
    });

    ws.on('error', (err) => {
      logger.error({ event: 'WS_CLIENT_ERROR', socketId: ws.socketId, err }, 'WebSocket client error');
      void (async () => {
        await removeClientFromAllSubscriptions(ws);
        if (ws.driverId) await removeDriverLocationChannels(ws.driverId);
      })();
    });

    if (rejectConnectionWithTokenInUrl(ws, reqUrl)) {
      return;
    }

    if (bypassAuth) {
      if (process.env.NODE_ENV === 'production') {
        ws.send(JSON.stringify({ error: 'BYPASS_AUTH is not allowed in production', code: 4003 }));
        ws.close(4003, 'BYPASS_AUTH is not allowed in production');
        return;
      }
      const devToken = reqUrl.searchParams.get('dev_access_token');
      if (!devToken || !process.env.DEV_ACCESS_TOKEN || devToken !== process.env.DEV_ACCESS_TOKEN) {
        ws.send(JSON.stringify({ error: 'Unauthorized: Missing or invalid dev_access_token', code: 4001 }));
        ws.close(4001, 'Unauthorized: Missing or invalid dev_access_token');
        return;
      }
      ws.driverId = reqUrl.searchParams.get('driver_id') || 'test_driver';
      ws.user = {
        id: reqUrl.searchParams.get('user_id') || ws.driverId,
        role: reqUrl.searchParams.get('user_role') || 'driver',
      };
      ws.authenticated = true;
      logger.warn({ event: 'WS_BYPASS_AUTH_USED', driverId: ws.driverId, role: ws.user.role }, 'WS Auth bypassed via DEV_ACCESS_TOKEN');
      logger.info({ event: 'WS_CONNECTION_ESTABLISHED', socketId: ws.socketId }, 'New WebSocket connection established on /ws/tracking');
      return;
    }

    ws.authenticated = false;
    ws.isAuthenticating = false;
    ws.pendingAuthQueue = [];
    const authTimeout = setTimeout(() => {
      if (ws.authenticated === false) {
        ws.send(JSON.stringify({ error: 'Unauthorized: Authentication timeout', code: 4001 }));
        ws.close(4001, 'Unauthorized: Authentication timeout');
      }
    }, WS_AUTH_TIMEOUT_MS);
    ws.once('close', () => clearTimeout(authTimeout));
    logger.info({ event: 'WS_CONNECTION_AWAITING_AUTH', socketId: ws.socketId }, 'New WebSocket connection established on /ws/tracking (awaiting first-frame auth)');
  });

  wsHeartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        logger.info({ event: 'WS_CLIENT_TERMINATED_UNRESPONSIVE', socketId: ws.socketId }, 'Terminating unresponsive WebSocket client');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    if (wsHeartbeatInterval) {
      clearInterval(wsHeartbeatInterval);
      wsHeartbeatInterval = null;
    }
    if (messageRateTrackerCleanupInterval) {
      clearInterval(messageRateTrackerCleanupInterval);
      messageRateTrackerCleanupInterval = null;
    }
  });

  messageRateTrackerCleanupInterval = setInterval(() => {
    sweepMessageRateTracker();
  }, 30000);

  wsUpgradeLimitsCleanupInterval = setInterval(() => {
    sweepWsUpgradeMemoryLimits();
  }, WS_UPGRADE_LIMITS_SWEEP_INTERVAL_MS);

  driverStateSweepInterval = setInterval(() => {
    sweepStaleDriverState(Date.now());
  }, DRIVER_STATE_SWEEP_INTERVAL_MS);

  if (!isSchedulerActive) {
    telemetryBuffer.start();
  }

  logger.info('🚀 WebSocket tracking router initialized.');
}

function isMessageRateLimitedInMemory(ws) {
  const now = Date.now();
  const id = ws.socketId || ws;
  let state = messageRateTracker.get(id);
  if (!state || now - state.windowStart >= 1000) {
    state = { count: 0, windowStart: now };
    messageRateTracker.set(id, state);
  }
  state.count++;
  return state.count > MAX_MSG_PER_SECOND;
}

const MESSAGE_RATE_TRACKER_SWEEP_INTERVAL_MS = 30000;

function sweepMessageRateTracker() {
  const now = Date.now();
  for (const [id, state] of messageRateTracker) {
    if (now - state.windowStart > 1000) {
      messageRateTracker.delete(id);
    }
  }
}

export async function isMessageRateLimited(ws) {
  if (redisClient && redisClient.status === 'ready') {
    try {
      const bucket = Math.floor(Date.now() / 1000);
      const key = `ws:msg:${ws.socketId || ws.driverId || 'anon'}:${bucket}`;
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, 2);
      }
      return count > MAX_MSG_PER_SECOND;
    } catch (err) {
      logger.warn(
        { err: err?.message },
        'Redis WS message rate limit failed, falling back to in-memory',
      );
    }
  }
  return isMessageRateLimitedInMemory(ws);
}

export async function handleTrackingMessage(ws, message, req) {
  if (await isMessageRateLimited(ws)) {
    ws.send(JSON.stringify({ error: 'Rate limit exceeded: too many messages per second', code: 429, retryAfter: 1 }));
    return;
  }

  const messageText = message.toString();

  if (messageText === 'ping') {
    ws.isAlive = true;
    return ws.send('pong');
  }

  try {
    const payload = JSON.parse(messageText);
    const { event, data } = payload;

    if (!event || !data) {
      return ws.send(JSON.stringify({ error: 'Invalid payload format. Must include "event" and "data" keys.' }));
    }

    if (ws.isAuthenticating) {
      if (!ws.pendingAuthQueue) {
        ws.pendingAuthQueue = [];
      }
      if (ws.pendingAuthQueue.length < 50) {
        ws.pendingAuthQueue.push({ message, req });
      } else {
        ws.send(JSON.stringify({ error: 'Queue limit exceeded during authentication', code: 4008 }));
        ws.close(4008, 'Queue limit exceeded during authentication');
      }
      return;
    }

    if (ws.authenticated === false) {
      if (event === 'auth') {
        ws.isAuthenticating = true;
        try {
          await authenticateWs(ws, data.token);
          if (ws.authenticated) {
            ws.send(JSON.stringify({
              status: 'authenticated',
              user_id: ws.user?.id ?? ws.driverId,
            }));
            logger.info({ event: 'WS_AUTHENTICATED', socketId: ws.socketId }, 'New WebSocket connection authenticated');
          }
        } finally {
          ws.isAuthenticating = false;
        }

        if (ws.pendingAuthQueue && ws.pendingAuthQueue.length > 0) {
          const queue = ws.pendingAuthQueue;
          ws.pendingAuthQueue = [];
          for (const queued of queue) {
            handleTrackingMessage(ws, queued.message, queued.req);
          }
        }
        return;
      } else {
        ws.send(JSON.stringify({ error: 'Unauthorized: First message must be an "auth" event with a token', code: 4001 }));
        ws.close(4001, 'Unauthorized: First message must be an auth event');
        return;
      }
    }

    // Additional message event routing goes here...
  } catch (err) {
    logger.error({ event: 'WS_MESSAGE_HANDLER_ERROR', socketId: ws.socketId, err }, 'Error handling incoming WebSocket message');
    ws.send(JSON.stringify({ error: 'Invalid JSON payload' }));
  }
}
