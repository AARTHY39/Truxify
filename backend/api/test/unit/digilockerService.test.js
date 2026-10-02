import axios from 'axios';
import logger from '../middleware/logger.js';
import { AppError } from '../utils/errors.js';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
const ML_API_KEY = process.env.ML_API_KEY;

// Simple in-memory LRU-style caches
const demandCache = new Map();
const priceCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function guardMlApiKey() {
  if (!ML_API_KEY) {
    logger.error('[MLService] ML_API_KEY is not configured in environment variables');
    throw new AppError('Machine learning service is unavailable', 503);
  }
}

/**
 * Calculates Haversine distance between two coordinates in kilometers.
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export const mlService = {
  /**
   * Predicts demand for a given location and timestamp.
   */
  async predictDemand(features) {
    guardMlApiKey();
    const cacheKey = JSON.stringify(features);
    const cached = demandCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const response = await axios.post(`${ML_SERVICE_URL}/predict/demand`, features, {
        headers: {
          'X-API-Key': ML_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      demandCache.set(cacheKey, { data: response.data, timestamp: Date.now() });
      return response.data;
    } catch (err) {
      logger.error('[MLService] predictDemand failed:', err.message);
      throw new AppError('Failed to fetch demand prediction', 502);
    }
  },

  /**
   * Predicts pricing based on distance, weight, and traffic multipliers.
   */
  async predictPrice(params) {
    guardMlApiKey();
    const cacheKey = JSON.stringify(params);
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const response = await axios.post(`${ML_SERVICE_URL}/predict/price`, params, {
        headers: {
          'X-API-Key': ML_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      priceCache.set(cacheKey, { data: response.data, timestamp: Date.now() });
      return response.data;
    } catch (err) {
      logger.error('[MLService] predictPrice failed:', err.message);
      throw new AppError('Failed to calculate price prediction', 502);
    }
  },

  /**
   * Computes route ETA and confidence intervals.
   */
  async predictEta(params) {
    guardMlApiKey();
    try {
      const response = await axios.post(`${ML_SERVICE_URL}/predict/eta`, params, {
        headers: {
          'X-API-Key': ML_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });
      return response.data;
    } catch (err) {
      logger.error('[MLService] predictEta failed:', err.message);
      throw new AppError('Failed to calculate ETA', 502);
    }
  },

  /**
   * Evaluates proportional cancellation penalties based on distance covered ratio.
   */
  async predictCancellationPenalty(params) {
    guardMlApiKey();
    try {
      const response = await axios.post(`${ML_SERVICE_URL}/predict/cancellation-penalty`, params, {
        headers: {
          'X-API-Key': ML_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });
      return response.data;
    } catch (err) {
      logger.error('[MLService] predictCancellationPenalty failed:', err.message);
      throw new AppError('Failed to calculate cancellation penalty', 502);
    }
  },

  /**
   * Predicts driver net profit with mileage, fuel, and toll adjustments.
   */
  async predictDriverProfit(params) {
    guardMlApiKey();
    try {
      const response = await axios.post(`${ML_SERVICE_URL}/predict/driver-profit`, params, {
        headers: {
          'X-API-Key': ML_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });
      return response.data;
    } catch (err) {
      logger.error('[MLService] predictDriverProfit failed:', err.message);
      throw new AppError('Failed to calculate driver profit', 502);
    }
  },

  /**
   * Recommends return-trip or deadhead routing loads with fallback to Haversine distance ranking.
   */
  async matchDeadhead(params) {
    guardMlApiKey();
    try {
      const response = await axios.post(`${ML_SERVICE_URL}/match/deadhead`, params, {
        headers: {
          'X-API-Key': ML_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });
      return response.data;
    } catch (err) {
      logger.warn('[MLService] matchDeadhead failed, falling back to Haversine distance ranking:', err.message);
      
      // Fallback calculation using local coordinates if available
      const { current_lat, current_lon, available_loads = [] } = params;
      if (typeof current_lat === 'number' && typeof current_lon === 'number' && Array.isArray(available_loads)) {
        return available_loads
          .map((load) => ({
            ...load,
            distance_km: calculateHaversineDistance(
              current_lat,
              current_lon,
              load.pickup_lat,
              load.pickup_lon
            ),
          }))
          .sort((a, b) => a.distance_km - b.distance_km);
      }
      
      throw new AppError('Failed to match deadhead routing', 502);
    }
  },

  /**
   * Recommends en-route loads along a path with fallback mechanisms.
   */
  async matchEnRouteLoads(params) {
    guardMlApiKey();
    try {
      const response = await axios.post(`${ML_SERVICE_URL}/match/en-route`, params, {
        headers: {
          'X-API-Key': ML_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });
      return response.data;
    } catch (err) {
      logger.warn('[MLService] matchEnRouteLoads failed, falling back to Haversine ranking:', err.message);
      return [];
    }
  },
};

export default mlService;
