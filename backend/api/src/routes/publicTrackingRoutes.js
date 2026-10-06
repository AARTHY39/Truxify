// backend/api/src/routes/publicTrackingRoutes.js
import express from 'express';
import { TrackingTokenService } from '../services/trackingTokenService.js';
import { supabaseAdmin, supabase } from '../config/db.js';
import logger from '../middleware/logger.js';

const router = express.Router();

// 🔒 CRITICAL FIX (#10131 / #8954): Public tracking share-links are unauthenticated.
// Passing supabaseAdmin ensures RLS-protected tables (tracking_tokens, orders, order_timeline)
// can be queried successfully without returning 0 rows (404).
const trackingTokenService = new TrackingTokenService({
  supabase: supabaseAdmin, // Use service-role client for public unauthenticated lookups
  supabaseAdmin,
  logger,
});

router.get('/tracking/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const result = await trackingTokenService.validateAndGetPublicTrackingData(token);

    if (!result.valid) {
      return res.status(404).json({ error: 'Tracking link not found or invalid', reason: result.reason });
    }

    return res.json(result.data);
  } catch (error) {
    logger.error({ err: error }, 'Error processing public tracking request');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
