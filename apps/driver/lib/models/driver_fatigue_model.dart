class OcularTelemetry {
  final double blinkRatePerMinute;
  final double averageEyeClosureDurationMs; // Normal is ~100-150ms. Microsleep is >500ms.
  final double headNodAngleDegrees;
  final bool microsleepDetected;

  OcularTelemetry({
    required this.blinkRatePerMinute,
    required this.averageEyeClosureDurationMs,
    required this.headNodAngleDegrees,
    required this.microsleepDetected,
  });
}

class FatigueSession {
  final String driverId;
  final String status; // "Alert & Active", "Drowsiness Detected", "CRITICAL - MICROSLEEP ALARM"
  final double fatigueScore; // 0-100
  final String recommendedAction;
  final OcularTelemetry ocularData;

  FatigueSession({
    required this.driverId,
    required this.status,
    required this.fatigueScore,
    required this.recommendedAction,
    required this.ocularData,
  });
}

/// Live vision-pipeline metrics from the fatigue detection service (the
/// monitor screen's model; distinct from the older FatigueSession report).
class FatigueMetrics {
  final double eyeClosurePercentage; // 0.0 - 1.0
  final double blinkRatePerMinute;
  final int headNodsDetected;
  final bool isMicroSleepDetected;
  final String fatigueLevel; // "Awake", "Drowsy", "Critical"
  final DateTime timestamp;

  const FatigueMetrics({
    required this.eyeClosurePercentage,
    required this.blinkRatePerMinute,
    required this.headNodsDetected,
    required this.isMicroSleepDetected,
    required this.fatigueLevel,
    required this.timestamp,
  });
}
