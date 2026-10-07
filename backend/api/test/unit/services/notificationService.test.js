import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  sendPushNotification, 
  sendFcmNotification, 
  sendOtpNotification 
} from '../../../src/services/notificationService.js';

// Mock underlying firebase-admin or notification transport providers
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('projects/truxify/messages/mock-msg-id'),
    sendEachForMulticast: vi.fn().mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      responses: [{ success: true }, { success: true }],
    }),
  })),
}));

describe('NotificationService (Module Functions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendPushNotification', () => {
    it('successfully dispatches a single push notification with correct payload', async () => {
      const token = 'mock-fcm-token-123';
      const payload = {
        title: 'Shipment Dispatched',
        body: 'Your truck TN-01-AX-9821 is en route.',
        data: { shipmentId: 'SHP-9921' },
      };

      const result = await sendPushNotification(token, payload);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('projects/truxify/messages/mock-msg-id');
    });

    it('handles dispatch failure gracefully when token is invalid', async () => {
      // Test error propagation or fail-safe handling
      const invalidToken = '';
      const payload = { title: 'Test', body: 'Test' };

      await expect(sendPushNotification(invalidToken, payload)).rejects.toThrow();
    });
  });

  describe('sendFcmNotification (Multicast)', () => {
    it('dispatches bulk notifications across multiple devices successfully', async () => {
      const tokens = ['token-1', 'token-2'];
      const payload = {
        title: 'Toll Plaza Passed',
        body: 'Verified by WIM sensor.',
      };

      const result = await sendFcmNotification(tokens, payload);

      expect(result).toBeDefined();
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
    });
  });

  describe('sendOtpNotification', () => {
    it('formats and sends OTP verification codes securely', async () => {
      const phoneNumber = '+919876543210';
      const otpCode = '482910';

      const result = await sendOtpNotification(phoneNumber, otpCode);

      expect(result).toBeDefined();
      expect(result.delivered).toBe(true);
    });
  });
});
