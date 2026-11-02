// Pure helpers for live feeds: the ffmpeg command line, and what its errors mean.

const RATE = (kbps) => ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`];

// In preference order. Each option list is also what the probe test-encodes with,
// so an encoder that rejects any of these flags counts as unavailable.
export const ENCODERS = {
  h264_nvenc: {
    label: 'NVIDIA graphics card (NVENC)',
    format: 'yuv420p',
    args: (kbps) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-forced-idr', '1', '-bf', '0', '-profile:v', 'high', ...RATE(kbps)],
  },
  h264_qsv: {
    label: 'Intel graphics (Quick Sync)',
    format: 'nv12',
    args: (kbps) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-forced_idr', '1', '-look_ahead', '0', '-bf', '0', '-profile:v', 'high', ...RATE(kbps)],
  },
  h264_videotoolbox: {
    label: 'Apple hardware (VideoToolbox)',
    format: 'yuv420p',
    args: (kbps) => ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-allow_sw', '0', '-bf', '0', '-profile:v', 'high', ...RATE(kbps)],
  },
  libx264: {
    label: 'Software (x264)',
    format: 'yuv420p',
    args: (kbps) => ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-sc_threshold', '0', '-profile:v', 'high', '-level', '4.2', ...RATE(kbps)],
  },
};

export const SEGMENT_SECONDS = 1;
// Fixed, and not a secret: ffmpeg's RTMP listener has no way to check it and accepts any name.
export const RTMP_STREAM_NAME = 'feed';
export const PLAYLIST = 'index.m3u8';

// Never upscales: only sources bigger than 1080p are reduced.
function videoOutput(encoder, kbps) {
  const { format, args } = ENCODERS[encoder];
  return [
    '-vf', `scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=${format}`,
    '-fpsmax', '60',
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    ...args(kbps),
  ];
}

export function encoderTestArgs(encoder) {
  return ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=0.5', ...videoOutput(encoder, 2000), '-f', 'null', '-'];
}

export function inputArgs(feed, platform = process.platform) {
  if (feed.input === 'rtmp') return ['-listen', '1', '-analyzeduration', '1000000', '-i', `rtmp://0.0.0.0:${feed.port}/live/${RTMP_STREAM_NAME}`];
  if (feed.input === 'srt') return ['-analyzeduration', '1000000', '-i', `srt://0.0.0.0:${feed.port}?mode=listener`];
  if (platform === 'win32') {
    const audio = feed.audio_device ? `:audio=${feed.audio_device}` : '';
    return ['-f', 'dshow', '-rtbufsize', '256M', '-thread_queue_size', '1024', '-i', `video=${feed.device}${audio}`];
  }
  return ['-f', 'avfoundation', '-thread_queue_size', '1024', '-framerate', '30', '-i', `${feed.device}:${feed.audio_device || 'none'}`];
}

// File names are relative because ffmpeg runs in the feed's folder. A data folder
// path may contain spaces or a %, which the segment pattern would misread.
export function feedArgs(feed, encoder, platform = process.platform) {
  return [
    '-hide_banner', '-nostdin', '-nostats', '-y',
    ...inputArgs(feed, platform),
    '-map', '0:v:0', '-map', '0:a:0?',
    ...videoOutput(encoder, feed.max_bitrate),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist+temp_file',
    '-hls_start_number_source', 'epoch', // keeps rising across a sender's reconnects
    '-hls_segment_filename', 'seg-%d.ts',
    PLAYLIST,
  ];
}

// Turns the end of ffmpeg's output into something an admin can act on, or null if
// nothing in it is a known problem. `fatal` means the admin should see it right away.
export function classifyFailure(text, feed, encoder) {
  const t = String(text ?? '');
  if (/Address already in use|bind failed|Only one usage of each socket address|WSAEADDRINUSE/i.test(t)) {
    return { kind: 'port', fatal: true, message: `Port ${feed.port} is being used by another program on this computer. Choose a different port or close that program.` };
  }
  if (/Protocol not found/i.test(t)) {
    return { kind: 'protocol', fatal: true, message: `This computer's copy of ffmpeg cannot receive ${String(feed.input).toUpperCase()}. Choose a different input type.` };
  }
  if (/No space left on device/i.test(t)) {
    return { kind: 'disk', fatal: true, message: 'The host computer is out of disk space.' };
  }
  if (feed.input === 'device') {
    if (/not authori[sz]ed|not permitted|permission|denied/i.test(t)) {
      return { kind: 'permission', fatal: true, message: 'This computer has not allowed the app to use the camera. On a Mac, open System Settings > Privacy & Security > Camera, turn on Network Signage, then restart the app.' };
    }
    if (/not supported by the device/i.test(t)) {
      return { kind: 'device', fatal: true, message: 'This capture device does not support the video format that was requested.' };
    }
    if (/Could not (find|run|enumerate)|No such (file|device)|I\/O error|Input\/output error|Error opening input|Video device not found|Failed to create AV capture/i.test(t)) {
      return { kind: 'device', fatal: true, message: 'Could not open this capture device. Check that it is connected and not in use by another program.' };
    }
  }
  if (encoder && encoder !== 'libx264' && /Error initializing output stream|Could not open encoder|Error while opening encoder|OpenEncodeSession|No NVENC capable|nvenc.*(failed|error)|Error creating a MFX session|Error initializing the encoder|Error during encoding/i.test(t)) {
    return { kind: 'encoder', fatal: false, message: 'The hardware encoder stopped working.' };
  }
  return null;
}

// Listener ffmpegs exit when the sender disconnects. That is routine, not a failure:
// it must go back to listening with no backoff and no error shown.
export function isSenderDisconnect({ input, code, sawInput, sawSegments, failure }) {
  if (input === 'device' || failure) return false;
  return sawSegments || (sawInput && code === 0);
}

export function playlistSegments(text) {
  return String(text ?? '').split('\n').filter((l) => l.startsWith('#EXTINF')).length;
}

// What to paste into vMix or OBS.
export function senderAddress(feed, host) {
  if (feed.input === 'rtmp') {
    const url = `rtmp://${host}:${feed.port}/live`;
    return { url, streamName: RTMP_STREAM_NAME, full: `${url}/${RTMP_STREAM_NAME}` };
  }
  if (feed.input === 'srt') return { url: `srt://${host}:${feed.port}?mode=caller`, host, port: feed.port };
  return null;
}
