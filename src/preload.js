const { contextBridge, ipcRenderer, webFrame } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = channel => cb => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  env: () => call('env:get'),
  getSettings: () => call('settings:get'),
  setSettings: patch => call('settings:set', patch),
  pickFolder: title => call('dialog:folder', title),
  pickFile: (title, filters) => call('dialog:file', title, filters),
  listDemos: () => call('demos:list'),
  analyze: (file, steamid) => call('demo:analyze', file, steamid),
  stats: file => call('demo:stats', file),
  radarMaps: () => call('radar:maps'),
  replay: file => call('demo:replay', file),
  integrity: file => call('demo:integrity', file),
  onIntegrityProgress: on('integrity:progress'),
  watchDemo: (file, opts) => call('demo:watch', file, opts),
  heat: (file, steamid, scope) => call('demo:heat', file, steamid, scope),
  profile: () => call('profile:get'),
  mapHeat: (map, who) => call('map:heat', map, who),
  getZoom: () => webFrame.getZoomFactor(),
  setZoom: f => webFrame.setZoomFactor(f),
  renameDemo: (file, name) => call('demo:rename', file, name),
  record: (items, steamid) => call('record:start', items, steamid),
  cancelRecord: () => call('record:cancel'),
  listClips: () => call('clips:list'),
  deleteClip: id => call('clips:delete', id),
  reveal: file => call('shell:reveal', file),
  open: file => call('shell:open', file),
  montage: (ids, name) => call('montage:make', ids, name),
  listDownloads: () => call('downloads:list'),
  checkDownloads: () => call('downloads:check'),
  download: id => call('downloads:get', id),
  communitySignIn: () => call('community:signIn'),
  communitySignOut: () => call('community:signOut'),
  onDownloads: on('downloads:update'),
  hlaeCheck: () => call('hlae:check'),
  hlaeUpdate: () => call('hlae:update'),
  onHlaeUpdate: on('hlae:update-available'),
  onRecord: on('record:update'),
  onMontage: on('montage:update'),
  fileUrl: p => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:'),
});
