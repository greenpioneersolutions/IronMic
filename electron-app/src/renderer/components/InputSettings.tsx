/**
 * InputSettings — Microphone and audio input configuration page.
 * Shows device info, permission status, level meter, and test recording.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, RefreshCw, CheckCircle, AlertTriangle, XCircle, Volume2, Play, Square, Info } from 'lucide-react';
import { Card, Badge } from './ui';

interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

interface DeviceInfo {
  name: string | null;
  available: boolean;
  sampleRate: number;
  channels: number;
  sampleFormat: string | null;
}

export function InputSettings() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [currentDevice, setCurrentDevice] = useState<DeviceInfo | null>(null);
  const [micPermission, setMicPermission] = useState<string>('checking');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [deviceChangeNotice, setDeviceChangeNotice] = useState<string | null>(null);

  // Level meter state
  const [monitoring, setMonitoring] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const [silentForMs, setSilentForMs] = useState(0);
  const lastSpeechRef = useRef(Date.now());
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Test recording
  const [testRecording, setTestRecording] = useState(false);
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null);
  const [testPlaying, setTestPlaying] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // Build getUserMedia constraints using selected device
  const getAudioConstraints = useCallback((): MediaStreamConstraints => {
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (selectedDeviceId && selectedDeviceId !== 'default') {
      // Use ideal (not exact) — device IDs from cpal may not match Web Audio IDs
      audio.deviceId = { ideal: selectedDeviceId };
    }
    return { audio };
  }, [selectedDeviceId]);

  // Persist device selection to settings
  async function saveDeviceSelection(deviceId: string, deviceName: string) {
    try {
      await window.ironmic.setSetting('input_device_id', deviceId);
      await window.ironmic.setSetting('input_device_name', deviceName);
    } catch { /* settings may not be available */ }
  }

  // Handle user selecting a device
  function handleSelectDevice(device: AudioDevice) {
    setSelectedDeviceId(device.id);
    saveDeviceSelection(device.id, device.name);
    setDeviceChangeNotice(null);
    // Stop monitoring so it restarts with the new device
    if (monitoring) { stopMonitoring(); }
  }

  useEffect(() => {
    loadDeviceInfo();

    // Listen for device changes (plug/unplug, system default change)
    const handleDeviceChange = () => {
      console.log('[InputSettings] Audio devices changed');
      refreshDeviceList();
    };
    navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange);

    return () => {
      stopMonitoring();
      navigator.mediaDevices?.removeEventListener('devicechange', handleDeviceChange);
    };
  }, []);

  // Refresh just the device list (without full reload) — called on devicechange events
  async function refreshDeviceList() {
    try {
      const webDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = webDevices.filter(d => d.kind === 'audioinput');
      const deviceList: AudioDevice[] = audioInputs.map((d, i) => ({
        id: d.deviceId,
        name: d.label || `Microphone ${i + 1}`,
        isDefault: d.deviceId === 'default' || i === 0,
        sampleRate: 0,
        channels: 0,
      }));
      setDevices(deviceList);

      // Check if the selected device is still available
      if (selectedDeviceId && !deviceList.find(d => d.id === selectedDeviceId)) {
        const def = deviceList.find(d => d.isDefault) || deviceList[0];
        if (def) {
          setSelectedDeviceId(def.id);
          saveDeviceSelection(def.id, def.name);
          setDeviceChangeNotice(`Your selected mic was disconnected. Switched to "${def.name}".`);
          if (monitoring) { stopMonitoring(); }
        }
      }
    } catch { /* ignore */ }
  }

  async function loadDeviceInfo() {
    setRefreshing(true);
    try {
      // Get permission status + saved device preference
      const [perm, savedDeviceId, savedDeviceName] = await Promise.all([
        window.ironmic.checkMicPermission().catch(() => 'unknown'),
        window.ironmic.getSetting('input_device_id').catch(() => null),
        window.ironmic.getSetting('input_device_name').catch(() => null),
      ]);
      setMicPermission(perm);

      // Get native device info for current device details (sample rate, format)
      const deviceJson = await window.ironmic.getCurrentAudioDevice().catch(
        () => '{"name":null,"available":false,"sampleRate":0,"channels":0,"sampleFormat":null}'
      );
      setCurrentDevice(JSON.parse(deviceJson));

      // Get labeled device list from Web Audio API
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach(t => t.stop());
        setMicPermission('granted');
      } catch { /* permission denied or no mic */ }

      const webDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = webDevices.filter(d => d.kind === 'audioinput');
      const deviceList: AudioDevice[] = audioInputs.map((d, i) => ({
        id: d.deviceId,
        name: d.label || `Microphone ${i + 1}`,
        isDefault: d.deviceId === 'default' || i === 0,
        sampleRate: 0,
        channels: 0,
      }));
      setDevices(deviceList);

      // Restore saved selection, or fall back to default
      if (savedDeviceId && deviceList.find(d => d.id === savedDeviceId)) {
        setSelectedDeviceId(savedDeviceId);
      } else if (savedDeviceName) {
        // Device ID may have changed (browser regenerates them) — match by name
        const byName = deviceList.find(d => d.name === savedDeviceName);
        if (byName) {
          setSelectedDeviceId(byName.id);
          saveDeviceSelection(byName.id, byName.name); // Update stored ID
        } else {
          // Saved device not found — use default
          const def = deviceList.find(d => d.isDefault) || deviceList[0];
          if (def) setSelectedDeviceId(def.id);
        }
      } else {
        // No saved preference — use default
        const def = deviceList.find(d => d.isDefault) || deviceList[0];
        if (def) setSelectedDeviceId(def.id);
      }
    } catch (err) {
      console.error('[InputSettings] Failed to load device info:', err);
    }
    setRefreshing(false);
  }

  const startMonitoring = useCallback(async () => {
    try {
      // Stop any existing stream first
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(getAudioConstraints());
      } catch (constraintErr) {
        // If device constraint fails (OverconstrainedError), fall back to default device
        console.warn('[InputSettings] Device constraint failed, using default:', constraintErr);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      }
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;

      setMonitoring(true);
      setMicPermission('granted');
      lastSpeechRef.current = Date.now();
      setSilentForMs(0);

      // Start animation loop for level meter using time-domain (waveform) data
      const dataArray = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(dataArray);
        // Compute peak amplitude from waveform (128 = silence, 0/255 = max)
        let peak = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const amplitude = Math.abs(dataArray[i] - 128);
          if (amplitude > peak) peak = amplitude;
        }
        // Normalize to 0-1 and apply a gentle curve for better visual response
        const normalized = Math.min(1, (peak / 128) * 1.5);
        setAudioLevel(normalized);
        setPeakLevel(prev => Math.max(prev * 0.98, normalized));
        if (normalized > 0.02) {
          lastSpeechRef.current = Date.now();
        }
        setSilentForMs(Date.now() - lastSpeechRef.current);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setMicPermission('denied');
      } else {
        console.error('[InputSettings] Failed to start monitoring:', err);
      }
    }
  }, [getAudioConstraints]);

  const stopMonitoring = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setMonitoring(false);
    setAudioLevel(0);
    setPeakLevel(0);
  }, []);

  const startTestRecording = useCallback(async () => {
    // Clean up previous test
    if (testAudioUrl) {
      URL.revokeObjectURL(testAudioUrl);
      setTestAudioUrl(null);
    }

    try {
      let stream = streamRef.current;
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia(getAudioConstraints());
        streamRef.current = stream;
      }

      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        setTestAudioUrl(url);
        setTestRecording(false);
      };

      recorder.start();
      setTestRecording(true);

      // Auto-stop after 5 seconds
      setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      }, 5000);
    } catch (err) {
      console.error('[InputSettings] Test recording failed:', err);
      setTestRecording(false);
    }
  }, [testAudioUrl, getAudioConstraints]);

  const stopTestRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const playTestRecording = useCallback(() => {
    if (!testAudioUrl) return;
    const audio = new Audio(testAudioUrl);
    audioElRef.current = audio;
    setTestPlaying(true);
    audio.onended = () => setTestPlaying(false);
    audio.play();
  }, [testAudioUrl]);

  const stopPlayback = useCallback(() => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current = null;
    }
    setTestPlaying(false);
  }, []);

  const permissionIcon = micPermission === 'granted'
    ? <CheckCircle className="w-4 h-4 text-green-400" />
    : micPermission === 'denied' || micPermission === 'restricted'
    ? <XCircle className="w-4 h-4 text-red-400" />
    : micPermission === 'not-determined'
    ? <AlertTriangle className="w-4 h-4 text-amber-400" />
    : <div className="w-4 h-4 border-2 border-iron-accent border-t-transparent rounded-full animate-spin" />;

  const permissionLabel = micPermission === 'granted' ? 'Granted'
    : micPermission === 'denied' ? 'Denied'
    : micPermission === 'restricted' ? 'Restricted'
    : micPermission === 'not-determined' ? 'Not Yet Requested'
    : 'Checking...';

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-iron-text flex items-center gap-2">
            <Mic className="w-5 h-5 text-iron-text-muted" />
            Audio Input
          </h2>
          <p className="text-xs text-iron-text-muted mt-0.5">Microphone, permissions, and input testing</p>
        </div>
        <button
          onClick={loadDeviceInfo}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-[11px] text-iron-accent-light hover:underline"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Microphone Permission */}
      <Card variant={micPermission === 'denied' ? 'highlighted' : 'default'} padding="md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {permissionIcon}
            <div>
              <p className="text-sm font-medium text-iron-text">Microphone Permission</p>
              <p className="text-xs text-iron-text-muted mt-0.5">
                {micPermission === 'granted'
                  ? 'IronMic has access to your microphone'
                  : micPermission === 'denied'
                  ? 'Microphone access denied — go to System Settings > Privacy > Microphone to grant access'
                  : micPermission === 'not-determined'
                  ? 'Click "Test Mic" below to trigger the permission prompt'
                  : 'Checking microphone access...'}
              </p>
            </div>
          </div>
          <Badge variant={micPermission === 'granted' ? 'success' : micPermission === 'denied' ? 'danger' : 'default'}>
            {permissionLabel}
          </Badge>
        </div>
      </Card>

      {/* Current Device */}
      <Card variant="default" padding="md">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-iron-text-muted" />
            <p className="text-sm font-medium text-iron-text">Active Input Device</p>
          </div>
          {currentDevice?.available ? (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-iron-text-muted">Device</p>
                <p className="text-iron-text font-medium mt-0.5">{currentDevice.name}</p>
              </div>
              <div>
                <p className="text-iron-text-muted">Sample Rate</p>
                <p className="text-iron-text font-medium mt-0.5">{(currentDevice.sampleRate / 1000).toFixed(1)} kHz</p>
              </div>
              <div>
                <p className="text-iron-text-muted">Channels</p>
                <p className="text-iron-text font-medium mt-0.5">{currentDevice.channels === 1 ? 'Mono' : currentDevice.channels === 2 ? 'Stereo' : `${currentDevice.channels}ch`}</p>
              </div>
              <div>
                <p className="text-iron-text-muted">Format</p>
                <p className="text-iron-text font-medium mt-0.5">{currentDevice.sampleFormat || 'Auto'}</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-red-400">No input device detected. Check that a microphone is connected.</p>
          )}
        </div>
      </Card>

      {/* All Devices — click to select */}
      {devices.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-iron-text-muted uppercase tracking-wider">
            Input Devices ({devices.length})
          </p>
          {devices.map(d => {
            const isSelected = selectedDeviceId ? selectedDeviceId === d.id : d.isDefault;
            return (
              <button
                key={d.id}
                onClick={() => handleSelectDevice(d)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs border transition-all text-left ${
                  isSelected
                    ? 'bg-iron-accent/10 border-iron-accent/20 text-iron-accent-light'
                    : 'bg-iron-surface border-iron-border text-iron-text-secondary hover:border-iron-border-hover'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Mic className={`w-3 h-3 ${isSelected ? 'text-iron-accent-light' : ''}`} />
                  <span className="font-medium">{d.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  {d.sampleRate > 0 && (
                    <span className="text-[10px] text-iron-text-muted">
                      {(d.sampleRate / 1000).toFixed(0)}kHz · {d.channels}ch
                    </span>
                  )}
                  {isSelected && <Badge variant="accent">Selected</Badge>}
                  {!isSelected && d.isDefault && <span className="text-[10px] text-iron-text-muted">System Default</span>}
                </div>
              </button>
            );
          })}
          <p className="text-[10px] text-iron-text-muted flex items-center gap-1 mt-1">
            <Info className="w-3 h-3" />
            Your selection is saved and persists across restarts. IronMic auto-switches if your device disconnects.
          </p>
        </div>
      )}

      {/* Device change notice */}
      {deviceChangeNotice && (
        <Card variant="default" padding="md" className="border-amber-500/20 bg-amber-500/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <p className="text-xs text-amber-400">{deviceChangeNotice}</p>
            </div>
            <button onClick={() => setDeviceChangeNotice(null)} className="text-iron-text-muted hover:text-iron-text p-1">
              <span className="text-xs">Dismiss</span>
            </button>
          </div>
        </Card>
      )}

      {/* Level Meter & Test */}
      <Card variant="default" padding="md">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-iron-text">Microphone Test</p>
            <button
              onClick={monitoring ? stopMonitoring : startMonitoring}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                monitoring
                  ? 'bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25'
                  : 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20 hover:bg-iron-accent/25'
              }`}
            >
              {monitoring ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
              {monitoring ? 'Stop Monitor' : 'Start Monitor'}
            </button>
          </div>

          {/* Level meter bars */}
          <div className="space-y-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-iron-text-muted">
                <span>Level</span>
                <span>{monitoring ? `${(audioLevel * 100).toFixed(0)}%` : '—'}</span>
              </div>
              <div className="w-full h-4 bg-iron-surface-active rounded-md overflow-hidden relative">
                <div
                  className="h-full rounded-md"
                  style={{
                    width: `${Math.max(monitoring && audioLevel > 0.005 ? 2 : 0, audioLevel * 100)}%`,
                    background: audioLevel > 0.8
                      ? 'linear-gradient(90deg, #22c55e, #f59e0b, #ef4444)'
                      : audioLevel > 0.5
                      ? 'linear-gradient(90deg, #22c55e, #f59e0b)'
                      : '#22c55e',
                    transition: 'width 50ms ease-out',
                  }}
                />
                {/* Segmented meter overlay */}
                <div className="absolute inset-0 flex">
                  {Array.from({ length: 20 }).map((_, i) => (
                    <div key={i} className="flex-1 border-r border-iron-surface-active/50 last:border-r-0" />
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-iron-text-muted">
                <span>Peak Hold</span>
                <span>{monitoring ? `${(peakLevel * 100).toFixed(0)}%` : '—'}</span>
              </div>
              <div className="w-full h-2 bg-iron-surface-active rounded-sm overflow-hidden">
                <div
                  className="h-full rounded-sm"
                  style={{
                    width: `${Math.max(monitoring && peakLevel > 0.005 ? 2 : 0, peakLevel * 100)}%`,
                    background: '#6366f1',
                    transition: 'width 100ms ease-out',
                  }}
                />
              </div>
            </div>
          </div>

          {monitoring && silentForMs > 5000 && (
            <p className="text-[11px] text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" />
              No audio detected. Check that your microphone is not muted.
            </p>
          )}

          {/* Test recording */}
          <div className="pt-2 border-t border-iron-border/50 space-y-2">
            <p className="text-xs text-iron-text-muted">
              Record a short clip (up to 5 seconds) and play it back to verify audio quality.
            </p>
            <div className="flex items-center gap-2">
              {!testRecording ? (
                <button
                  onClick={startTestRecording}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-all"
                >
                  <Mic className="w-3 h-3" />
                  Record Test Clip
                </button>
              ) : (
                <button
                  onClick={stopTestRecording}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500/15 text-red-400 rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-all"
                >
                  <Square className="w-3 h-3" />
                  Stop Recording
                </button>
              )}
              {testAudioUrl && !testRecording && (
                testPlaying ? (
                  <button
                    onClick={stopPlayback}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-surface text-iron-text-secondary rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-all"
                  >
                    <Square className="w-3 h-3" />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={playTestRecording}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-surface text-iron-text-secondary rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-all"
                  >
                    <Play className="w-3 h-3" />
                    Play Back
                  </button>
                )
              )}
            </div>
            {testRecording && (
              <p className="text-[11px] text-red-400 animate-pulse flex items-center gap-1.5">
                <Mic className="w-3 h-3" />
                Recording... (auto-stops in 5s)
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Tips */}
      <Card variant="default" padding="md">
        <div className="flex items-start gap-2.5">
          <Info className="w-4 h-4 text-iron-text-muted flex-shrink-0 mt-0.5" />
          <div className="text-xs text-iron-text-muted leading-relaxed space-y-1.5">
            <p><strong className="text-iron-text">For best transcription quality:</strong></p>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              <li>Use a dedicated microphone or headset rather than built-in laptop mic</li>
              <li>Keep the level meter in the green zone (30-70%) — too quiet loses words, too loud distorts</li>
              <li>Reduce background noise where possible</li>
              <li>Speak at a normal pace, about 12 inches from the mic</li>
              <li>The test clip plays back exactly what IronMic hears — if it sounds clear, transcription will be accurate</li>
            </ul>
          </div>
        </div>
      </Card>
    </>
  );
}
