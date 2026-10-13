import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { getOptions } from '../config';
import ResultView from '../result-view';
import { installWebviewStubs, loadWebviewModule } from './webview-harness';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json');
const APP_JS_PATH = path.join(__dirname, '..', '..', 'src', 'result-view', 'htmlContent', 'js', 'app.js');

suite('Query completion sound / audio cues', () => {
  suite('package.json contribution declarations', () => {
    const props = pkg.contributes.configuration.properties;

    test('declares firebird.query.playCompletionSound with default false', () => {
      const prop = props['firebird.query.playCompletionSound'];
      assert.ok(prop, 'property firebird.query.playCompletionSound must be declared');
      assert.strictEqual(prop.type, 'boolean');
      assert.strictEqual(prop.default, false);
      assert.ok(prop.markdownDescription.includes('mssql.query.playCompletionSound'));
    });

    test('declares firebird.query.completionSoundFile with default empty string', () => {
      const prop = props['firebird.query.completionSoundFile'];
      assert.ok(prop, 'property firebird.query.completionSoundFile must be declared');
      assert.strictEqual(prop.type, 'string');
      assert.strictEqual(prop.default, '');
      assert.ok(prop.markdownDescription.includes('mssql.query.completionSoundFile'));
    });
  });

  suite('getOptions() configuration parsing', () => {
    test('defaults playCompletionSound to false and completionSoundFile to empty', () => {
      const opts = getOptions();
      assert.strictEqual(opts.playCompletionSound, false);
      assert.strictEqual(opts.completionSoundFile, '');
    });

    test('reads custom playCompletionSound and completionSoundFile overrides', () => {
      const orig = vscode.workspace.getConfiguration;
      try {
        (vscode.workspace as any).getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'query.playCompletionSound') { return true; }
            if (key === 'query.completionSoundFile') { return '/path/to/custom-bell.wav'; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });

        const opts = getOptions();
        assert.strictEqual(opts.playCompletionSound, true);
        assert.strictEqual(opts.completionSoundFile, '/path/to/custom-bell.wav');
      } finally {
        (vscode.workspace as any).getConfiguration = orig;
      }
    });
  });

  suite('ResultView.triggerCompletionSound()', () => {
    let resultView: ResultView;

    setup(() => {
      resultView = new ResultView(__dirname);
    });

    teardown(() => {
      resultView.dispose();
    });

    test('does nothing when firebird.query.playCompletionSound is false', () => {
      let sentMessage: any = null;
      let cuePlayed: any = null;
      const origCue = (vscode.window as any).playAudioCue;
      (vscode.window as any).playAudioCue = (cue: any) => { cuePlayed = cue; };
      (resultView as any).send = (msg: any) => { sentMessage = msg; };

      try {
        resultView.triggerCompletionSound(false);
        assert.strictEqual(sentMessage, null);
        assert.strictEqual(cuePlayed, null);
      } finally {
        (vscode.window as any).playAudioCue = origCue;
      }
    });

    test('triggers audio cue and sends completion message when enabled', () => {
      const origConfig = vscode.workspace.getConfiguration;
      const origCue = (vscode.window as any).playAudioCue;
      let cuePlayed: any = null;
      let sentMessage: any = null;

      try {
        (vscode.workspace as any).getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'query.playCompletionSound') { return true; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        (vscode.window as any).playAudioCue = (cue: any) => { cuePlayed = cue; };
        (resultView as any).panel = { webview: { postMessage: () => Promise.resolve(true) } };
        (resultView as any).send = (msg: any) => { sentMessage = msg; };

        // Success run
        resultView.triggerCompletionSound(false);
        assert.strictEqual(cuePlayed, 'taskCompleted');
        assert.deepStrictEqual(sentMessage, {
          command: 'playCompletionSound',
          data: { hasError: false, soundFileData: undefined }
        });

        // Error run
        sentMessage = null;
        resultView.triggerCompletionSound(true);
        assert.strictEqual(cuePlayed, 'error');
        assert.deepStrictEqual(sentMessage, {
          command: 'playCompletionSound',
          data: { hasError: true, soundFileData: undefined }
        });
      } finally {
        (vscode.workspace as any).getConfiguration = origConfig;
        (vscode.window as any).playAudioCue = origCue;
      }
    });

    test('reads custom sound file as base64 data URI when specified', () => {
      const tmpDir = os.tmpdir();
      const testWavPath = path.join(tmpDir, `test-chime-${Date.now()}.wav`);
      fs.writeFileSync(testWavPath, Buffer.from([0x52, 0x49, 0x46, 0x46])); // RIFF header snippet

      const origConfig = vscode.workspace.getConfiguration;
      let sentMessage: any = null;

      try {
        (vscode.workspace as any).getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'query.playCompletionSound') { return true; }
            if (key === 'query.completionSoundFile') { return testWavPath; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        (resultView as any).panel = { webview: { postMessage: () => Promise.resolve(true) } };
        (resultView as any).send = (msg: any) => { sentMessage = msg; };

        resultView.triggerCompletionSound(false);
        assert.ok(sentMessage);
        assert.strictEqual(sentMessage.command, 'playCompletionSound');
        assert.strictEqual(sentMessage.data.hasError, false);
        assert.ok(sentMessage.data.soundFileData?.startsWith('data:audio/wav;base64,'));
      } finally {
        (vscode.workspace as any).getConfiguration = origConfig;
        try { fs.unlinkSync(testWavPath); } catch { /* ignore */ }
      }
    });

    test('queues sound notification if webview is not yet instantiated', async () => {
      const origConfig = vscode.workspace.getConfiguration;
      const sentMessages: any[] = [];

      try {
        (vscode.workspace as any).getConfiguration = () => ({
          get: (key: string, def?: any) => {
            if (key === 'query.playCompletionSound') { return true; }
            return def;
          },
          has: () => true,
          inspect: () => undefined,
          update: () => Promise.resolve(),
        });
        (resultView as any).panel = undefined;
        (resultView as any).view = undefined;
        (resultView as any).send = (msg: any) => { sentMessages.push(msg); };

        resultView.triggerCompletionSound(false);
        assert.strictEqual(sentMessages.length, 0);
        assert.deepStrictEqual((resultView as any).pendingCompletionSound, {
          hasError: false,
          soundFileData: undefined
        });

        // Trigger sendData simulation
        await (resultView as any).sendData();
        const soundMsg = sentMessages.find(m => m.command === 'playCompletionSound');
        assert.ok(soundMsg, 'pendingCompletionSound must be dispatched on sendData');
        assert.strictEqual((resultView as any).pendingCompletionSound, undefined);
      } finally {
        (vscode.workspace as any).getConfiguration = origConfig;
      }
    });
  });

  suite('Webview chime synthesis and playback (app.js)', () => {
    let hooks: any;
    let restore: () => void;

    suiteSetup(() => {
      restore = installWebviewStubs();
      hooks = loadWebviewModule(APP_JS_PATH).__test__;
    });

    suiteTeardown(() => {
      restore();
    });

    test('playSyntheticChime is exported and handles missing AudioContext safely', () => {
      assert.strictEqual(typeof hooks.playSyntheticChime, 'function');
      const res = hooks.playSyntheticChime(false);
      assert.strictEqual(res, false, 'should return false gracefully when no AudioContext is in environment');
    });

    test('playSyntheticChime constructs oscillators with expected frequencies when AudioContext exists', () => {
      const oscillators: Array<{ type: string; frequency: number; startTime: number; stopTime: number }> = [];
      const gains: Array<{ initialGain: number; targetGain: number }> = [];

      class MockOscillator {
        type = '';
        frequency = {
          val: 0,
          setValueAtTime: (val: number, _t: number) => { this.frequency.val = val; }
        };
        _start = 0;
        _stop = 0;
        connect() { /* ignore */ }
        start(t: number) { this._start = t; }
        stop(t: number) {
          this._stop = t;
          oscillators.push({
            type: this.type,
            frequency: this.frequency.val,
            startTime: this._start,
            stopTime: this._stop
          });
        }
      }

      class MockGain {
        gain = {
          val: 0,
          target: 0,
          setValueAtTime: (val: number, _t: number) => { this.gain.val = val; },
          exponentialRampToValueAtTime: (val: number, _t: number) => {
            this.gain.target = val;
            gains.push({ initialGain: this.gain.val, targetGain: this.gain.target });
          }
        };
        connect() { /* ignore */ }
      }

      class MockAudioContext {
        currentTime = 1.0;
        destination = {};
        createOscillator() { return new MockOscillator(); }
        createGain() { return new MockGain(); }
        close() { /* ignore */ }
      }

      const win = (global as any).window || {};
      try {
        win.AudioContext = MockAudioContext;

        // Success chime: D5 (587.33) -> A5 (880)
        oscillators.length = 0;
        gains.length = 0;
        const resSuccess = hooks.playSyntheticChime(false);
        assert.strictEqual(resSuccess, true);
        assert.strictEqual(oscillators.length, 2);
        assert.strictEqual(oscillators[0].frequency, 587.33);
        assert.strictEqual(oscillators[1].frequency, 880);

        // Error chime: A4 (440) -> E4 (329.63)
        oscillators.length = 0;
        gains.length = 0;
        const resError = hooks.playSyntheticChime(true);
        assert.strictEqual(resError, true);
        assert.strictEqual(oscillators.length, 2);
        assert.strictEqual(oscillators[0].frequency, 440);
        assert.strictEqual(oscillators[1].frequency, 329.63);
      } finally {
        delete win.AudioContext;
      }
    });

    test('playCompletionChime plays custom audio when data URI is passed', () => {
      let createdAudioSrc = '';
      let playCalled = false;

      class MockAudio {
        src: string;
        volume = 0;
        constructor(src: string) {
          this.src = src;
          createdAudioSrc = src;
        }
        play() {
          playCalled = true;
          return Promise.resolve();
        }
      }

      const win = (global as any).window || {};
      try {
        win.Audio = MockAudio;
        const handled = hooks.playCompletionChime(false, 'data:audio/wav;base64,AAA');
        assert.strictEqual(handled, true);
        assert.strictEqual(createdAudioSrc, 'data:audio/wav;base64,AAA');
        assert.strictEqual(playCalled, true);
      } finally {
        delete win.Audio;
      }
    });
  });
});
