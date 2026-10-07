import 'dart:typed_data';
import 'voice_recording_stub.dart'
    if (dart.library.html) 'voice_recording_web.dart';

class VoiceRecordingService {
  /// Requests microphone permission from the operating system or browser.
  static Future<bool> requestPermission() async {
    return await platformRequestPermission();
  }

  /// Starts recording audio streams and emitting binary chunks.
  static Future<void> startRecording({
    required Function(Uint8List chunk) onDataChunk,
  }) async {
    await platformStartRecording(onDataChunk: onDataChunk);
  }

  /// Stops audio recording and releases hardware streams.
  static Future<void> stopRecording() async {
    await platformStopRecording();
  }
}
