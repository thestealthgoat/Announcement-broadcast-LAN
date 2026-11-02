import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProtocols, parseEncoders, parseAvfoundationDevices, parseDshowDevices } from '../server/live/probe.js';
import { feedArgs, inputArgs, classifyFailure, isSenderDisconnect, playlistSegments, senderAddress, ENCODERS } from '../server/live/ffmpeg-args.js';

// Captured from the bundled macOS build, which has no SRT but does list srtp.
const PROTOCOLS_NO_SRT = `Supported file protocols:
Input:
  async
  rtmp
  rtmps
  srtp
  tcp
Output:
  file
  rtmp
  srtp
  tee
`;

const ENCODERS_OUTPUT = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;

const AVFOUNDATION = `[AVFoundation indev @ 0x15480b0e0] AVFoundation video devices:
[AVFoundation indev @ 0x15480b0e0] [0] OBS Virtual Camera
[AVFoundation indev @ 0x15480b0e0] [1] Capture screen 0
[AVFoundation indev @ 0x15480b0e0] AVFoundation audio devices:
[AVFoundation indev @ 0x15480b0e0] [0] Mainstage to Ableton
[AVFoundation indev @ 0x15480b0e0] [1] BlackHole 16ch
[AVFoundation indev @ 0x15480b0e0] [2] Dante Virtual Soundcard
: Input/output error
`;

const DSHOW_NEW = `[dshow @ 000001e8a4c4f2c0] "Integrated Camera" (video)
[dshow @ 000001e8a4c4f2c0]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2&pid_b6d0"
[dshow @ 000001e8a4c4f2c0] "Decklink Video Capture" (video)
[dshow @ 000001e8a4c4f2c0]   Alternative name "@device_sw_{860BB310}"
[dshow @ 000001e8a4c4f2c0] "Microphone (Realtek Audio)" (audio)
[dshow @ 000001e8a4c4f2c0]   Alternative name "@device_cm_{33D9A762}"
[dshow @ 000001e8a4c4f2c0] "Magewell Combo" (audio, video)
dummy: Immediate exit requested
`;

const DSHOW_OLD = `[dshow @ 02cec400] DirectShow video devices (some may be both video and audio devices)
[dshow @ 02cec400]  "USB2.0 Camera"
[dshow @ 02cec400]     Alternative name "@device_pnp_\\\\?\\usb"
[dshow @ 02cec400] DirectShow audio devices
[dshow @ 02cec400]  "Line In (Realtek)"
[dshow @ 02cec400]     Alternative name "@device_cm_{33D9A762}"
`;

test('protocol parsing uses exact names, so srtp is not mistaken for srt', () => {
  const p = parseProtocols(PROTOCOLS_NO_SRT);
  assert.ok(p.input.includes('rtmp'));
  assert.ok(p.input.includes('srtp'));
  assert.ok(!p.input.includes('srt'));
  assert.ok(parseProtocols(PROTOCOLS_NO_SRT.replace('  tcp\n', '  srt\n  tcp\n')).input.includes('srt'));
});

test('encoder parsing reads names and skips the legend', () => {
  assert.deepEqual(parseEncoders(ENCODERS_OUTPUT), ['libx264', 'h264_videotoolbox', 'aac']);
});

test('AVFoundation devices parse, leaving out screens', () => {
  assert.deepEqual(parseAvfoundationDevices(AVFOUNDATION), {
    video: ['OBS Virtual Camera'],
    audio: ['Mainstage to Ableton', 'BlackHole 16ch', 'Dante Virtual Soundcard'],
  });
  assert.deepEqual(parseAvfoundationDevices('Unknown input format'), { video: [], audio: [] });
});

test('DirectShow devices parse in both output styles', () => {
  assert.deepEqual(parseDshowDevices(DSHOW_NEW), {
    video: ['Integrated Camera', 'Decklink Video Capture', 'Magewell Combo'],
    audio: ['Microphone (Realtek Audio)', 'Magewell Combo'],
  });
  assert.deepEqual(parseDshowDevices(DSHOW_OLD), { video: ['USB2.0 Camera'], audio: ['Line In (Realtek)'] });
});

test('listener and device inputs use the expected ffmpeg arguments', () => {
  assert.ok(inputArgs({ input: 'rtmp', port: 5000 }).join(' ').includes('-listen 1 -analyzeduration 1000000 -i rtmp://0.0.0.0:5000/live/feed'));
  assert.ok(inputArgs({ input: 'srt', port: 5001 }).includes('srt://0.0.0.0:5001?mode=listener'));
  const dshow = inputArgs({ input: 'device', device: 'Cam', audio_device: 'Mic' }, 'win32');
  assert.equal(dshow[dshow.indexOf('-f') + 1], 'dshow');
  assert.ok(dshow.includes('video=Cam:audio=Mic'));
  assert.ok(inputArgs({ input: 'device', device: 'Cam', audio_device: null }, 'win32').includes('video=Cam'));
  assert.ok(inputArgs({ input: 'device', device: 'Cam', audio_device: null }, 'darwin').includes('Cam:none'));
});

