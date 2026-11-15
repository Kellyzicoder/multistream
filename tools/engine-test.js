// Checks that the OBS engine (obs-studio-node) loads inside this app's Electron.
// Run: npx electron tools/engine-test.js   (nothing in the app changes)
const { app } = require('electron');
const path = require('path');

const out = (...a) => console.log('[engine]', ...a);

app.whenReady().then(() => {
  out('electron', process.versions.electron, 'node', process.versions.node, 'abi', process.versions.modules, process.platform, process.arch);
  let osn;
  try {
    osn = require('obs-studio-node');
    out('engine loaded');
  } catch (e) {
    out('LOAD FAILED:', e.message);
    app.quit();
    return;
  }

  out('top-level:', Object.keys(osn).join(', '));
  out('NodeObs:', Object.keys(osn.NodeObs || {}).join(', '));

  try {
    const hosted = osn.NodeObs.IPC.host('multistream-engine-test-' + process.pid);
    out('engine process:', hosted, hosted === 0 ? '(OK)' : '(problem)');
    osn.NodeObs.SetWorkingDirectory(path.join(__dirname, '..', 'node_modules', 'obs-studio-node'));
    const dataDir = path.join(app.getPath('userData'), 'engine-test');
    const result = osn.NodeObs.OBS_API_initAPI({ language: 'en-US', appDataPath: dataDir, version: '1.0.0', crashServerUrl: '' });
    out('start result:', result, result === 0 ? '(OK)' : '(problem)');

    if (result === 0) {
      const camKinds = process.platform === 'darwin' ? ['macos-avcapture', 'av_capture_input'] : ['dshow_input'];
      for (const kind of camKinds) {
        try {
          const cam = osn.InputFactory.create(kind, 'camera-test', {});
          const prop = cam.properties.get(process.platform === 'darwin' ? 'device' : 'video_device_id');
          const names = prop && prop.details ? prop.details.items.map((i) => i.name) : [];
          out('camera type ' + kind + ' works; cameras:', names.join(' | ') || 'none');
          cam.release();
        } catch (e) {
          out('camera type ' + kind + ' not available:', e.message);
        }
      }
      try {
        const scene = osn.SceneFactory.create('engine-test-scene');
        const color = osn.InputFactory.create('color_source', 'engine-test-colour', { color: 0xff1e80f0, width: 1920, height: 1080 });
        scene.add(color);
        osn.Global.setOutputSource(0, scene);
        out('scene with a colour source: OK');
      } catch (e) {
        out('scene test failed:', e.message);
      }
      try {
        const types = osn.InputFactory.types ? osn.InputFactory.types() : [];
        out('source types:', types.join(', '));
      } catch (e) {}
      // the Studio's scenes built in the engine (engine-scenes.js), the way the app does it
      try {
        const scenes = require('../engine-scenes');
        const video = osn.VideoFactory.create();
        video.video = {
          fpsNum: 30, fpsDen: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080,
          outputFormat: 2, colorspace: 2, range: 1, scaleType: 3, fpsType: 2,
        };
        scenes.init(osn);
        const pic = path.join(__dirname, '..', 'build', 'icon.png');
        const data = {
          w: 1920, h: 1080, current: 'One', trans: { type: 'fade', ms: 300 },
          scenes: [
            { name: 'One', layers: [
              { id: 'a', type: 'color', color: '#3b6cff', x: 0, y: 0, w: 1920, h: 1080, fit: 'stretch' },
              { id: 'b', type: 'image', path: pic, x: 100, y: 100, w: 400, h: 400, fit: 'fit', rot: 15 },
              { id: 'c', type: 'screen', screenIndex: 0, x: 960, y: 0, w: 960, h: 540, fit: 'fit' },
              { id: 'd', type: 'camera', label: '', x: 0, y: 540, w: 960, h: 540, fit: 'cover', flipH: true },
              { id: 'e', type: 'text', text: 'Hello' },
            ] },
            { name: 'Two', layers: [{ id: 'f', type: 'color', color: '#fb923c', x: 0, y: 0, w: 1920, h: 1080 }] },
          ],
        };
        out('scenes: first build, remake preview =', scenes.sync(data, video), 'program:', scenes.programName());
        data.scenes[0].layers[1].x = 300; // a move only
        out('scenes: a move, remake preview =', scenes.sync(data, video));
        data.current = 'Two';
        out('scenes: other scene on air (fade) =', scenes.sync(data, video));
        data.trans = { type: 'cut', ms: 0 };
        out('scenes: cut transition, remake preview =', scenes.sync(data, video));
        data.w = 1080; data.h = 1920; data.trans = { type: 'slide', ms: 500 };
        out('scenes: tall picture + slide, remake preview =', scenes.sync(data, video));
        data.scenes[0].layers.splice(2, 2);
        out('scenes: screen and camera removed =', scenes.sync(data, video));
        scenes.refresh();
        scenes.clear();
        video.destroy();
        out('scenes test: OK');
      } catch (e) {
        out('scenes test failed:', e.message, e.stack);
      }
    }
  } catch (e) {
    out('ERROR:', e.message);
  }

  try {
    if (osn.NodeObs.OBS_service_removeCallback) osn.NodeObs.OBS_service_removeCallback();
    if (osn.NodeObs.IPC && osn.NodeObs.IPC.disconnect) osn.NodeObs.IPC.disconnect();
  } catch (e) {}
  setTimeout(() => app.quit(), 500);
});
