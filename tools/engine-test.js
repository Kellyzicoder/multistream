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