test('HLS output is H.264 with one-second segments, capped bitrate, and atomic playlists', () => {
  const args = feedArgs({ input: 'rtmp', port: 5000, max_bitrate: 6000 }, 'libx264', 'darwin').join(' ');
  assert.match(args, /-hls_time 1 /);
  assert.match(args, /-hls_list_size 6 /);
  assert.match(args, /-hls_flags delete_segments\+independent_segments\+omit_endlist\+temp_file/);
  assert.match(args, /-force_key_frames expr:gte\(t,n_forced\*1\)/);
  assert.match(args, /-maxrate 6000k/);
  assert.match(args, /min\(1920,iw\)/);
  assert.match(args, /format=yuv420p/);
  assert.match(args, /-map 0:a:0\?/, 'audio is optional');
  assert.match(args, /-c:a aac/);
  // Each hardware encoder must ask for a real keyframe at every forced point.
  assert.ok(ENCODERS.h264_nvenc.args(6000).includes('-forced-idr'));
  assert.ok(ENCODERS.h264_qsv.args(6000).includes('-forced_idr'));
});

test('ffmpeg failures become plain messages', () => {
  const rtmp = { input: 'rtmp', port: 5000 };
  const device = { input: 'device', device: 'Cam' };
  assert.equal(classifyFailure('rtmp://0.0.0.0:5000/live/feed: Address already in use', rtmp, 'libx264').kind, 'port');
  assert.match(classifyFailure('bind failed: Only one usage of each socket address', rtmp, 'libx264').message, /Port 5000/);
  assert.equal(classifyFailure('srt://0.0.0.0:1?mode=listener: Protocol not found', { input: 'srt', port: 1 }, 'libx264').kind, 'protocol');
  const camera = classifyFailure('[avfoundation @ 0x1] Failed to create AV capture input device: Application is not authorized to use camera', device, 'libx264');
  assert.equal(camera.kind, 'permission');
  assert.match(camera.message, /Privacy & Security/);
  assert.equal(classifyFailure('Cam:none: Input/output error', device, 'libx264').kind, 'device');
  assert.equal(classifyFailure('Could not find video device with name [Cam]', device, 'libx264').kind, 'device');
  assert.equal(classifyFailure('OpenEncodeSessionEx failed: out of memory', rtmp, 'h264_nvenc').kind, 'encoder');
  assert.equal(classifyFailure('Could not open encoder', rtmp, 'libx264'), null, 'no fallback past the software encoder');
  assert.equal(classifyFailure('rtmp://0.0.0.0:5000/live/feed: Input/output error', rtmp, 'libx264'), null, 'a sender leaving is not a failure');
});

test('a listener losing its sender is routine; a device stopping is not', () => {
  assert.equal(isSenderDisconnect({ input: 'rtmp', code: 0, sawInput: true, sawSegments: true, failure: null }), true);
  assert.equal(isSenderDisconnect({ input: 'srt', code: 1, sawInput: true, sawSegments: true, failure: null }), true);
  assert.equal(isSenderDisconnect({ input: 'rtmp', code: 0, sawInput: true, sawSegments: false, failure: null }), true);
  assert.equal(isSenderDisconnect({ input: 'rtmp', code: 1, sawInput: false, sawSegments: false, failure: null }), false);
  assert.equal(isSenderDisconnect({ input: 'rtmp', code: 1, sawInput: true, sawSegments: true, failure: { kind: 'disk' } }), false);
  assert.equal(isSenderDisconnect({ input: 'device', code: 0, sawInput: true, sawSegments: true, failure: null }), false);
});

test('sender addresses and playlist counting', () => {
  assert.deepEqual(senderAddress({ input: 'rtmp', port: 1935 }, '192.168.1.20'), {
    url: 'rtmp://192.168.1.20:1935/live', streamName: 'feed', full: 'rtmp://192.168.1.20:1935/live/feed',
  });
  assert.equal(senderAddress({ input: 'srt', port: 9000 }, '192.168.1.20').url, 'srt://192.168.1.20:9000?mode=caller');
  assert.equal(senderAddress({ input: 'device', device: 'Cam' }, 'x'), null);
  assert.equal(playlistSegments('#EXTM3U\n#EXTINF:1.0,\na.ts\n#EXTINF:1.0,\nb.ts\n'), 2);
  assert.equal(playlistSegments(''), 0);
});

test('the Live Feeds page says plainly who can send video, and the key is not presented as a credential', () => {
  const page = fs.readFileSync(new URL('../public/admin/views/live.js', import.meta.url), 'utf8');
  assert.match(page, /Anyone on the network who can reach a feed\\'s port can send video to this feed/);
  assert.match(page, /not a password/);
  assert.match(page, /separate network/);
  assert.doesNotMatch(page, /address\.key/);
  assert.doesNotMatch(page, /'Stream key: '/);
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Anyone on the network who can reach a feed's port can send video to this feed/);
  assert.match(readme, /separate network/);
});
